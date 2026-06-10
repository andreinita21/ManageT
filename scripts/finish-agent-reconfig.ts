/**
 * Finish what migrate-pi-resume left undone: rewrite the agents' config.toml
 * files and restart their service managers.
 *
 * Last attempt died on quoting the heredoc through nested bash -c '<JSON>'.
 * This time we SFTP the new config to a tmp file in the user's home, then
 * sudo-mv it into place. No shell quoting required.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";
import { decryptPassword } from "../src/lib/crypto";
import { requireEnv } from "./_creds.js";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const PI_ID = "98ec98f1-5157-40b5-bb46-07f5b13948c0";
const MINI_ID = "cfab293b-8571-4422-b57e-dca44c1f6b79";

const db = new Database("data/managet.db", { readonly: true });
type ServerRow = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
};
const pi = db
  .prepare("SELECT id, name, host, port, username, password_encrypted FROM servers WHERE id = ?")
  .get(PI_ID) as ServerRow;
const mini = db
  .prepare("SELECT id, name, host, port, username, password_encrypted FROM servers WHERE id = ?")
  .get(MINI_ID) as ServerRow;
db.close();
const piPwd = decryptPassword(pi.password_encrypted);
const miniPwd = decryptPassword(mini.password_encrypted);

function step(n: string, msg: string) {
  console.log(`\n\x1b[1;36m[${n}] ${msg}\x1b[0m`);
}

function sshConnect(row: ServerRow, password: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({
      host: row.host,
      port: row.port,
      username: row.username,
      password,
      readyTimeout: 30000,
    });
  });
}

function exec(c: Client, cmd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, s) => {
      if (err) return reject(err);
      let out = "";
      let er = "";
      s.on("data", (d: Buffer) => (out += d.toString()));
      s.stderr.on("data", (d: Buffer) => (er += d.toString()));
      s.on("close", (code: number | null) => resolve({ code: code ?? -1, out, err: er }));
    });
  });
}

function sudo(c: Client, password: string, cmd: string) {
  return exec(c, `echo ${JSON.stringify(password)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`);
}

function sftpPutBuffer(c: Client, buf: Buffer, remote: string, mode = 0o600): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remote, { mode });
      ws.on("close", () => resolve());
      ws.on("error", reject);
      ws.end(buf);
    });
  });
}

function require0(r: { code: number; out: string; err: string }, label: string) {
  if (r.code !== 0) {
    throw new Error(`${label} failed (exit ${r.code})\nSTDOUT: ${r.out.trimEnd()}\nSTDERR: ${r.err.trimEnd()}`);
  }
}

/**
 * Read the existing config to recover server_id and token, write a new
 * config to /tmp, then sudo-mv it into place with chmod 600.
 *
 * If the file is empty / unparseable (the previous botched heredoc-via-
 * `bash -c '<JSON>'` truncated the Pi's config to 0 bytes), the caller
 * may pass `fallback` with the values to use. The token must match what
 * was already there or `agent_token_hash` in the dashboard DB won't
 * authenticate it.
 */
async function rewriteConfig(
  c: Client,
  password: string,
  remoteCfgPath: string,
  apiUrl: string,
  fallback?: { serverId: string; token: string }
): Promise<void> {
  const read = await sudo(c, password, `cat ${remoteCfgPath}`);
  require0(read, `read ${remoteCfgPath}`);
  let token = read.out.match(/^\s*token\s*=\s*"([^"]+)"/m)?.[1];
  let serverId = read.out.match(/^\s*server_id\s*=\s*"([^"]+)"/m)?.[1];
  if ((!token || !serverId) && fallback) {
    token = fallback.token;
    serverId = fallback.serverId;
    console.log(`  (using fallback token+server_id — config was unparseable)`);
  }
  if (!token || !serverId) throw new Error(`could not parse ${remoteCfgPath}`);
  const cfg =
    `api_url = "${apiUrl}"\n` +
    `server_id = "${serverId}"\n` +
    `token = "${token}"\n` +
    `heartbeat_interval_secs = 10\n`;
  const tmpPath = `/tmp/managet-agent-config-${process.pid}-${Date.now()}.toml`;
  await sftpPutBuffer(c, Buffer.from(cfg, "utf8"), tmpPath, 0o600);
  // Move into place with root ownership + 600 mode. Use cp/chown/chmod
  // separately because `install -g root` fails on macOS where the root
  // group is `wheel`. cp preserves no metadata, then we set explicitly.
  const mv = await sudo(
    c,
    password,
    `cp ${tmpPath} ${remoteCfgPath} && chown 0:0 ${remoteCfgPath} && chmod 600 ${remoteCfgPath} && rm -f ${tmpPath}`
  );
  require0(mv, `install ${remoteCfgPath}`);
}

