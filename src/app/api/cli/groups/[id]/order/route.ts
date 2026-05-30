/**
 * PUT /api/cli/groups/[id]/order
 *
 * Persists terminal-side pane reordering into the same groupOrderIndex
 * ordering that the browser mosaic uses.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireCliUserId } from "@/lib/cli-auth";
import { GroupConstraintError, reorderMembers } from "@/lib/groups";

const orderSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).max(6),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const { id } = await params;
  try {
    const group = await reorderMembers(id, parsed.data.sessionIds);
    return NextResponse.json({ data: group });
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
