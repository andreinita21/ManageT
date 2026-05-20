/**
 * Probe what happens when the dashboard's killSession runs against
 * one of the suspect Pi sessions. If it returns OK but `managet ls`
 * still shows the session, the agent is silently no-op'ing the kill.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";

import { decryptPassword } from "../src/lib/crypto";
import { killSession } from "../src/lib/ssh/session-manager";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const db = new Database("data/managet.db");
const target = db
  .prepare(
    "SELECT s.id, s.session_name, s.server_id, sv.host, sv.port, sv.username, sv.password_encrypted FROM sessions s JOIN servers sv ON sv.id=s.server_id WHERE s.status='active' AND sv.name='markI (Pi)' LIMIT 1"
  )
  .get() as
  | {
      id: string;
      session_name: string;
      server_id: string;
      host: string;
      port: number;
      username: string;
      password_encrypted: string;
    }
  | undefined;
if (!target) {
  console.log("no active Pi sessions left");
  process.exit(0);
}
console.log(`target: ${target.session_name}  id=${target.id}`);

const pwd = decryptPassword(target.password_encrypted);
function ssh(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const c = new Client();
    c.on("ready", () => {
      c.exec(cmd, (err, s) => {
        if (err) return resolve(`(exec err) ${err.message}`);
        let out = "";
        s.on("data", (d: Buffer) => (out += d.toString()));
        s.stderr.on("data", (d: Buffer) => (out += d.toString()));
        s.on("close", () => {
          c.end();
          resolve(out);
        });
      });
    });
    c.on("error", (e) => resolve(`(ssh err) ${e.message}`));
    c.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      password: pwd,
    });
  });
}

(async () => {
  console.log("\n[before] managet ls on Pi:");
  console.log(await ssh("/usr/local/bin/managet ls 2>&1"));

  console.log("\n[kill] killSession(serverId, id) from dashboard lib…");
  try {
    await killSession(target.server_id, target.id);
    console.log("  returned OK");
  } catch (err) {
    console.log("  THREW:", err instanceof Error ? err.message : err);
  }

  console.log("\n[after] managet ls on Pi:");
  console.log(await ssh("/usr/local/bin/managet ls 2>&1"));

  const row = db
    .prepare("SELECT status FROM sessions WHERE id = ?")
    .get(target.id) as { status: string } | undefined;
  console.log(`\n[db] sessions.status for ${target.id.slice(0, 8)} = ${row?.status ?? "(gone)"}`);

  db.close();
  process.exit(0);
})();