async function main() {
  const piIp = pi.host;
  step("0", "Connecting");
  const piC = await sshConnect(pi, piPwd);
  const miniC = await sshConnect(mini, miniPwd);

  step("1", "Pi agent: rewrite config + restart systemd unit");
  // The Pi's agent token must match the dashboard's agent_token_hash
  // (sha256 of the plaintext). Pass it via the environment rather than
  // hardcoding it — committed tokens leak into git history forever.
  await rewriteConfig(piC, piPwd, "/etc/managet-agent/config.toml", "http://127.0.0.1:3000", {
    serverId: PI_ID,
    token: requireEnv(
      "MANAGET_PI_AGENT_TOKEN",
      "The Pi's agent token (matching its agent_token_hash in the DB)."
    ),
  });
  const piRestart = await sudo(
    piC,
    piPwd,
    "systemctl restart managet-agent && sleep 1 && systemctl is-active managet-agent && systemctl status managet-agent --no-pager | head -5"
  );
  require0(piRestart, "restart pi agent");
  console.log(`  ${piRestart.out.trim()}`);

  step("2", "Mac Mini agent: rewrite config + kickstart launchd unit");
  await rewriteConfig(
    miniC,
    miniPwd,
    "/usr/local/etc/managet-agent/config.toml",
    `http://${piIp}:3000`
  );
  const miniRestart = await sudo(
    miniC,
    miniPwd,
    "launchctl kickstart -k system/com.managet.agent && sleep 1 && launchctl print system/com.managet.agent | grep -E 'state =|pid =|last exit'"
  );
  require0(miniRestart, "restart mini agent");
  console.log(`  ${miniRestart.out.trim()}`);

  step("3", "Wait 18s, then check heartbeats in Pi DB");
  await new Promise((r) => setTimeout(r, 18000));
  const hb = await exec(
    piC,
    `sqlite3 /home/andrei/managet/data/managet.db "SELECT name, agent_status, COALESCE(agent_last_heartbeat_at, 0) AS last_hb_ms, COALESCE(agent_install_error, 'NULL') AS err FROM servers;"`
  );
  console.log(`  ${hb.out.trim()}`);
  // Compute "seconds since heartbeat" for clarity.
  const now = Date.now();
  const lines = hb.out.trim().split("\n");
  for (const l of lines) {
    const parts = l.split("|");
    if (parts.length >= 3) {
      const name = parts[0];
      const status = parts[1];
      const last = parseInt(parts[2], 10);
      if (last > 0) {
        const ago = Math.round((now - last) / 1000);
        console.log(`  ${name}: status=${status}, last heartbeat ${ago}s ago ${ago < 30 ? "✓" : "✗"}`);
      } else {
        console.log(`  ${name}: status=${status}, NO heartbeat yet`);
      }
    }
  }

  step("4", "Tail dashboard log for any errors");
  const tail = await exec(piC, "tail -n 25 /tmp/managet-dev.log");
  console.log(tail.out.trim());

  miniC.end();
  piC.end();

  console.log(`\n\x1b[1;32m✓ Done.\x1b[0m  Open http://${piIp}:3000`);
}

main().catch((e) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(e as Error).message}`);
  process.exit(1);
});
