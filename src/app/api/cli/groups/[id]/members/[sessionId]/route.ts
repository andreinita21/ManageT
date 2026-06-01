/**
 * DELETE /api/cli/groups/[id]/members/[sessionId]
 *
 * CLI-auth twin of the browser route at /api/groups/[id]/members/[sessionId].
 * Detaches the session from the group without killing the shell — the
 * remote PTY keeps running and the session row stays in `sessions`,
 * just with `groupId` cleared. Auto-deletes the group if its last
 * member just left; the response carries `groupDeleted: true` so the
 * CLI can exit the group view cleanly.
 */
import { NextResponse } from "next/server";

import { requireCliUserId } from "@/lib/cli-auth";
import { GroupConstraintError, removeMember } from "@/lib/groups";
import { broadcastToAll } from "@/lib/ws";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, sessionId } = await params;
  try {
    const group = await removeMember(id, sessionId);
    broadcastToAll({ type: "group:changed", groupId: id });
    return NextResponse.json({
      data: group,
      groupDeleted: group === null,
    });
  } catch (err) {
    if (err instanceof GroupConstraintError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 400 }
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
