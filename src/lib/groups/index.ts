/**
 * Shared helpers for the groups feature.
 *
 * A `group` is a display-only construct: it gathers up to
 * `GROUP_MAX_MEMBERS` (6) standalone terminal sessions into a single
 * mosaic page (`/groups/[id]`). Membership is one-group-per-session;
 * stack-bound sessions are ineligible. Empty groups are auto-deleted
 * the moment their last member leaves.
 */
import { v4 as uuidv4 } from "uuid";
import { and, asc, eq, isNull, ne } from "drizzle-orm";

import { db } from "@/lib/db";
import { groupLayouts, groups, sessions } from "@/lib/db/schema";
import { rowToSession } from "@/lib/db/transform";
import {
  GROUP_MAX_MEMBERS,
  type Group,
  type GroupLayout,
  type Session,
} from "@/types";

const DEFAULT_RATIO_PRECISION = 1e-4;

/** Default partition for a given member count — matches the legacy
 *  3-per-row rule so existing groups don't visually shift when this
 *  field becomes the source of truth. */
export function defaultPartitionForCount(n: number): number[] {
  if (n <= 0) return [];
  if (n <= 3) return [n];
  return [3, n - 3];
}

/** Build the equal-split layout for a given row partition. The partition
 *  drives both rowHeights (one per row) and colWidthsByRow (one inner
 *  array per row, equal-weighted columns). */
export function layoutForPartition(partition: number[]): GroupLayout {
  if (partition.length === 0) {
    return { rowHeights: [1], colWidthsByRow: [[]], rowPartition: [] };
  }
  const rowHeights = Array.from({ length: partition.length }, () => 1 / partition.length);
  const colWidthsByRow = partition.map((cols) =>
    Array.from({ length: cols }, () => 1 / cols)
  );
  return { rowHeights, colWidthsByRow, rowPartition: [...partition] };
}

/** Build the default equal-split layout for a member count of `n` (1..6). */
export function defaultLayoutForCount(n: number): GroupLayout {
  return layoutForPartition(defaultPartitionForCount(n));
}

/** Light sanity-check on a layout payload. The persisted `rowPartition`,
 *  when present, takes precedence — we accept any partition that sums
 *  to `memberCount`, has at most 2 rows, and matches the row/column
 *  shape of `rowHeights` / `colWidthsByRow`. Layouts written before this
 *  field existed (`rowPartition === undefined`) fall back to the legacy
 *  3-per-row check. */
export function isLayoutShapeValidForCount(
  l: GroupLayout,
  memberCount: number
): boolean {
  if (memberCount <= 0) return true;
  const sumNear1 = (arr: number[]) =>
    Math.abs(arr.reduce((a, b) => a + b, 0) - 1) < DEFAULT_RATIO_PRECISION;

  const partition: number[] | undefined = l.rowPartition;
  if (partition !== undefined) {
    if (!Array.isArray(partition) || partition.length === 0 || partition.length > 2) {
      return false;
    }
    if (partition.some((c) => !Number.isInteger(c) || c < 1)) return false;
    if (partition.reduce((a, b) => a + b, 0) !== memberCount) return false;
    if (!Array.isArray(l.rowHeights) || l.rowHeights.length !== partition.length) {
      return false;
    }
    if (
      !Array.isArray(l.colWidthsByRow) ||
      l.colWidthsByRow.length !== partition.length
    ) {
      return false;
    }
    for (let i = 0; i < partition.length; i++) {
      if (l.colWidthsByRow[i]?.length !== partition[i]) return false;
    }
    if (!sumNear1(l.rowHeights)) return false;
    if (!l.colWidthsByRow.every(sumNear1)) return false;
    return true;
  }

  // Legacy shape — 3-per-row.
  const rows = memberCount <= 3 ? 1 : 2;
  const firstRow = Math.min(memberCount, 3);
  const secondRow = Math.max(0, memberCount - firstRow);
  if (!Array.isArray(l.rowHeights) || l.rowHeights.length !== rows) return false;
  if (!Array.isArray(l.colWidthsByRow) || l.colWidthsByRow.length !== rows)
    return false;
  if (l.colWidthsByRow[0]?.length !== firstRow) return false;
  if (rows === 2 && l.colWidthsByRow[1]?.length !== secondRow) return false;
  if (!sumNear1(l.rowHeights)) return false;
  if (!l.colWidthsByRow.every(sumNear1)) return false;
  return true;
}

