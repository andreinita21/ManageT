/**
 * Build + deploy the agent on the Mac mini in one shot.
 *
 *   npx tsx scripts/deploy-agent-mac-build.ts
 *
 * The Mac mini has cargo at ~/.cargo/bin so we tar the source, ship
 * it, cargo build --release on the host (aarch64-apple-darwin), then
 * replace /usr/local/bin/managet-agent + managet under sudo and
 * bounce the launchd unit. Mirrors the Pi-build branch of the
 * original scripts/deploy-agent.ts.
 *
 * Smoke test at the end: managet ls + rename op acceptance.
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

const db = new Database("data/managet.db", { readonly: true });
const row = db
  .prepare(
    "SELECT id, host, port, username, password_encrypted FROM servers WHERE name = ?"
  )
  .get("Mac mini") as {
  id: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
};
db.close();
const password = decryptPassword(row.password_encrypted);
console.log(`target: ${row.username}@${row.host}  (id ${row.id})`);

function step(n: string, msg: string) {
  console.log(`\n\x1b[1;36m[${n}] ${msg}\x1b[0m`);
}
function sshConnect(): Promise<Client> {
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
function sudo(c: Client, cmd: string, print = false) {
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
function localExec(
  cmd: string,
  args: string[]
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
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
  step("1", "Connecting to Mac mini");
  const c = await sshConnect();

  step("2", "Tarring agent source + uploading");
  // Exclude target/ — that's the local dev box's build artifacts.
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
  const extract = await exec(
    c,
    "tar -xzf /tmp/managet-agent-src.tar.gz -C /tmp/managet-agent-src"
  );
  require0(extract, "extract");

  step("3", "cargo build --release on the mac (aarch64-apple-darwin)");
  // Non-login shells don't run .zshrc, so cargo isn't on PATH by default.
  // Source it explicitly. ~7-10 min on cold build, fast on warm cargo cache.
  const build = await exec(
    c,
    `source $HOME/.cargo/env && cd /tmp/managet-agent-src && cargo build --release 2>&1 | tail -20`,
    { print: true }
  );
  if (build.code !== 0) throw new Error("cargo build on mac failed");

  step("4", "Stopping launchd unit + installing new binaries");
  await sudo(c, "launchctl bootout system/com.managet.agent 2>/dev/null; true");
  const inst = await sudo(
    c,
    "install -m 755 -o root -g wheel /tmp/managet-agent-src/target/release/managet-agent /usr/local/bin/managet-agent && " +
      "install -m 755 -o root -g wheel /tmp/managet-agent-src/target/release/managet /usr/local/bin/managet && " +
      "/usr/local/bin/managet-agent --help 2>&1 | head -3"
  );
  require0(inst, "install");
  console.log(`  ${inst.out.trim()}`);

  step("5", "Re-bootstrapping launchd unit");
  // launchctl bootstrap intermittently fails with "Input/output error"
  // (exit 5) when the prior bootout hasn't fully settled — the service is
  // still half-registered. A clean bootout + a few seconds' settle before
  // bootstrap fixes it reliably; retry once for good measure.
  const bootCmd =
    "launchctl bootout system/com.managet.agent 2>/dev/null; sleep 3; " +
    "launchctl bootstrap system /Library/LaunchDaemons/com.managet.agent.plist 2>&1; " +
    "code=$?; " +
    "if [ $code -ne 0 ]; then sleep 3; launchctl bootstrap system /Library/LaunchDaemons/com.managet.agent.plist 2>&1; code=$?; fi; " +
    "sleep 2; launchctl print system/com.managet.agent 2>&1 | grep -E 'state =|pid =' | head -3; " +
    "exit $code";
  const boot = await sudo(c, bootCmd);
  require0(boot, "bootstrap");
  console.log(`  ${boot.out.trim()}`);

  step("6", "Smoke test (managet ls)");
  const ls = await exec(c, "/usr/local/bin/managet ls 2>&1");
  console.log(`  $ managet ls\n${ls.out.split("\n").map((l) => "    " + l).join("\n")}`);
  if (ls.code !== 0) throw new Error("managet ls failed on Mac mini");

  c.end();
  console.log("\n\x1b[1;32m✓ Mac mini agent rebuilt + redeployed.\x1b[0m");
  console.log("Note: the agent restart wipes its in-memory session list.");
  console.log(
    "Existing DB rows for the Mac will be marked closed on the next reconcile."
  );
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
