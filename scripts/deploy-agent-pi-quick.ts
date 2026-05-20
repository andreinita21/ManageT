/**
 * Quick redeploy of the prebuilt aarch64-musl managet-agent + managet
 * binaries to the Pi (192.168.100.82). Used to push the rename op
 * without going through a Pi-side cargo build.
 *
 *   npx tsx scripts/deploy-agent-pi-quick.ts
 *
 * Looks up the Pi by name in the servers table, decrypts the stored
 * password, scp's the new binaries, stops/replaces/starts the agent
 * service, runs a smoke test (`managet-agent ls`).
 *
 * Mac Mini is left alone — the aarch64-darwin binary needs a Mac
 * build, which can't be done from this Linux dev box.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";

import { decryptPassword } from "../src/lib/crypto";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PI_NAME = "markI (Pi)";
const AGENT_BIN =
  "data/agent-binaries/aarch64-unknown-linux-musl/managet-agent";
const CLI_BIN = "data/agent-binaries/aarch64-unknown-linux-musl/managet";

const db = new Database("data/managet.db", { readonly: true });
type Row = { id: string; host: string; port: number; username: string; password_encrypted: string };
const row = db
  .prepare(
    "SELECT id, host, port, username, password_encrypted FROM servers WHERE name = ?"
  )
  .get(PI_NAME) as Row | undefined;
db.close();
if (!row) throw new Error(`Server '${PI_NAME}' not found in DB`);
const password = decryptPassword(row.password_encrypted);

console.log(
  `target: ${row.username}@${row.host}:${row.port}   (server_id ${row.id})`
);

function step(n: string, msg: string) {
  console.log(`\n\x1b[1;36m[${n}] ${msg}\x1b[0m`);
}

function sshConnect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({
      host: row!.host,
      port: row!.port,
      username: row!.username,
      password,
      readyTimeout: 30000,
    });
  });
}

function exec(
  c: Client,
  cmd: string,
  opts: { print?: boolean } = {}
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, s) => {
      if (err) return reject(err);
      let out = "";
      let er = "";
      s.on("data", (d: Buffer) => {
        const t = d.toString();
        out += t;
        if (opts.print) process.stdout.write(t);
      });
      s.stderr.on("data", (d: Buffer) => {
        const t = d.toString();
        er += t;
        if (opts.print) process.stderr.write(t);
      });
      s.on("close", (code: number | null) =>
        resolve({ code: code ?? -1, out, err: er })
      );
    });
  });
}

function sudo(c: Client, cmd: string) {
  return exec(
    c,
    `echo ${JSON.stringify(password)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`
  );
}

function sftpPut(c: Client, local: string, remote: string): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, (e) => (e ? reject(e) : resolve()));
    });
  });
}

function require0(
  r: { code: number; out: string; err: string },
  label: string
) {
  if (r.code !== 0) {
    throw new Error(
      `${label} failed (exit ${r.code})\nSTDOUT: ${r.out.trimEnd()}\nSTDERR: ${r.err.trimEnd()}`
    );
  }
}

async function main() {
  for (const f of [AGENT_BIN, CLI_BIN]) {
    if (!existsSync(f)) throw new Error(`missing ${f} — run build first`);
    console.log(`  ${f} (${(statSync(f).size / 1024).toFixed(1)} KB)`);
  }

  step("1", "Connecting to Pi");
  const c = await sshConnect();

  step("2", "Uploading new binaries to /tmp");
  await sftpPut(c, AGENT_BIN, "/tmp/managet-agent.new");
  await sftpPut(c, CLI_BIN, "/tmp/managet.new");

  step("3", "Stopping managet-agent");
  const stop = await sudo(c, "systemctl stop managet-agent");
  require0(stop, "stop service");

  step("4", "Installing binaries at /usr/local/bin/");
  const install = await sudo(
    c,
    "install -m 755 /tmp/managet-agent.new /usr/local/bin/managet-agent && " +
      "install -m 755 /tmp/managet.new /usr/local/bin/managet && " +
      "rm -f /tmp/managet-agent.new /tmp/managet.new && " +
      "/usr/local/bin/managet-agent --help 2>&1 | head -3"
  );
  require0(install, "install");
  console.log(`  ${install.out.trim()}`);

  step("5", "Starting managet-agent");
  const start = await sudo(
    c,
    "systemctl start managet-agent && sleep 2 && systemctl is-active managet-agent"
  );
  require0(start, "start service");
  console.log(`  service: ${start.out.trim()}`);

  step("6", "Smoke test (managet ls)");
  const ls = await exec(c, "/usr/local/bin/managet ls 2>&1");
  console.log(`  $ managet ls\n${ls.out.split("\n").map((l) => `    ${l}`).join("\n")}`);
  if (ls.code !== 0) throw new Error("managet ls failed");

  c.end();
  console.log("\n\x1b[1;32m✓ Pi agent updated.\x1b[0m");
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
