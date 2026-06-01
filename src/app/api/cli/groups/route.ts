/**
 * GET /api/cli/groups
 *
 * Token-authenticated group list for the Rust CLI. Browser routes keep
 * using NextAuth cookies; this route intentionally accepts only CLI
 * bearer tokens.
 *
 * Returns the user's groups, the minimal server directory (so the CLI
 * can render server labels next to each group), and the caller's
 * "server label" preference — host name vs. friendly name — so
 * `managet ls` matches what they see in the browser tab.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { ne } from "drizzle-orm";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { servers, sessions, userPreferences } from "@/lib/db/schema";
import {
  cleanupAllEmptyGroups,
  createGroupWithFirstMember,
  GroupConstraintError,
  listGroups,
} from "@/lib/groups";
import { listSessions } from "@/lib/ssh/session-manager";
import { broadcastToAll } from "@/lib/ws";

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await cleanupAllEmptyGroups();
  const [groups, serverRows, sessionRows, prefRows] = await Promise.all([
    listGroups(),
    db
      .select({
        id: servers.id,
        name: servers.name,
        host: servers.host,
        username: servers.username,
      })
      .from(servers),
    // All live sessions across every server, so `managet ls` can list
    // standalone terminals living on *other* hosts (the local agent only
    // knows its own). Closed sessions are dropped — they'd be noise.
    db
      .select({
        id: sessions.id,
        serverId: sessions.serverId,
        sessionName: sessions.sessionName,
        status: sessions.status,
        groupId: sessions.groupId,
      })
      .from(sessions)
      .where(ne(sessions.status, "closed")),
    db
      .select({ groupViewServerLabel: userPreferences.groupViewServerLabel })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1),
  ]);

  const groupViewServerLabel =
    prefRows[0]?.groupViewServerLabel === "name" ? "name" : "host";

  // Live attached-client counts per session, asked of each agent. The DB
  // doesn't persist attach state (it's a property of who's connected right
  // now), so `managet ls` can only show attached/detached if we look it up
  // live. Best-effort and parallel: an unreachable agent contributes
  // nothing, so its sessions get `attachedClients: null` (= unknown) rather
  // than failing the whole listing.
  const liveLists = await Promise.allSettled(
    serverRows.map((sv) => listSessions(sv.id))
  );
  const attachCount = new Map<string, number>();
  for (const res of liveLists) {
    if (res.status === "fulfilled") {
      for (const s of res.value) attachCount.set(s.id, s.attached_clients);
    }
  }
  const attachedOf = (id: string): number | null =>
    attachCount.has(id) ? attachCount.get(id)! : null;

  const sessionsOut = sessionRows.map((s) => ({
    ...s,
    attachedClients: attachedOf(s.id),
  }));
  const groupsOut = groups.map((g) => ({
    ...g,
    members: g.members.map((m) => ({
      ...m,
      attachedClients: attachedOf(m.id),
    })),
  }));

  return NextResponse.json({
    data: {
      groups: groupsOut,
      servers: serverRows,
      sessions: sessionsOut,
      preferences: { groupViewServerLabel },
    },
  });
}

const createBodySchema = z.object({
  name: z.string().min(1),
  sessionId: z.string().min(1),
});

/**
 * POST /api/cli/groups — create a new group seeded with one existing
 * session. Used by the solo-attach Ctrl-A G "create new group" flow.
 * Body: { name, sessionId }.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    /* fall through to validation error */
  }
  const parsed = createBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  try {
    const group = await createGroupWithFirstMember({
      name: parsed.data.name,
      sessionId: parsed.data.sessionId,
      createdBy: userId,
    });
    broadcastToAll({ type: "group:changed", groupId: group.id });
    return NextResponse.json({ data: group }, { status: 201 });
  } catch (err) {
    if (err instanceof GroupConstraintError) {
      const status = err.code === "session_not_found" ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
