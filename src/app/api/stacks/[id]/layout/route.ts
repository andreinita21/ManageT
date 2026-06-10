/**
 * GET/PUT /api/stacks/[id]/layout — the calling user's persisted mosaic
 * layout for a stack's terminals page. Browser twin of
 * /api/cli/stacks/[id]/layout (same storage, same shape); per-user like
 * group layouts because drag-resize is personal.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/auth/guard";
import { getUserStackLayout, saveUserStackLayout } from "@/lib/stacks";

// Same permissive schema as the CLI route: stacks can hold more than six
// services, so a row may carry many columns; still capped at two rows.
const layoutSchema = z.object({
  rowHeights: z.array(z.number()).min(1).max(2),
  colWidthsByRow: z.array(z.array(z.number()).min(1).max(16)).min(1).max(2),
  rowPartition: z.array(z.number().int().min(1).max(16)).min(1).max(2).optional(),
  fontSizeBySession: z
    .record(z.string(), z.number().int().min(6).max(40))
    .optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  const layout = await getUserStackLayout(gate.id, id);
  return NextResponse.json({ data: layout });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) return gate;

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
  await saveUserStackLayout(gate.id, id, parsed.data);
  return NextResponse.json({ ok: true });
}
