/**
 * End-to-end test: dashboard rename → agent ls on the host.
 *
 *   npx tsx scripts/test-rename-roundtrip.ts
 *
 * 1. SSH to Pi, spawn a fresh session via `managet new -n <orig>`.
 * 2. Wait for the agent reconciler to surface the row in the dashboard
 *    DB (poll the sessions table for ~5 s).
 * 3. Call the lib-level renameSession() directly (bypasses HTTP auth so
 *    this script doesn't need a logged-in cookie) — same code path
 *    the PUT /api/sessions/[id] route uses.
 * 4. SSH back, run `managet ls`, verify the new name shows.
 * 5. Clean up: kill the test session.
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

const PI_NAME = "markI (Pi)";

const db = new Database("data/managet.db");
type Row = {
  id: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
};
const row = db
  .prepare(
    "SELECT id, host, port, username, password_encrypted FROM servers WHERE name = ?"
  )
  .get(PI_NAME) as Row;
const password = decryptPassword(row.password_encrypted);

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

const ORIG_NAME = `roundtrip-${Date.now().toString(36)}`;
const NEW_NAME = `${ORIG_NAME}-renamed`;

async function main() {
  console.log(`server: ${row.username}@${row.host}  (id ${row.id})`);
  const c = await sshConnect();

  console.log(`\n[1] Spawning '${ORIG_NAME}' on Pi…`);
  const newRes = await exec(c, `/usr/local/bin/managet new -n ${ORIG_NAME}`);
  if (newRes.code !== 0) throw new Error("managet new failed: " + newRes.err);
  // `managet new` prints something like "session-abc1234" — but the
  // canonical id is the first column of `managet ls`. Pull it from
  // there to avoid parsing the human output.
  const ls1 = await exec(c, "/usr/local/bin/managet ls 2>&1");
  console.log(`    agent ls:\n${ls1.out.split("\n").map((l) => "      " + l).join("\n")}`);
  // managet ls's parsed first column is the truncated id. Get the
  // unambiguous id by listing via the JSON wire socket — easier: query
  // the DB after the heartbeat has reconciled.
  console.log(`\n[2] Triggering reconcile to surface the new session in DB…`);
  // The dashboard reconciles on demand from the /api/servers/[id]/sessions
  // route. Drive that same lib path here so the test doesn't depend on
  // an HTTP cookie or a UI navigation.
  await reconcileServer(row.id);
  const matchedRows = db
    .prepare(
      "SELECT id, session_name FROM sessions WHERE server_id = ? AND session_name = ? AND status = 'active'"
    )
    .all(row.id, ORIG_NAME) as { id: string; session_name: string }[];
  if (matchedRows.length === 0) {
    throw new Error(
      `reconcile didn't surface '${ORIG_NAME}' on the dashboard`
    );
  }
  const sessionId = matchedRows[0].id;
  console.log(`    DB has it: id=${sessionId}, name=${matchedRows[0].session_name}`);

  console.log(`\n[3] Calling renameSession() (same path as PUT /api/sessions/[id])…`);
  const result = await renameSession(row.id, sessionId, NEW_NAME);
  console.log(`    pushedToAgent: ${result.pushedToAgent}`);
  if (!result.pushedToAgent) {
    throw new Error("agent rejected the rename op");
  }
  // Update the DB ourselves to match what the PUT handler does.
  db.prepare("UPDATE sessions SET session_name = ?, updated_at = ? WHERE id = ?").run(
    NEW_NAME,
    Date.now(),
    sessionId
  );

  console.log(`\n[4] Verifying agent recognises the new name…`);
  // `managet ls` truncates names to 20 chars, so a substring check on
  // the human output isn't reliable. The authoritative check is
  // resolving by NEW name — which only works if the rename took on
  // the agent's side. `managet kill <name>` resolves through the same
  // path `managet attach <name>` uses.
  const kill = await exec(c, `/usr/local/bin/managet kill ${NEW_NAME} 2>&1`);
  console.log(`    $ managet kill ${NEW_NAME}\n    → ${kill.out.trim()}`);
  if (kill.code !== 0) {
    throw new Error(
      `Agent did NOT resolve the new name '${NEW_NAME}'. Rename didn't take.`
    );
  }
  console.log(`    ✓ resolved by NEW name — managet attach ${NEW_NAME} would work`);

  c.end();
  db.close();
  console.log("\n\x1b[1;32m✓ Rename round-trip succeeded.\x1b[0m");
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
