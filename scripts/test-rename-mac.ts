/**
 * End-to-end rename test against the Mac mini.
 *
 *   npx tsx scripts/test-rename-mac.ts
 *
 * Confirms the Mac's freshly-built agent accepts the `rename` op and
 * surfaces the new name in `managet ls` / `managet attach <name>`.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";

import { decryptPassword } from "../src/lib/crypto";
import { reconcileServer, renameSession } from "../src/lib/ssh/session-manager";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const db = new Database("data/managet.db");
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
const pwd = decryptPassword(row.password_encrypted);

function sshConnect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({
      host: row.host,
      port: row.port,
      username: row.username,
      password: pwd,
      readyTimeout: 30000,
    });
  });
}
function exec(
  c: Client,
  cmd: string
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, s) => {
      if (err) return reject(err);
      let out = "";
      let er = "";
      s.on("data", (d: Buffer) => (out += d.toString()));
      s.stderr.on("data", (d: Buffer) => (er += d.toString()));
      s.on("close", (code: number | null) =>
        resolve({ code: code ?? -1, out, err: er })
      );
    });
  });
}

const ORIG = `mac-rename-${Date.now().toString(36)}`;
const NEW = `${ORIG}-renamed`;

async function main() {
  console.log(`target: ${row.username}@${row.host} (mac mini)`);
  const c = await sshConnect();

  console.log(`\n[1] Spawn '${ORIG}' on Mac`);
  const newRes = await exec(c, `/usr/local/bin/managet new -n ${ORIG} 2>&1`);
  if (newRes.code !== 0) throw new Error("managet new failed: " + newRes.out);
  console.log(`    ${newRes.out.trim().split("\n").slice(0, 2).join(" / ")}`);

  console.log(`\n[2] Reconcile so dashboard DB sees it`);
  await reconcileServer(row.id);
  const r = db
    .prepare(
      "SELECT id, session_name FROM sessions WHERE server_id = ? AND session_name = ? AND status='active'"
    )
    .all(row.id, ORIG) as { id: string; session_name: string }[];
  if (r.length === 0) throw new Error(`'${ORIG}' not in DB after reconcile`);
  const sessionId = r[0].id;
  console.log(`    DB id=${sessionId}`);

  console.log(`\n[3] Rename via lib (same path as PUT /api/sessions/[id])`);
  const outcome = await renameSession(row.id, sessionId, NEW);
  console.log(`    outcome.kind = ${outcome.kind}`);
  if (outcome.kind !== "pushed") {
    throw new Error(`expected 'pushed', got '${outcome.kind}'`);
  }
  db.prepare("UPDATE sessions SET session_name = ?, updated_at = ? WHERE id = ?").run(
    NEW,
    Date.now(),
    sessionId
  );

  console.log(`\n[4] Verify resolution by new name (managet kill <new>)`);
  const kill = await exec(c, `/usr/local/bin/managet kill ${NEW} 2>&1`);
  console.log(`    $ managet kill ${NEW}\n    → ${kill.out.trim()}`);
  if (kill.code !== 0)
    throw new Error(`agent did not resolve new name '${NEW}'`);
  console.log(`    ✓ resolved — managet attach ${NEW} would work`);

  c.end();
  db.close();
  console.log("\n\x1b[1;32m✓ Mac mini rename round-trip succeeded.\x1b[0m");
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
