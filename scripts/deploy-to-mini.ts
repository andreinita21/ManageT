/**
 * Replace the Mac Mini's managet-agent with the rebuild from this
 * laptop (aarch64-darwin) and run a smoke test.
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
const db = new Database("data/managet.db", { readonly: true });
const mini = db.prepare("SELECT host, port, username, password_encrypted FROM servers WHERE id = ?").get("cfab293b-8571-4422-b57e-dca44c1f6b79") as any;
db.close();
const pwd = decryptPassword(mini.password_encrypted);

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
function sudo(c: Client, cmd: string) {
  return exec(c, `echo ${JSON.stringify(pwd)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`);
}
function sftpPut(c: Client, local: string, remote: string): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, (e) => (e ? reject(e) : resolve()));
    });
  });
}

async function main() {
  const c = new Client();
  await new Promise<void>((res, rej) => {
    c.on("ready", () => res());
    c.on("error", rej);
    c.connect({ host: mini.host, port: mini.port, username: mini.username, password: pwd, readyTimeout: 30000 });
  });

  console.log("[1] Upload new binary");
  console.log(`  size: ${(statSync("agent/target/release/managet-agent").size / 1024 / 1024).toFixed(1)} MB`);
  await sftpPut(c, "agent/target/release/managet-agent", "/tmp/managet-agent.new");

  console.log("[2] Stop launchd unit, replace, restart");
  // Boot out, copy binary, set perms, boot back in. Same dance as install.
  const op = await sudo(c, [
    "launchctl bootout system/com.managet.agent 2>/dev/null; true",
    "sleep 1",
    "cp /tmp/managet-agent.new /usr/local/bin/managet-agent",
    "chown root:wheel /usr/local/bin/managet-agent",
    "chmod 755 /usr/local/bin/managet-agent",
    "rm -f /tmp/managet-agent.new",
    "launchctl bootstrap system /Library/LaunchDaemons/com.managet.agent.plist",
    "sleep 2",
    "launchctl print system/com.managet.agent | grep -E 'state =|pid ='",
  ].join(" && "));
  console.log(op.out.trim());

  console.log("[3] Socket should exist");
  console.log((await exec(c, "ls -la /var/run/managet/ 2>&1; echo ---; ls -la /tmp/managet/ 2>&1")).out.trim());

  console.log("[4] managet-agent ls");
  console.log((await exec(c, "/usr/local/bin/managet-agent ls 2>&1")).out.trim());

  console.log("[5] managet-agent new -n smoke");
  console.log((await exec(c, "/usr/local/bin/managet-agent new -n smoke 2>&1")).out.trim());

  console.log("[6] managet-agent ls (should show smoke)");
  console.log((await exec(c, "/usr/local/bin/managet-agent ls 2>&1")).out.trim());

  console.log("[7] managet-agent kill smoke");
  console.log((await exec(c, "/usr/local/bin/managet-agent kill smoke 2>&1")).out.trim());

  c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
