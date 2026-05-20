/**
 * Smoke test for the bulk operations the new Sessions-page Select mode
 * fires off:
 *   - Bulk close (parallel deleteSession calls)
 *   - Bulk group-create (createGroup + addGroupMember × N-1)
 *
 *   npx tsx scripts/multiselect-smoke.ts
 */
import { readFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";

import { decryptPassword } from "../src/lib/crypto";
import {
  addMember,
  createGroupWithFirstMember,
  getGroup,
} from "../src/lib/groups";
import { killSession } from "../src/lib/ssh/session-manager";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
void decryptPassword; // not used here, but keeps import consistent if expanded

const db = new Database("data/managet.db");
const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
const sessions = db
  .prepare(
    "SELECT id, server_id, session_name FROM sessions WHERE status='active' AND group_id IS NULL AND stack_id IS NULL"
  )
  .all() as { id: string; server_id: string; session_name: string }[];
if (sessions.length < 3) {
  throw new Error(
    `need ≥3 free active sessions, have ${sessions.length}. spawn some via scripts/spawn-test-sessions.ts`
  );
}
console.log(`free sessions: ${sessions.map((s) => s.session_name).join(", ")}`);

const [a, b, c] = sessions;

async function main() {
  console.log("\n[1] Bulk-group: create group containing all 3");
  // Mirror the dashboard's flow: createGroup(name, firstId), then
  // addMember for the rest. The smoke verifies all three end up linked.
  const grp = await createGroupWithFirstMember({
    name: "multiselect-smoke",
    sessionId: a.id,
    createdBy: user.id,
  });
  await addMember(grp.id, b.id);
  await addMember(grp.id, c.id);
  const fetched = await getGroup(grp.id);
  if (!fetched || fetched.members.length !== 3) {
    throw new Error(`expected 3 members, got ${fetched?.members.length ?? 0}`);
  }
  console.log(
    `   ✓ group has 3 members: ${fetched.members.map((m) => m.sessionName).join(", ")}`
  );

  console.log("\n[2] Detach all 3 (mirror of remove-from-group)");
  // Bulk close kills the agent PTY and drops the row. Auto-cleanup on
  // killSession should remove the empty group once the last member
  // is gone.
  for (const sess of [a, b, c]) {
    await killSession(sess.server_id, sess.id);
  }
  const afterKill = await getGroup(grp.id);
  if (afterKill !== null) {
    throw new Error("group should have been auto-deleted after last kill");
  }
  console.log("   ✓ group auto-deleted once last session was killed");

  console.log("\n\x1b[1;32m✓ multiselect bulk flows OK.\x1b[0m");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.close());
