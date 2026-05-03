/**
 * One-shot diagnostic script for the managet-agent on a remote server.
 *
 * Usage:  npx tsx scripts/diagnose-agent.ts <serverId>
 *
 * Connects via SSH using the credentials stored in the dashboard DB and
 * dumps:
 *   - launchd / systemd state
 *   - config.toml contents
 *   - recent agent logs
 *   - outbound connectivity to the dashboard URL
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";
import { decryptPassword } from "../src/lib/crypto";

// Manually source .env.local so MANAGET_ENCRYPTION_KEY is available — Next.js
// loads it automatically during `next dev`, but a tsx script runs without that
// machinery.
const envPath = ".env.local";
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const serverId = process.argv[2];
if (!serverId) {
  console.error("Usage: npx tsx scripts/diagnose-agent.ts <serverId>");
  process.exit(1);
}

const db = new Database("data/managet.db", { readonly: true });
const row = db
  .prepare(
    "SELECT id, name, host, port, username, auth_method, password_encrypted, private_key_path FROM servers WHERE id = ?"
  )
  .get(serverId) as
  | {
      id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      auth_method: string;
      password_encrypted: string | null;
      private_key_path: string | null;
    }
  | undefined;

if (!row) {
  console.error(`server ${serverId} not found`);
  process.exit(1);
}

console.log(`# Diagnosing agent on ${row.name} (${row.host}:${row.port}) as ${row.username}`);

const client = new Client();

const connectConfig: Parameters<Client["connect"]>[0] = {
  host: row.host,
  port: row.port,
  username: row.username,
  readyTimeout: 20000,
};

if (row.auth_method === "password" && row.password_encrypted) {
  connectConfig.password = decryptPassword(row.password_encrypted);
} else if (row.auth_method === "key" && row.private_key_path) {
  connectConfig.privateKey = readFileSync(row.private_key_path);
} else {
  console.error("missing credentials");
  process.exit(1);
}

function exec(cmd: string, stdin?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      let er = "";
      if (stdin !== undefined) {
        stream.write(stdin);
        stream.end();
      }
      stream.on("data", (d: Buffer) => (out += d.toString("utf8")));
      stream.stderr.on("data", (d: Buffer) => (er += d.toString("utf8")));
      stream.on("close", (code: number | null) => resolve({ code: code ?? -1, out, err: er }));
    });
  });
}

async function section(title: string, cmd: string, stdin?: string): Promise<void> {
  console.log(`\n=== ${title} ===`);
  console.log(`$ ${cmd}`);
  try {
    const r = await exec(cmd, stdin);
    if (r.out.trim()) console.log(r.out.trimEnd());
    if (r.err.trim()) console.log(`STDERR: ${r.err.trimEnd()}`);
    console.log(`(exit ${r.code})`);
  } catch (e) {
    console.log(`ERROR: ${(e as Error).message}`);
  }
}

client.on("ready", async () => {
  // The dashboard install path uses sudo -S with the SSH password piped to
  // stdin. Mirror that so we can read root-only files like config.toml and
  // launchd unified logs.
  const sudoPwd = row.password_encrypted ? decryptPassword(row.password_encrypted) : "";
  const sudo = (cmd: string) => exec(`sudo -S -p '' bash -c ${shesc(cmd)}`, `${sudoPwd}\n`);

  console.log(`\n=== ssh session basics ===`);
  const basics = await exec("uname -sm; whoami; id; echo SSH_CLIENT=$SSH_CLIENT");
  console.log(basics.out.trimEnd());

  console.log(`\n=== launchd: is the unit registered? ===`);
  const printed = await sudo("launchctl print system/com.managet.agent 2>&1 | head -80");
  console.log(printed.out.trimEnd() || "(no output)");
  console.log(`(exit ${printed.code})`);

  console.log(`\n=== service file on disk ===`);
  const lsPlist = await sudo("ls -la /Library/LaunchDaemons/com.managet.agent.plist; echo ---; cat /Library/LaunchDaemons/com.managet.agent.plist 2>/dev/null");
  console.log(lsPlist.out.trimEnd() || "(no output)");

  console.log(`\n=== binary on disk ===`);
  const lsBin = await sudo("ls -la /usr/local/bin/managet-agent; file /usr/local/bin/managet-agent");
  console.log(lsBin.out.trimEnd() || "(no output)");

  console.log(`\n=== config.toml ===`);
  const cfgCat = await sudo("ls -la /usr/local/etc/managet-agent/config.toml; cat /usr/local/etc/managet-agent/config.toml");
  console.log(cfgCat.out.trimEnd() || "(no output)");

  console.log(`\n=== recent agent log lines (unified log) ===`);
  const logShow = await sudo(`log show --last 10m --predicate 'process == "managet-agent"' 2>&1 | tail -60`);
  console.log(logShow.out.trimEnd() || "(no output)");

  console.log(`\n=== try running 'status' subcommand directly ===`);
  const direct = await sudo("/usr/local/bin/managet-agent status 2>&1");
  console.log(direct.out.trimEnd() || "(no output)");
  console.log(`(exit ${direct.code})`);

  console.log(`\n=== reachability of dashboard candidate IPs ===`);
  for (const ip of ["192.168.0.124", "192.168.100.97"]) {
    const r = await exec(
      `curl -sS -o /dev/null -m 5 -w 'HTTP %{http_code} (connect=%{time_connect}s)\\n' http://${ip}:3000/ ; echo done`
    );
    console.log(`  ${ip}: ${r.out.trim()}`);
  }

  console.log(`\n=== outbound: can the target curl the dashboard at the configured api_url? ===`);
  const cfgRaw = cfgCat.out;
  const apiUrlMatch = cfgRaw.match(/api_url\s*=\s*"([^"]+)"/);
  const tokenMatch = cfgRaw.match(/^\s*token\s*=\s*"([^"]+)"/m);
  const apiUrl = apiUrlMatch ? apiUrlMatch[1] : null;
  const tok = tokenMatch ? tokenMatch[1] : null;
  if (apiUrl && tok) {
    const probe = await exec(
      `curl -v -fsS -m 8 -X POST -H 'Authorization: Bearer ${tok}' -H 'Content-Type: application/json' -d '{}' ${apiUrl.replace(/\/$/, "")}/api/agent/validate-token 2>&1`
    );
    console.log(probe.out.trimEnd());
    console.log(`(exit ${probe.code})`);
  } else {
    console.log("(could not parse api_url / token from config.toml)");
  }

  client.end();
});

client.on("error", (err) => {
  console.error(`ssh error: ${err.message}`);
  process.exit(1);
});

client.connect(connectConfig);

function shesc(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
