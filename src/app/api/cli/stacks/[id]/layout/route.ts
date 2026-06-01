/**
 * GET/PUT /api/cli/stacks/[id]/layout
 *
 * Per-user persisted mosaic layout for a stack, used by the Rust CLI's
 * `managet stack open` resize mode (Ctrl-A R) so pane sizes survive across
 * sessions. Same JSON shape as the group layout endpoint. Unlike groups
 * there's no browser stack-mosaic to push to, so no WebSocket broadcast.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireCliUserId } from "@/lib/cli-auth";
import { getUserStackLayout, saveUserStackLayout } from "@/lib/stacks";

// More permissive than the group schema: a stack can have more than six
// services, so a row may hold many columns. Still capped at two rows to
// match the CLI's default partition.
const layoutSchema = z.object({
  rowHeights: z.array(z.number()).min(1).max(2),
  colWidthsByRow: z.array(z.array(z.number()).min(1).max(16)).min(1).max(2),
  rowPartition: z.array(z.number().int().min(1).max(16)).min(1).max(2).optional(),
  fontSizeBySession: z
    .record(z.string(), z.number().int().min(6).max(40))
    .optional(),
});

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
  const layout = await getUserStackLayout(userId, id);
  return NextResponse.json({ data: layout });
}

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
  await saveUserStackLayout(userId, id, parsed.data);
  return NextResponse.json({ ok: true });
}
