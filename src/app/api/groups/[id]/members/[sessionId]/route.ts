/**
 * DELETE /api/groups/[id]/members/[sessionId] — detach a session from the
 *   group without killing the shell. The group is auto-deleted if its last
 *   member just left; the response carries `{ data: null, groupDeleted: true }`
 *   in that case so the UI can navigate away.
 */
import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/guard";
import { GroupConstraintError, removeMember } from "@/lib/groups";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;
  const { id, sessionId } = await params;
  try {
    const group = await removeMember(id, sessionId);
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