async function membersOf(groupId: string): Promise<Session[]> {
  // Closed sessions are excluded: a dead PTY is no longer a terminal in
  // the group. They lose their groupId on close (see
  // detachFromGroupOnClose), but we also filter here so any legacy
  // zombie row never shows in the mosaic or inflates the count.
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.groupId, groupId), ne(sessions.status, "closed")))
    .orderBy(asc(sessions.groupOrderIndex));
  return rows.map(rowToSession);
}

/** Re-pack ordering indexes 0..n-1 for a group's current members. Called
 *  whenever a member is added/removed so the mosaic stays gap-free. */
async function repackOrder(groupId: string): Promise<void> {
  const rows = await db
    .select({ id: sessions.id, groupOrderIndex: sessions.groupOrderIndex })
    .from(sessions)
    .where(eq(sessions.groupId, groupId))
    .orderBy(asc(sessions.groupOrderIndex));
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].groupOrderIndex !== i) {
      await db
        .update(sessions)
        .set({ groupOrderIndex: i, updatedAt: Date.now() })
        .where(eq(sessions.id, rows[i].id));
    }
  }
}

/** Fetch a single group with its ordered members. Returns null if missing. */
export async function getGroup(groupId: string): Promise<Group | null> {
  const rows = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  if (rows.length === 0) return null;
  const g = rows[0];
  const members = await membersOf(groupId);
  return {
    id: g.id,
    name: g.name,
    createdBy: g.createdBy,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    members,
  };
}

