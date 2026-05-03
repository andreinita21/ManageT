/**
 * One-shot migration of the managet project from this laptop to the Pi.
 *
 *   Usage: npx tsx scripts/migrate-to-pi.ts
 *
 * Steps:
 *   1. Pi: install build-essential + sqlite3 (needed by better-sqlite3 native build).
 *   2. Pi: stop and remove the Excalidraw stack so port 3000 is free.
 *   3. Local: build a source tarball (no node_modules / .next / agent/target).
 *   4. Upload tarball to Pi, extract into ~/managet.
 *   5. Pi: write a fresh .env.local with PORT=3000 + MANAGET_DASHBOARD_URL=Pi LAN IP.
 *   6. Pi: npm ci (this is the long step, ~3 min on a Pi).
 *   7. Stop the laptop dashboard so the SQLite WAL is clean.
 *   8. Upload data/managet.db to ~/managet/data/managet.db.
 *   9. Pi: start `npm run dev` inside a tmux session named "managet".
 *  10. Pi: rewrite the local agent's config.toml to api_url=http://127.0.0.1:3000
 *      and restart its systemd unit.
 *  11. Mac Mini: rewrite the local agent's config.toml to api_url=Pi LAN IP:3000
 *      and restart its launchd unit.
 *  12. Wait ~15s and check both servers' agent_last_heartbeat_at on the Pi DB.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
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
const TARBALL = "/tmp/managet-src.tar.gz";
const PI_REMOTE_TARBALL = "/tmp/managet-src.tar.gz";

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
  .prepare(
    "SELECT id, name, host, port, username, password_encrypted FROM servers WHERE id = ?"
  )
  .get(PI_ID) as ServerRow;
const mini = db
  .prepare(
    "SELECT id, name, host, port, username, password_encrypted FROM servers WHERE id = ?"
  )
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

function exec(
  c: Client,
  cmd: string,
  opts: { stdin?: string; print?: boolean } = {}
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, s) => {
      if (err) return reject(err);
      let out = "";
      let er = "";
      if (opts.stdin !== undefined) {
        s.write(opts.stdin);
        s.end();
      }
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
  // Echo password into sudo -S; -p '' silences the prompt so the password
  // doesn't appear on stdout. Wrap the inner command in `bash -c '...'` so
  // shell features (pipes, redirects) work and exit codes propagate.
  return exec(
    c,
    `echo ${JSON.stringify(password)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`,
    { print }
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

function sftpPutBuffer(c: Client, buf: Buffer, remote: string, mode = 0o644): Promise<void> {
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

function localExec(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

function require0(r: { code: number; out: string; err: string }, label: string) {
  if (r.code !== 0) {
    throw new Error(
      `${label} failed (exit ${r.code})\nSTDOUT: ${r.out.trimEnd()}\nSTDERR: ${r.err.trimEnd()}`
    );
  }
}

async function main() {
  step("0", "Connecting to Pi via SSH");
  const piC = await sshConnect(pi, piPwd);
  const piIp = pi.host;
  console.log(`  connected to ${pi.name} @ ${piIp}`);

  step("1", "Installing build-essential + sqlite3 on Pi (apt may take a minute)");
  const apt = await sudo(
    piC,
    piPwd,
    "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential sqlite3 python3-minimal"
  );
  if (apt.code !== 0) {
    console.log(`  apt warning (exit ${apt.code}):`);
    console.log(`  STDOUT: ${apt.out.trimEnd()}`);
    console.log(`  STDERR: ${apt.err.trimEnd()}`);
    if (!apt.out.includes("Unable to") && !apt.err.includes("Unable to")) {
      // tolerate non-zero from apt warnings; only bail on hard failure
    } else {
      throw new Error("apt install failed");
    }
  } else {
    console.log("  done");
  }

  step("2", "Stopping & removing Excalidraw (containers, images, source dir)");
  // docker compose down: stops + removes containers and the compose network.
  const down = await sudo(piC, piPwd, "cd /home/andrei/excalidraw && docker compose down -v");
  console.log(`  compose down (exit ${down.code}): ${down.out.trimEnd().split("\n").slice(-2).join(" | ")}`);
  // Remove the locally-built images. -f forces removal even if untagged
  // children exist. Best-effort; ignore failures if images already gone.
  await sudo(
    piC,
    piPwd,
    "docker rmi -f excalidraw-excalidraw excalidraw-excalidraw-room 2>/dev/null; true"
  );
  // Remove the source dir.
  const rmSrc = await sudo(piC, piPwd, "rm -rf /home/andrei/excalidraw");
  require0(rmSrc, "rm ~/excalidraw");
  // Verify port 3000 is free now.
  const portCheck = await sudo(
    piC,
    piPwd,
    "ss -ltn 'sport = :3000' | tail -n +2 | head -3"
  );
  if (portCheck.out.trim()) {
    throw new Error(
      `something still on port 3000 after Excalidraw teardown:\n${portCheck.out}`
    );
  }
  console.log("  port 3000 is free");

  step("3", "Building source tarball (no node_modules / .next / agent/target)");
  const tarRes = await localExec("tar", [
    "--exclude=./node_modules",
    "--exclude=./.next",
    "--exclude=./agent/target",
    "--exclude=./data/agent-binaries",
    "--exclude=./data/agent-source",
    "--exclude=./data/managet.db", // copied separately after dashboard shutdown
    "--exclude=./data/managet.db.pre-agent-migration.bak",
    "--exclude=./tsconfig.tsbuildinfo",
    "--exclude=./managet-debug-agent.json",
    "-czf",
    TARBALL,
    ".",
  ]);
  if (tarRes.code !== 0) throw new Error("tar failed: " + tarRes.out);
  const tarSize = statSync(TARBALL).size;
  console.log(`  tarball: ${TARBALL} (${(tarSize / 1024).toFixed(1)} KB)`);

  step("4", "Uploading tarball + extracting into /home/andrei/managet");
  await exec(piC, "rm -rf /home/andrei/managet && mkdir -p /home/andrei/managet");
  await sftpPut(piC, TARBALL, PI_REMOTE_TARBALL);
  const extract = await exec(
    piC,
    `tar -xzf ${PI_REMOTE_TARBALL} -C /home/andrei/managet && rm ${PI_REMOTE_TARBALL}`
  );
  require0(extract, "extract tarball");
  console.log("  extracted");

  step("5", "Writing /home/andrei/managet/.env.local (port 3000 + dashboard URL)");
  const envText =
    `DATABASE_URL=file:./data/managet.db\n` +
    `NEXTAUTH_SECRET=${process.env.NEXTAUTH_SECRET ?? "managet-dev-secret-change-in-production"}\n` +
    `NEXTAUTH_URL=http://${piIp}:3000\n` +
    `MANAGET_ENCRYPTION_KEY=${process.env.MANAGET_ENCRYPTION_KEY}\n` +
    `MANAGET_DASHBOARD_URL=http://${piIp}:3000\n` +
    `PORT=3000\n`;
  await sftpPutBuffer(piC, Buffer.from(envText, "utf8"), "/home/andrei/managet/.env.local", 0o600);
  console.log("  written");

  step("6", "Running npm ci on Pi (this is the long step, ~3 min)");
  const ci = await exec(piC, "cd /home/andrei/managet && npm ci 2>&1 | tail -15", { print: true });
  if (ci.code !== 0) throw new Error("npm ci failed");

  step("7", "Stopping the dashboard on the laptop (so DB snapshot is clean)");
  const find = await localExec("sh", [
    "-c",
    "pgrep -f 'npx tsx server.ts' || pgrep -f 'tsx server.ts' || true",
  ]);
  const pids = find.out
    .trim()
    .split("\n")
    .filter((p) => p && /^\d+$/.test(p));
  if (pids.length === 0) {
    console.log("  no laptop dashboard process found — skipping");
  } else {
    console.log(`  killing PIDs: ${pids.join(", ")}`);
    await localExec("kill", pids);
    // give it 2s to flush, then verify
    await new Promise((r) => setTimeout(r, 2000));
    const stillUp = await localExec("sh", [
      "-c",
      "lsof -nP -iTCP:3000 -sTCP:LISTEN 2>/dev/null | tail -n +2",
    ]);
    if (stillUp.out.trim()) {
      console.log(`  WARN: something still on :3000 locally:\n${stillUp.out.trimEnd()}`);
    } else {
      console.log("  laptop dashboard stopped");
    }
  }

  step("8", "Copying data/managet.db to Pi");
  // Checkpoint the WAL so the file copy is consistent. The dashboard is now
  // stopped, so it's safe to do this from the same connection.
  await localExec("sqlite3", ["data/managet.db", "PRAGMA wal_checkpoint(TRUNCATE);"]);
  await exec(piC, "mkdir -p /home/andrei/managet/data");
  await sftpPut(piC, "data/managet.db", "/home/andrei/managet/data/managet.db");
  console.log("  uploaded");

  step("9", "Starting dashboard in tmux session 'managet' on Pi");
  // Kill any stale tmux session of the same name first.
  await exec(piC, "tmux kill-session -t managet 2>/dev/null; true");
  // -d = detached. The full command goes through `bash -lc` so .nvm / asdf
  // etc. are sourced if present (not required here, but doesn't hurt).
  const startCmd = `tmux new-session -d -s managet 'cd /home/andrei/managet && npm run dev 2>&1 | tee -a /tmp/managet-dev.log'`;
  const startRes = await exec(piC, startCmd);
  require0(startRes, "tmux new-session");
  console.log("  tmux session started; tailing log for 18s");
  // Poll for the listen line.
  let listening = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const tail = await exec(piC, "tail -n 30 /tmp/managet-dev.log 2>/dev/null");
    if (tail.out.includes("ManageT running on")) {
      listening = true;
      console.log(`  dashboard listening`);
      break;
    }
    if (tail.out.includes("Error") || tail.out.includes("error")) {
      console.log(`  log so far:\n${tail.out.trimEnd()}`);
    }
  }
  if (!listening) {
    const tail = await exec(piC, "tail -n 60 /tmp/managet-dev.log 2>/dev/null");
    throw new Error(`dashboard didn't come up in 24s. Log:\n${tail.out}`);
  }

  step("10", "Reconfiguring Pi's local agent (api_url -> 127.0.0.1:3000)");
  // Read existing config to preserve server_id + token + interval.
  const piCfgRead = await sudo(piC, piPwd, "cat /etc/managet-agent/config.toml");
  require0(piCfgRead, "read pi config");
  const piCfg = piCfgRead.out;
  const piToken = piCfg.match(/^\s*token\s*=\s*"([^"]+)"/m)?.[1];
  const piServerId = piCfg.match(/^\s*server_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!piToken || !piServerId) throw new Error("could not parse Pi agent config");
  const piNewCfg =
    `api_url = "http://127.0.0.1:3000"\n` +
    `server_id = "${piServerId}"\n` +
    `token = "${piToken}"\n` +
    `heartbeat_interval_secs = 10\n`;
  // tee through sudo to write the root-owned file in one step.
  const piWrite = await sudo(
    piC,
    piPwd,
    `cat > /etc/managet-agent/config.toml <<'EOF'\n${piNewCfg}EOF\nchmod 600 /etc/managet-agent/config.toml`
  );
  require0(piWrite, "write pi config");
  const piRestart = await sudo(piC, piPwd, "systemctl restart managet-agent && sleep 1 && systemctl is-active managet-agent");
  require0(piRestart, "restart pi agent");
  console.log(`  pi agent restarted (state: ${piRestart.out.trim()})`);

  step("11", "Reconfiguring Mac Mini's agent (api_url -> Pi LAN IP:3000)");
  const miniC = await sshConnect(mini, miniPwd);
  const miniCfgRead = await sudo(miniC, miniPwd, "cat /usr/local/etc/managet-agent/config.toml");
  require0(miniCfgRead, "read mini config");
  const miniCfg = miniCfgRead.out;
  const miniToken = miniCfg.match(/^\s*token\s*=\s*"([^"]+)"/m)?.[1];
  const miniServerId = miniCfg.match(/^\s*server_id\s*=\s*"([^"]+)"/m)?.[1];
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
  // launchctl: kickstart -k hard-restarts the running job so it re-reads config.
  const miniRestart = await sudo(
    miniC,
    miniPwd,
    "launchctl kickstart -k system/com.managet.agent && sleep 1 && launchctl print system/com.managet.agent | grep -E 'state =|pid ='"
  );
  require0(miniRestart, "restart mini agent");
  console.log(`  mini agent restarted:\n${miniRestart.out.trim()}`);

  step("12", "Waiting 18s, then verifying heartbeats landed");
  await new Promise((r) => setTimeout(r, 18000));
  // sqlite3 query from the Pi against the freshly-running dashboard's DB.
  const hb = await exec(
    piC,
    `sqlite3 /home/andrei/managet/data/managet.db "SELECT name, agent_status, agent_last_heartbeat_at, agent_install_error IS NOT NULL FROM servers;"`
  );
  console.log(`  ${hb.out.trim()}`);

  miniC.end();
  piC.end();

  console.log("\n\x1b[1;32m✓ Migration complete.\x1b[0m");
  console.log(`  Dashboard: http://${piIp}:3000  (sign in fresh — different origin)`);
  console.log(`  Tmux:      ssh andrei@${piIp} -t 'tmux attach -t managet'`);
  console.log(`  Logs:      ssh andrei@${piIp} 'tail -f /tmp/managet-dev.log'`);
  console.log(`  Project:   ssh andrei@${piIp} ; cd /home/andrei/managet`);
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mMIGRATION FAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
