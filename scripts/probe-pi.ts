/** Inspect the Pi agent + child processes to figure out why kill no-ops. */
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
    "SELECT host, port, username, password_encrypted FROM servers WHERE name='markI (Pi)'"
  )
  .get() as { host: string; port: number; username: string; password_encrypted: string };
db.close();
const pwd = decryptPassword(row.password_encrypted);

function exec(c: Client, cmd: string): Promise<string> {
  return new Promise((resolve) => {
    c.exec(cmd, (err, s) => {
      if (err) return resolve(`(err) ${err.message}`);
      let out = "";
      s.on("data", (d: Buffer) => (out += d.toString()));
      s.stderr.on("data", (d: Buffer) => (out += d.toString()));
      s.on("close", () => resolve(out));
    });
  });
}

const c = new Client();
c.on("ready", async () => {
  for (const [label, cmd] of [
    ["agent uptime", "systemctl show managet-agent --property=ActiveEnterTimestamp,MainPID,ExecMainPID --no-pager"],
    ["agent pid tree", "AGENT_PID=$(systemctl show managet-agent --property=MainPID --value); echo agent=$AGENT_PID; pstree -p $AGENT_PID 2>&1 | head -20"],
    ["managet ls", "/usr/local/bin/managet ls 2>&1"],
    ["agent --version (file built date)", "stat -c '%n: built %y' /usr/local/bin/managet-agent"],
    ["zombie pids matching session ids", "for short in a017da57 43c562a0 bdac2fdf 28cb3479; do echo === $short ===; ps -ef | grep -i $short | grep -v grep; done"],
    ["sessions in agent state dir", "ls -la /var/lib/managet-agent 2>&1 || ls -la /etc/managet-agent 2>&1 || echo no state dir"],
    ["recent agent journalctl", "journalctl -u managet-agent --since='30 minutes ago' --no-pager | tail -30"],
  ] as const) {
    const out = await exec(c, cmd);
    console.log(`\n--- ${label} ---\n${out.trim()}`);
  }
  c.end();
});
c.on("error", (e) => { console.error(e.message); process.exit(1); });
c.connect({ host: row.host, port: row.port, username: row.username, password: pwd });
