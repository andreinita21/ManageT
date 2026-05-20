/**
 * Smoke test for the Groups feature. Hits the lib helpers directly
 * against the dev DB (the same one the running app uses).
 *
 *   npx tsx scripts/groups-smoke.ts
 *
 * Picks the first admin user and three free sessions; exercises create,
 * add (incl. cap + duplicate + stack-bound rejection), reorder, remove,
 * auto-cleanup, and layout persistence. Cleans up its own row at the
 * end so re-running is safe.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { groups, sessions, users } from "@/lib/db/schema";
import {
  addMember,
  cleanupEmptyGroupIfNeeded,
  createGroupWithFirstMember,
  defaultLayoutForCount,
  getGroup,
  getUserLayout,
  GroupConstraintError,
  removeMember,
  reorderMembers,
  saveUserLayout,
} from "@/lib/groups";
import { GROUP_MAX_MEMBERS } from "@/types";

function header(s: string) {
  console.log(`\n--- ${s} ---`);
}

async function main() {
  const userRows = await db.select().from(users).limit(1);
  if (userRows.length === 0) throw new Error("no users in DB");
  const userId = userRows[0].id;

  const allSessions = await db.select().from(sessions);
  const free = allSessions.filter(
    (s) => !s.stackId && !s.groupId && s.status === "active"
  );
  const stackBound = allSessions.find((s) => s.stackId);
  if (free.length < 3) {
    throw new Error(
      `need ≥3 free active sessions for the smoke test; have ${free.length}`
    );
  }
  console.log(
    `[setup] user=${userId} free=${free.length} stack-bound=${stackBound ? 1 : 0}`
  );

  let createdGroupId: string | null = null;

  try {
    header("create group with first member");
    const g1 = await createGroupWithFirstMember({
      name: "smoke-test",
      sessionId: free[0].id,
      createdBy: userId,
    });
    createdGroupId = g1.id;
    console.log(
      `created group ${g1.id} (${g1.name}) with ${g1.members.length} member`
    );
    if (g1.members[0].id !== free[0].id) throw new Error("first member mismatch");

    header("add second + third members");
    const g2 = await addMember(g1.id, free[1].id);
    const g3 = await addMember(g2.id, free[2].id);
    if (g3.members.length !== 3) throw new Error("expected 3 members");
    console.log(
      `members: ${g3.members.map((m) => `${m.sessionName}#${m.groupOrderIndex}`).join(", ")}`
    );

    header("reject re-adding the same session");
    try {
      await addMember(g3.id, free[0].id);
      throw new Error("should have rejected duplicate add");
    } catch (err) {
      if (!(err instanceof GroupConstraintError))
        throw new Error("expected GroupConstraintError");
      console.log(`✓ rejected: ${err.code}`);
    }

    if (stackBound) {
      header("reject adding a stack-bound session");
      try {
        await addMember(g3.id, stackBound.id);
        throw new Error("should have rejected stack-bound add");
      } catch (err) {
        if (!(err instanceof GroupConstraintError))
          throw new Error("expected GroupConstraintError");
        if (err.code !== "session_in_stack")
          throw new Error(`unexpected code: ${err.code}`);
        console.log(`✓ rejected: ${err.code}`);
      }
    }

    header("reorder (reverse)");
    const reversed = [...g3.members].reverse().map((m) => m.id);
    const g4 = await reorderMembers(g3.id, reversed);
    if (g4.members.map((m) => m.id).join(",") !== reversed.join(","))
      throw new Error("reorder did not stick");
    console.log(
      `after reorder: ${g4.members.map((m) => `${m.sessionName}#${m.groupOrderIndex}`).join(", ")}`
    );

    header("save + read layout");
    const layout = defaultLayoutForCount(g4.members.length);
    layout.colWidthsByRow[0] = [0.5, 0.25, 0.25];
    await saveUserLayout(userId, g4.id, layout);
    const readBack = await getUserLayout(userId, g4.id);
    if (!readBack) throw new Error("layout did not persist");
    if (Math.abs(readBack.colWidthsByRow[0][0] - 0.5) > 1e-6)
      throw new Error("layout values did not round-trip");
    console.log(`✓ layout round-tripped: ${JSON.stringify(readBack)}`);

    header("remove one member (group still alive)");
    const g5 = await removeMember(g4.id, g4.members[1].id);
    if (!g5) throw new Error("group should not have been deleted yet");
    if (g5.members.length !== 2) throw new Error("expected 2 members");
    const order = g5.members.map((m) => m.groupOrderIndex);
    if (JSON.stringify(order) !== JSON.stringify([0, 1]))
      throw new Error(`order should be [0,1] after repack, got ${order}`);
    console.log(
      `after remove + repack: ${g5.members.map((m) => `${m.sessionName}#${m.groupOrderIndex}`).join(", ")}`
    );

    header("remove last members → auto-delete group");
    const after1 = await removeMember(g5.id, g5.members[0].id);
    if (!after1)
      throw new Error("group should still exist after removing one of two");
    // Use the freshly-returned `after1` (not the stale g5) so we target a
    // session that's still actually in the group.
    const after2 = await removeMember(g5.id, after1.members[0].id);
    if (after2 !== null)
      throw new Error("group should have auto-deleted after last member left");
    const stillThere = await getGroup(g5.id);
    if (stillThere !== null) throw new Error("group row still in DB after cleanup");
    createdGroupId = null;
    console.log(`✓ group auto-deleted; sessions are back to free`);

    header("cleanupEmptyGroupIfNeeded is idempotent");
    const newGroup = await createGroupWithFirstMember({
      name: "cleanup-probe",
      sessionId: free[0].id,
      createdBy: userId,
    });
    createdGroupId = newGroup.id;
    // Detach the lone member directly via DB to simulate an external kill.
    await db
      .update(sessions)
      .set({ groupId: null, updatedAt: Date.now() })
      .where(eq(sessions.id, free[0].id));
    const removed1 = await cleanupEmptyGroupIfNeeded(newGroup.id);
    const removed2 = await cleanupEmptyGroupIfNeeded(newGroup.id);
    if (!removed1) throw new Error("first cleanup should delete the group");
    if (removed2) throw new Error("second cleanup should be a no-op");
    createdGroupId = null;
    console.log(`✓ cleanup idempotent`);

    console.log("\nALL CHECKS PASSED ✓");
  } finally {
    // Belt-and-braces: if anything threw mid-flight, scrub the groupId
    // pointer off the test sessions FIRST (FK rejects a group delete
    // while rows still reference it), then drop the group row so
    // re-runs start clean.
    for (const s of free) {
      await db
        .update(sessions)
        .set({ groupId: null, groupOrderIndex: 0, updatedAt: Date.now() })
        .where(eq(sessions.id, s.id));
    }
    if (createdGroupId) {
      await db.delete(groups).where(eq(groups.id, createdGroupId));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
