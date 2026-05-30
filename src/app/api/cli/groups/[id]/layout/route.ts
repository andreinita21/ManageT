/**
 * PUT /api/cli/groups/[id]/layout
 *
 * Saves the same per-user GroupLayout payload used by the browser
 * mosaic, so CLI layout commands and browser drags stay in sync.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireCliUserId } from "@/lib/cli-auth";
import { saveUserLayout } from "@/lib/groups";
import { broadcastToAll } from "@/lib/ws";

const layoutSchema = z.object({
  rowHeights: z.array(z.number()).min(1).max(2),
  colWidthsByRow: z.array(z.array(z.number()).min(1).max(6)).min(1).max(2),
  rowPartition: z
    .array(z.number().int().min(1).max(6))
    .min(1)
    .max(2)
    .optional(),
  fontSizeBySession: z
    .record(z.string(), z.number().int().min(6).max(40))
    .optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const { id } = await params;
  await saveUserLayout(userId, id, parsed.data);
  broadcastToAll({ type: "group:changed", groupId: id });
  return NextResponse.json({ ok: true });
}
