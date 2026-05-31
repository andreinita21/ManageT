/**
 * GET /api/cli/groups/[id]
 *
 * Returns the group, the calling CLI user's saved layout, and minimal
 * server labels for rendering a terminal-side group view.
 */
import { NextResponse } from "next/server";
import { and, eq, isNull, ne, or } from "drizzle-orm";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { servers, sessions } from "@/lib/db/schema";
import { rowToSession } from "@/lib/db/transform";
import { getGroup, getUserLayout } from "@/lib/groups";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const group = await getGroup(id);
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const layout = await getUserLayout(userId, id);
  const serverRows = await db
    .select({
      id: servers.id,
      name: servers.name,
      host: servers.host,
      username: servers.username,
    })
    .from(servers);

  // Free standalone sessions eligible to be added to this group — not in a
  // stack, not in another group, still alive. Mirrors the browser group
  // page's freeSessions filter. Drives the Ctrl-A N "existing terminals"
  // picker section.
  const memberIds = new Set(group.members.map((m) => m.id));
  const freeRows = await db
    .select()
    .from(sessions)
    .where(
      and(
        isNull(sessions.stackId),
        or(isNull(sessions.groupId), eq(sessions.groupId, id)),
        ne(sessions.status, "closed")
      )
    );
  const freeSessions = freeRows
    .filter((s) => !memberIds.has(s.id))
    .map(rowToSession);

  return NextResponse.json({
    data: { group, layout, servers: serverRows, freeSessions },
  });
}