/** List every group with members, ordered by createdAt desc. */
export async function listGroups(): Promise<Group[]> {
  const groupRows = await db.select().from(groups);
  if (groupRows.length === 0) return [];
  const memberRows = await db
    .select()
    .from(sessions)
    .orderBy(asc(sessions.groupOrderIndex));
  const byGroup = new Map<string, Session[]>();
  for (const r of memberRows) {
    // Skip ungrouped and closed (dead) sessions — see membersOf.
    if (!r.groupId || r.status === "closed") continue;
    const list = byGroup.get(r.groupId) ?? [];
    list.push(rowToSession(r));
    byGroup.set(r.groupId, list);
  }
  return groupRows
    .map((g) => ({
      id: g.id,
      name: g.name,
      createdBy: g.createdBy,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      members: byGroup.get(g.id) ?? [],
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export class GroupConstraintError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "session_not_found"
      | "session_in_stack"
      | "session_in_other_group"
      | "group_full"
      | "name_required"
  ) {
    super(message);
    this.name = "GroupConstraintError";
  }
}

/** Validate that a session is currently eligible to be added to a group.
 *  Throws GroupConstraintError on any rule violation. Caller must pass the
 *  *target* groupId (or undefined for "any new group") so we don't reject a
 *  session that already happens to be in the same target group. */
async function assertSessionEligible(
  sessionId: string,
  targetGroupId?: string
): Promise<void> {
  const rows = await db
    .select({
      id: sessions.id,
      stackId: sessions.stackId,
      groupId: sessions.groupId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (rows.length === 0) {
    throw new GroupConstraintError(
      `Session ${sessionId} not found`,
      "session_not_found"
    );
  }
  const row = rows[0];
  if (row.stackId) {
    throw new GroupConstraintError(
      `Session is part of a stack and can't be added to a group`,
      "session_in_stack"
    );
  }
  if (row.groupId && row.groupId !== targetGroupId) {
    throw new GroupConstraintError(
      `Session is already in another group`,
      "session_in_other_group"
    );
  }
}

async function assertGroupHasRoom(groupId: string): Promise<void> {
  const memberRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.groupId, groupId), ne(sessions.status, "closed")));
  if (memberRows.length >= GROUP_MAX_MEMBERS) {
    throw new GroupConstraintError(
      `Group is at the ${GROUP_MAX_MEMBERS}-terminal cap`,
      "group_full"
    );
  }
}

/** Create a brand-new group with `sessionId` as its first member. The
 *  session is validated; on success the row gains `groupId` and
 *  `groupOrderIndex = 0`. */
export async function createGroupWithFirstMember(input: {
  name: string;
  sessionId: string;
  createdBy: string;
}): Promise<Group> {
  const name = input.name.trim();
  if (!name) {
    throw new GroupConstraintError("Group name is required", "name_required");
  }
  await assertSessionEligible(input.sessionId);
  const id = uuidv4();
  const now = Date.now();
  await db.insert(groups).values({
    id,
    name,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(sessions)
    .set({ groupId: id, groupOrderIndex: 0, updatedAt: now })
    .where(eq(sessions.id, input.sessionId));
  const g = await getGroup(id);
  if (!g) throw new Error("Group disappeared right after creation");
  return g;
}

export async function renameGroup(
  groupId: string,
  name: string
): Promise<Group | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new GroupConstraintError("Group name is required", "name_required");
  }
  const now = Date.now();
  await db
    .update(groups)
    .set({ name: trimmed, updatedAt: now })
    .where(eq(groups.id, groupId));
  return getGroup(groupId);
}

export async function deleteGroup(groupId: string): Promise<void> {
  // Detach every session still pointing at this group (including closed
  // ones) BEFORE removing the group row. The live DB's
  // `sessions.group_id` FK was added via `ALTER TABLE ... ADD` without
  // an ON DELETE action, so with foreign_keys enforcement on, deleting
  // a group that still has referencing rows raises
  // SQLITE_CONSTRAINT_FOREIGNKEY. Nulling first makes the delete always
  // succeed and leaves the members free-standing (their shells keep
  // running) — the intended behaviour the schema's `onDelete: "set
  // null"` was meant to provide.
  const now = Date.now();
  await db
    .update(sessions)
    .set({ groupId: null, groupOrderIndex: 0, updatedAt: now })
    .where(eq(sessions.groupId, groupId));
  // group_layouts is declared ON DELETE CASCADE, but delete explicitly
  // so cleanup doesn't depend on the FK pragma being enabled.
  await db.delete(groupLayouts).where(eq(groupLayouts.groupId, groupId));
  await db.delete(groups).where(eq(groups.id, groupId));
}

/** Add an existing free session to a group. Validates eligibility and the
 *  6-member cap; appends at the end of the current order. */
export async function addMember(
  groupId: string,
  sessionId: string
): Promise<Group> {
  const g = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  if (g.length === 0) {
    throw new GroupConstraintError(
      `Group ${groupId} not found`,
      "session_not_found"
    );
  }
  // Reject re-adding a session that is already a member of this same
  // group — the caller almost certainly didn't mean to bump it to the
  // end of the order, and the no-op-with-side-effects shape would be
  // confusing.
  const already = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.groupId, groupId)))
    .limit(1);
  if (already.length > 0) {
    throw new GroupConstraintError(
      `Session is already in this group`,
      "session_in_other_group"
    );
  }
  await assertSessionEligible(sessionId, groupId);
  await assertGroupHasRoom(groupId);
  const existing = await db
    .select({ idx: sessions.groupOrderIndex })
    .from(sessions)
    .where(eq(sessions.groupId, groupId));
  const nextIdx = existing.length;
  const now = Date.now();
  await db
    .update(sessions)
    .set({ groupId, groupOrderIndex: nextIdx, updatedAt: now })
    .where(eq(sessions.id, sessionId));
  await db
    .update(groups)
    .set({ updatedAt: now })
    .where(eq(groups.id, groupId));
  const refreshed = await getGroup(groupId);
  if (!refreshed) throw new Error("Group disappeared during addMember");
  return refreshed;
}

/** Detach a single session from its group (does NOT kill the shell). If the
 *  group becomes empty it's deleted. Returns the updated group, or null if
 *  the group was auto-removed. */
export async function removeMember(
  groupId: string,
  sessionId: string
): Promise<Group | null> {
  const now = Date.now();
  await db
    .update(sessions)
    .set({ groupId: null, groupOrderIndex: 0, updatedAt: now })
    .where(and(eq(sessions.id, sessionId), eq(sessions.groupId, groupId)));
  await repackOrder(groupId);
  const deleted = await cleanupEmptyGroupIfNeeded(groupId);
  if (deleted) return null;
  await db
    .update(groups)
    .set({ updatedAt: now })
    .where(eq(groups.id, groupId));
  return getGroup(groupId);
}

/** Persist a full reorder. `sessionIds` must contain every current member,
 *  no extras and no duplicates. */
