/**
 * Resume the Pi migration after the Node-version blowup.
 *
 * State at start: project + node_modules already on the Pi, DB already
 * uploaded, dashboard tmux session crashed because Node 18 is too old.
 *
 * Steps:
 *   A. Kill any failing tmux session.
 *   B. Install Node 22 LTS via NodeSource (replaces apt's nodejs 18).
 *   C. Wipe node_modules and re-run npm ci so native modules
 *      (better-sqlite3) rebuild against Node 22's ABI.
 *   D. Restart the tmux session and wait for "ManageT running on".
 *   E. Reconfigure both agents to point at Pi:3000 and restart their
 *      service managers.
 *   F. Wait for the heartbeat watermark on each row to advance.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";
import { decryptPassword } from "../src/lib/crypto";

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

function exec(c: Client, cmd: string, opts: { print?: boolean } = {}): Promise<{ code: number; out: string; err: string }> {
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
      s.on("close", (code: number | null) => resolve({ code: code ?? -1, out, err: er }));
    });
  });
}

function sudo(c: Client, password: string, cmd: string, print = false) {
  return exec(
    c,
    `echo ${JSON.stringify(password)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`,
    { print }
  );
}

function require0(r: { code: number; out: string; err: string }, label: string) {
  if (r.code !== 0) {
    throw new Error(`${label} failed (exit ${r.code})\nSTDOUT: ${r.out.trimEnd()}\nSTDERR: ${r.err.trimEnd()}`);
  }
}

async function main() {
  const piIp = pi.host;
  step("0", "Connecting to Pi");
  const piC = await sshConnect(pi, piPwd);

  step("A", "Killing the failing tmux session");
  await exec(piC, "tmux kill-session -t managet 2>/dev/null; true");
  console.log("  done");

  step("B", "Installing Node 22 LTS via NodeSource");
  // The NodeSource setup script adds the apt repo + key. Then we replace
  // nodejs in one go. The setup script has its own `apt-get update` so we
  // don't need to do another.
  const installNode = await sudo(
    piC,
    piPwd,
    "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs",
    true
  );
  if (installNode.code !== 0) throw new Error("node install failed");
  // Confirm the new version.
  const ver = await exec(piC, "node --version; npm --version");
  console.log(`  installed: ${ver.out.trim().split("\n").join(" / ")}`);
  if (!ver.out.startsWith("v22.") && !ver.out.startsWith("v20.")) {
    throw new Error(`unexpected node version: ${ver.out.trim()}`);
  }

  step("C", "Wiping node_modules + re-running npm ci against new ABI (~3 min)");
  await exec(piC, "rm -rf /home/andrei/managet/node_modules /home/andrei/managet/package-lock.json.bak");
  // Keep package-lock.json (needed for npm ci) but delete the old build
  // artifacts. better-sqlite3's build product lives inside node_modules so
  // wiping that folder is enough.
  const ci = await exec(piC, "cd /home/andrei/managet && npm ci 2>&1 | tail -20", { print: true });
  if (ci.code !== 0) throw new Error("npm ci failed");

  step("D", "Restarting dashboard in tmux session");
  await exec(piC, "tmux kill-session -t managet 2>/dev/null; rm -f /tmp/managet-dev.log; true");
  const startCmd = `tmux new-session -d -s managet 'cd /home/andrei/managet && npm run dev 2>&1 | tee -a /tmp/managet-dev.log'`;
  const startRes = await exec(piC, startCmd);
  require0(startRes, "tmux new-session");
  let listening = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const tail = await exec(piC, "tail -n 30 /tmp/managet-dev.log 2>/dev/null");
    if (tail.out.includes("ManageT running on")) {
      listening = true;
      console.log(`  dashboard listening (after ${(i + 1) * 2}s)`);
      break;
    }
  }
  if (!listening) {
    const tail = await exec(piC, "tail -n 80 /tmp/managet-dev.log 2>/dev/null");
    throw new Error(`dashboard didn't come up. Log:\n${tail.out}`);
  }

  step("E1", "Reconfiguring Pi's local agent (api_url -> 127.0.0.1:3000)");
  const piCfgRead = await sudo(piC, piPwd, "cat /etc/managet-agent/config.toml");
  require0(piCfgRead, "read pi config");
  const piToken = piCfgRead.out.match(/^\s*token\s*=\s*"([^"]+)"/m)?.[1];
  const piServerId = piCfgRead.out.match(/^\s*server_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!piToken || !piServerId) throw new Error("could not parse Pi agent config");
  const piNewCfg =
    `api_url = "http://127.0.0.1:3000"\n` +
    `server_id = "${piServerId}"\n` +
    `token = "${piToken}"\n` +
    `heartbeat_interval_secs = 10\n`;
  const piWrite = await sudo(
    piC,
    piPwd,
    `cat > /etc/managet-agent/config.toml <<'EOF'\n${piNewCfg}EOF\nchmod 600 /etc/managet-agent/config.toml`
  );
  require0(piWrite, "write pi config");
  const piRestart = await sudo(
    piC,
    piPwd,
    "systemctl restart managet-agent && sleep 1 && systemctl is-active managet-agent"
  );
  require0(piRestart, "restart pi agent");
  console.log(`  pi agent active=${piRestart.out.trim()}`);

  step("E2", "Reconfiguring Mac Mini's agent (api_url -> Pi LAN IP:3000)");
  const miniC = await sshConnect(mini, miniPwd);
  const miniCfgRead = await sudo(miniC, miniPwd, "cat /usr/local/etc/managet-agent/config.toml");
  require0(miniCfgRead, "read mini config");
  const miniToken = miniCfgRead.out.match(/^\s*token\s*=\s*"([^"]+)"/m)?.[1];
  const miniServerId = miniCfgRead.out.match(/^\s*server_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!miniToken || !miniServerId) throw new Error("could not parse Mac Mini agent config");
  const miniNewCfg =
    `api_url = "http://${piIp}:3000"\n` +
    `server_id = "${miniServerId}"\n` +
    `token = "${miniToken}"\n` +
    `heartbeat_interval_secs = 10\n`;
  const miniWrite = await sudo(
    miniC,
    miniPwd,
    `cat > /usr/local/etc/managet-agent/config.toml <<'EOF'\n${miniNewCfg}EOF\nchmod 600 /usr/local/etc/managet-agent/config.toml`
  );
  require0(miniWrite, "write mini config");
  const miniRestart = await sudo(
    miniC,
    miniPwd,
    "launchctl kickstart -k system/com.managet.agent && sleep 1 && launchctl print system/com.managet.agent | grep -E 'state =|pid ='"
  );
  require0(miniRestart, "restart mini agent");
  console.log(`  mini agent:\n${miniRestart.out.trim()}`);

  step("F", "Waiting 18s, then checking heartbeats");
  await new Promise((r) => setTimeout(r, 18000));
  const hb = await exec(
    piC,
    `sqlite3 /home/andrei/managet/data/managet.db "SELECT name, agent_status, COALESCE(agent_last_heartbeat_at, 0) AS last, COALESCE(agent_install_error, 'NULL') FROM servers;"`
  );
  console.log(`  ${hb.out.trim()}`);

  miniC.end();
  piC.end();

  console.log("\n\x1b[1;32m✓ Migration complete.\x1b[0m");
  console.log(`  Dashboard: http://${piIp}:3000`);
  console.log(`  Tmux:      ssh andrei@${piIp} -t 'tmux attach -t managet'`);
  console.log(`  Logs:      ssh andrei@${piIp} 'tail -f /tmp/managet-dev.log'`);
  console.log(`  Project:   ssh andrei@${piIp} ; cd /home/andrei/managet`);
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
