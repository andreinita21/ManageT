/**
 * End-to-end test of the agent kill fix.
 *
 *   1. Spawn a fresh session on the Pi.
 *   2. Verify `managet ls` sees it.
 *   3. Call the dashboard's killSession (same path as DELETE
 *      /api/sessions/[id]).
 *   4. Re-run `managet ls` — the session should be gone.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";

import { decryptPassword } from "../src/lib/crypto";
import { killSession, reconcileServer } from "../src/lib/ssh/session-manager";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const db = new Database("data/managet.db");
const row = db
  .prepare(
    "SELECT id, host, port, username, password_encrypted FROM servers WHERE name='markI (Pi)'"
  )
  .get() as {
  id: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
};
const pwd = decryptPassword(row.password_encrypted);

function ssh(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const c = new Client();
    c.on("ready", () => {
      c.exec(cmd, (err, s) => {
        if (err) return resolve(`(err) ${err.message}`);
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
    c.connect({ host: row.host, port: row.port, username: row.username, password: pwd });
  });
}

const NAME = `kill-test-${Date.now().toString(36)}`;

(async () => {
  console.log(`[1] Spawn '${NAME}' on Pi`);
  console.log("    " + (await ssh(`/usr/local/bin/managet new -n ${NAME} 2>&1`)).trim());

  console.log("\n[2] Reconcile so dashboard DB sees it");
  await reconcileServer(row.id);
  const r = db
    .prepare(
      "SELECT id FROM sessions WHERE server_id=? AND session_name=? AND status='active'"
    )
    .all(row.id, NAME) as { id: string }[];
  if (r.length === 0) throw new Error("DB didn't see the new session");
  const sessionId = r[0].id;
  console.log(`    DB id=${sessionId}`);

  console.log("\n[3] managet ls (before kill)");
  console.log(await ssh("/usr/local/bin/managet ls 2>&1"));

  console.log("[4] killSession via dashboard lib");
  await killSession(row.id, sessionId);

  // Give the SIGTERM a moment to land + the agent's `wait()` to return.
  // The escalation SIGKILL also fires after 2s, so 3-4s is plenty.
  await new Promise((r) => setTimeout(r, 4000));

  console.log("\n[5] managet ls (after kill)");
  const after = await ssh("/usr/local/bin/managet ls 2>&1");
  console.log(after);
  if (after.includes(NAME)) {
    throw new Error(`session '${NAME}' is still in the agent's list — kill did not work`);
  }
  console.log(`\n\x1b[1;32m✓ kill removed '${NAME}' from the agent.\x1b[0m`);
  db.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
