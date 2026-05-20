/** Tiny probe: what's available on the mac mini for building the agent? */
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

const db = new Database("data/managet.db", { readonly: true });
const row = db
  .prepare(
    "SELECT host, port, username, password_encrypted FROM servers WHERE name = ?"
  )
  .get("Mac mini") as { host: string; port: number; username: string; password_encrypted: string };
db.close();
const pwd = decryptPassword(row.password_encrypted);

function exec(c: Client, cmd: string) {
  return new Promise<string>((resolve) => {
    c.exec(cmd, (err, s) => {
      if (err) return resolve(`(err: ${err.message})`);
      let out = "";
      s.on("data", (d: Buffer) => (out += d.toString()));
      s.stderr.on("data", (d: Buffer) => (out += d.toString()));
      s.on("close", () => resolve(out.trim()));
    });
  });
}

const c = new Client();
c.on("ready", async () => {
  const probes: [string, string][] = [
    ["uname", "uname -a"],
    ["rustc", "which rustc && rustc --version 2>&1 || echo MISSING"],
    ["cargo", "which cargo && cargo --version 2>&1 || echo MISSING"],
    ["brew", "which brew && brew --version 2>&1 | head -1 || echo MISSING"],
    ["managet-agent path", "which managet-agent /usr/local/bin/managet-agent 2>&1"],
    ["agent version", "/usr/local/bin/managet-agent --help 2>&1 | head -2 || true"],
    ["launchd", "launchctl print system/com.managet.agent 2>&1 | head -10 | grep -E 'state =|program ='"],
    ["managet ls", "/usr/local/bin/managet ls 2>&1 | head -10"],
    ["sessions in agent", "ls /tmp/managet-agent-*.sock 2>&1 || true"],
  ];
  for (const [label, cmd] of probes) {
    const out = await exec(c, cmd);
    console.log(`\n--- ${label} ---\n${out}`);
  }
  c.end();
});
c.on("error", (e) => {
  console.error("ssh error:", e.message);
  process.exit(1);
});
c.connect({
  host: row.host,
  port: row.port,
  username: row.username,
  password: pwd,
});
