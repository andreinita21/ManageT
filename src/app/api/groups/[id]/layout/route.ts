/**
 * GET /api/groups/[id]/layout — fetch the calling user's persisted mosaic
 *   layout for this group. Returns `{ data: null }` when none stored yet
 *   (the UI then falls back to the default equal-split layout).
 *
 * PUT /api/groups/[id]/layout — upsert. Body matches `GroupLayout`.
 *
 * Layout is per-user (not shared) because drag-resize feels personal —
 * one person's preferred split shouldn't override another's view.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { getUserLayout, saveUserLayout } from "@/lib/groups";

const layoutSchema = z.object({
  rowHeights: z.array(z.number()).min(1).max(2),
  colWidthsByRow: z.array(z.array(z.number()).min(1).max(3)).min(1).max(2),
  // Map sessionId → font-size override. Bounded to keep an editor from
  // landing on a 200pt monstrosity that breaks layout entirely.
  fontSizeBySession: z
    .record(z.string(), z.number().int().min(6).max(40))
    .optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const layout = await getUserLayout(session.user.id, id);
  return NextResponse.json({ data: layout });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
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
  await saveUserLayout(session.user.id, id, parsed.data);
  return NextResponse.json({ ok: true });
}
