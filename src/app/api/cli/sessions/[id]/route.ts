/**
 * DELETE /api/cli/sessions/[id]
 *
 * CLI-auth twin of the browser DELETE at /api/sessions/[id]. SIGTERMs
 * the agent-side PTY. The session reconciler will mark the row `closed`
 * on its next pass (within ~60 s), or sooner when a poll fires; if the
 * session was a group member, we also broadcast `group:changed` so
 * every open group view refetches immediately and the dead pane is
 * dropped without a manual reload.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { killSession } from "@/lib/ssh/session-manager";
import { broadcastToAll } from "@/lib/ws";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const rows = await db
    .select({ serverId: sessions.serverId, groupId: sessions.groupId })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ ok: true });
  }
  const { serverId, groupId } = rows[0];

  try {
    await killSession(serverId, id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  if (groupId) {
    broadcastToAll({ type: "group:changed", groupId });
  }
  return NextResponse.json({ ok: true });
}