export async function reorderMembers(
  groupId: string,
  sessionIds: string[]
): Promise<Group> {
  const members = await membersOf(groupId);
  const currentIds = new Set(members.map((m) => m.id));
  if (sessionIds.length !== members.length) {
    throw new GroupConstraintError(
      `Reorder must include exactly the current ${members.length} member(s)`,
      "session_not_found"
    );
  }
  const seen = new Set<string>();
  for (const id of sessionIds) {
    if (!currentIds.has(id)) {
      throw new GroupConstraintError(
        `Session ${id} is not a member of this group`,
        "session_not_found"
      );
    }
    if (seen.has(id)) {
      throw new GroupConstraintError(
        `Duplicate session id ${id} in reorder`,
        "session_not_found"
      );
    }
    seen.add(id);
  }
  const now = Date.now();
  for (let i = 0; i < sessionIds.length; i += 1) {
    await db
      .update(sessions)
      .set({ groupOrderIndex: i, updatedAt: now })
      .where(eq(sessions.id, sessionIds[i]));
  }
  await db
    .update(groups)
    .set({ updatedAt: now })
    .where(eq(groups.id, groupId));
  const refreshed = await getGroup(groupId);
  if (!refreshed) throw new Error("Group disappeared during reorder");
  return refreshed;
}

/** If `groupId` exists and has zero members, delete it. Returns true when
 *  the group was removed. Safe to call repeatedly. */
export async function cleanupEmptyGroupIfNeeded(
  groupId: string
): Promise<boolean> {
  const exists = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1);
  if (exists.length === 0) return false;
  // "Empty" means no *live* members. A group whose only remaining
  // members are closed PTYs should auto-delete just like one with zero
  // rows — matching the rule that a group disappears once it has no
  // terminal left in it.
  const members = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.groupId, groupId), ne(sessions.status, "closed")))
    .limit(1);
  if (members.length > 0) return false;
  await deleteGroup(groupId);
  return true;
}

/** Sweep every group that currently has zero rows in `sessions`. Cheap
 *  enough to run opportunistically (e.g. inside the sessions list route)
 *  but not strictly required — `cleanupEmptyGroupIfNeeded` covers the
 *  hot paths. */
export async function cleanupAllEmptyGroups(): Promise<void> {
  const all = await db.select({ id: groups.id }).from(groups);
  if (all.length === 0) return;
  const memberRows = await db
    .select({ groupId: sessions.groupId })
    .from(sessions)
    .where(isNull(sessions.groupId));
  // Cheaper to re-query per group than to maintain a counter here.
  for (const g of all) {
    await cleanupEmptyGroupIfNeeded(g.id);
  }
  void memberRows;
}

/** Fetch the persisted layout for `(userId, groupId)`. Returns null when
 *  the user hasn't dragged anything yet — the UI then falls back to
 *  `defaultLayoutForCount`. */
export async function getUserLayout(
  userId: string,
  groupId: string
): Promise<GroupLayout | null> {
  const rows = await db
    .select()
    .from(groupLayouts)
    .where(
      and(eq(groupLayouts.userId, userId), eq(groupLayouts.groupId, groupId))
    )
    .limit(1);
  if (rows.length === 0) return null;
  try {
    const parsed = JSON.parse(rows[0].layoutJson) as GroupLayout;
    return parsed;
  } catch {
    return null;
  }
}

/** Upsert the per-user layout. We don't bother validating against the
 *  current member count — the UI passes whatever it computed, and
 *  `isLayoutShapeValidForCount` is used on read to decide whether to
 *  fall back to the default. */
export async function saveUserLayout(
  userId: string,
  groupId: string,
  layout: GroupLayout
): Promise<void> {
  const now = Date.now();
  const existing = await db
    .select({ id: groupLayouts.id })
    .from(groupLayouts)
    .where(
      and(eq(groupLayouts.userId, userId), eq(groupLayouts.groupId, groupId))
    )
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(groupLayouts)
      .set({ layoutJson: JSON.stringify(layout), updatedAt: now })
      .where(eq(groupLayouts.id, existing[0].id));
    return;
  }
  await db.insert(groupLayouts).values({
    id: uuidv4(),
    userId,
    groupId,
    layoutJson: JSON.stringify(layout),
    updatedAt: now,
  });
}
