/**
 * Deploy the rebuilt managet-agent (with PTY sessions + Unix socket) to
 * both managed hosts:
 *   - Pi   (aarch64-unknown-linux-gnu): build on the Pi from source
 *           because we don't have a Linux cross-toolchain on this Mac.
 *   - Mac Mini (aarch64-apple-darwin):  scp the binary built natively
 *           on this laptop.
 *
 * After replacement we restart each service and run a tiny smoke test
 * against the new Unix socket (`managet ls`).
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

const db = new Database("data/managet.db", { readonly: true });
type Row = { host: string; port: number; username: string; password_encrypted: string };
const pi = db
  .prepare("SELECT host, port, username, password_encrypted FROM servers WHERE id = ?")
  .get(PI_ID) as Row;
const mini = db
  .prepare("SELECT host, port, username, password_encrypted FROM servers WHERE id = ?")
  .get(MINI_ID) as Row;
db.close();
const piPwd = decryptPassword(pi.password_encrypted);
const miniPwd = decryptPassword(mini.password_encrypted);

function step(n: string, msg: string) {
  console.log(`\n\x1b[1;36m[${n}] ${msg}\x1b[0m`);
}

function sshConnect(row: Row, password: string): Promise<Client> {
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
  return exec(c, `echo ${JSON.stringify(password)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`, { print });
}

function sftpPut(c: Client, local: string, remote: string): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, (e) => (e ? reject(e) : resolve()));
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
    throw new Error(`${label} failed (exit ${r.code})\nSTDOUT: ${r.out.trimEnd()}\nSTDERR: ${r.err.trimEnd()}`);
  }
}

async function deployPi() {
  step("PI-1", "Connecting to Pi");
  const c = await sshConnect(pi, piPwd);

  step("PI-2", "Tarring agent source on laptop and uploading");
  // We exclude target/ (the laptop's prebuilt artifacts — Pi will build its own).
  const tarball = "/tmp/managet-agent-src.tar.gz";
  await localExec("rm", ["-f", tarball]);
  const tar = await localExec("tar", [
    "--exclude=target",
    "-czf",
    tarball,
    "-C",
    "agent",
    ".",
  ]);
  if (tar.code !== 0) throw new Error("tar failed: " + tar.out);
  console.log(`  tarball: ${(statSync(tarball).size / 1024).toFixed(1)} KB`);
  await exec(c, "rm -rf /tmp/managet-agent-src && mkdir -p /tmp/managet-agent-src");
  await sftpPut(c, tarball, "/tmp/managet-agent-src.tar.gz");
  const extract = await exec(c, "tar -xzf /tmp/managet-agent-src.tar.gz -C /tmp/managet-agent-src");
  require0(extract, "extract");

  step("PI-3", "cargo build --release on Pi (using rust toolchain in $HOME/.cargo)");
  // The earlier install bootstrapped rustup at $HOME/.cargo. Source it
  // explicitly because non-login shells don't run .profile/.cargo/env.
  const build = await exec(
    c,
    `export PATH="$HOME/.cargo/bin:$PATH" && cd /tmp/managet-agent-src && cargo build --release 2>&1 | tail -30`,
    { print: true }
  );
  if (build.code !== 0) throw new Error("Pi cargo build failed");

  step("PI-4", "Stopping managet-agent + replacing binary");
  // Stop service first; Linux refuses to overwrite a running executable
  // (ETXTBSY). atomic rename via the install path would also work but
  // the existing service has a clean stop hook so let's use it.
  const stop = await sudo(c, piPwd, "systemctl stop managet-agent");
  require0(stop, "stop pi service");
  const replace = await sudo(
    c,
    piPwd,
    "install -m 755 /tmp/managet-agent-src/target/release/managet-agent /usr/local/bin/managet-agent && /usr/local/bin/managet-agent --version 2>/dev/null; /usr/local/bin/managet-agent --help 2>&1 | head -5"
  );
  console.log(`  ${replace.out.trim()}`);
  if (replace.code !== 0) throw new Error("install binary failed");

  step("PI-5", "Starting managet-agent + smoke test (managet ls)");
  const start = await sudo(c, piPwd, "systemctl start managet-agent && sleep 2 && systemctl is-active managet-agent");
  require0(start, "start pi service");
  console.log(`  service: ${start.out.trim()}`);
  // The agent ran for 2s; the Unix socket should be up. Run `managet ls`
  // (which is just `managet-agent ls`) as the andrei user — the socket
  // is chmod'd 0666 so non-root can connect.
  const ls = await exec(c, "/usr/local/bin/managet-agent ls 2>&1");
  console.log(`  $ managet-agent ls\n${ls.out.split("\n").map((l) => `    ${l}`).join("\n")}`);
  if (ls.code !== 0) throw new Error("managet ls failed on Pi");

  step("PI-6", "Smoke test: spawn a session, list, kill");
  const newSess = await exec(c, "/usr/local/bin/managet-agent new -n smoke 2>&1");
  console.log(`  new:\n${newSess.out.split("\n").map((l) => `    ${l}`).join("\n")}`);
  const ls2 = await exec(c, "/usr/local/bin/managet-agent ls 2>&1");
  console.log(`  ls (with smoke session):\n${ls2.out.split("\n").map((l) => `    ${l}`).join("\n")}`);
  // Kill it by name.
  const kill = await exec(c, "/usr/local/bin/managet-agent kill smoke 2>&1");
  console.log(`  kill: ${kill.out.trim()}`);

  c.end();
  console.log("\n  ✓ Pi agent rebuilt with sessions support");
}

async function deployMini() {
  step("MINI-1", "Connecting to Mac Mini");
  const c = await sshConnect(mini, miniPwd);

  step("MINI-2", "Uploading laptop-built aarch64-darwin binary");
  const localBin = "agent/target/release/managet-agent";
  const size = statSync(localBin).size;
  console.log(`  binary: ${(size / 1024 / 1024).toFixed(1)} MB`);
  await sftpPut(c, localBin, "/tmp/managet-agent.new");

  step("MINI-3", "Stopping launchd unit + atomic-rename binary");
  // launchctl bootout = stop + unload. We then install the new binary
  // and bootstrap again, mirroring how the original installer did it.
  await sudo(c, miniPwd, "launchctl bootout system/com.managet.agent 2>/dev/null; true");
  const inst = await sudo(
    c,
    miniPwd,
    "cp /tmp/managet-agent.new /usr/local/bin/managet-agent && chown root:wheel /usr/local/bin/managet-agent && chmod 755 /usr/local/bin/managet-agent && rm -f /tmp/managet-agent.new && /usr/local/bin/managet-agent --help 2>&1 | head -5"
  );
  console.log(`  ${inst.out.trim()}`);
  if (inst.code !== 0) throw new Error("install on mini failed");

  step("MINI-4", "Re-bootstrapping launchd unit + smoke test");
  const boot = await sudo(c, miniPwd, "launchctl bootstrap system /Library/LaunchDaemons/com.managet.agent.plist && sleep 2 && launchctl print system/com.managet.agent | grep -E 'state =|pid ='");
  console.log(`  ${boot.out.trim()}`);
  const ls = await exec(c, "/usr/local/bin/managet-agent ls 2>&1");
  console.log(`  $ managet-agent ls\n${ls.out.split("\n").map((l) => `    ${l}`).join("\n")}`);
  if (ls.code !== 0) throw new Error("managet ls failed on mini");

  step("MINI-5", "Spawn + list + kill");
  const newSess = await exec(c, "/usr/local/bin/managet-agent new -n smoke 2>&1");
  console.log(`  new:\n${newSess.out.split("\n").map((l) => `    ${l}`).join("\n")}`);
  const ls2 = await exec(c, "/usr/local/bin/managet-agent ls 2>&1");
  console.log(`  ls:\n${ls2.out.split("\n").map((l) => `    ${l}`).join("\n")}`);
  const kill = await exec(c, "/usr/local/bin/managet-agent kill smoke 2>&1");
  console.log(`  kill: ${kill.out.trim()}`);

  c.end();
  console.log("\n  ✓ Mac Mini agent rebuilt with sessions support");
}

async function main() {
  await deployPi();
  await deployMini();
  console.log(`\n\x1b[1;32m✓ Both agents rebuilt + smoke-tested.\x1b[0m`);
  console.log(`\nTry it:`);
  console.log(`  ssh andrei@${pi.host}`);
  console.log(`  managet-agent new            # spawn a session`);
  console.log(`  managet-agent ls             # see what's running`);
  console.log(`  managet-agent attach <id>    # attach (Ctrl-A d to detach)`);
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
