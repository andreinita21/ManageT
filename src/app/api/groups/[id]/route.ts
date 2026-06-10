/**
 * GET    /api/groups/[id] — fetch one group with ordered members.
 * PATCH  /api/groups/[id] — rename. Body: { name }
 * DELETE /api/groups/[id] — hard-delete the group. Member sessions are
 *                            detached (FK is ON DELETE SET NULL) but
 *                            their shells keep running.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guard";
import {
  deleteGroup,
  getGroup,
  GroupConstraintError,
  renameGroup,
} from "@/lib/groups";

const patchSchema = z.object({ name: z.string().min(1).optional() });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const group = await getGroup(id);
  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }
  return NextResponse.json({ data: group });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }
  try {
    if (parsed.data.name !== undefined) {
      const updated = await renameGroup(id, parsed.data.name);
      if (!updated) {
        return NextResponse.json(
          { error: "Group not found" },
          { status: 404 }
        );
      }
      return NextResponse.json({ data: updated });
    }
    const current = await getGroup(id);
    if (!current) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }
    return NextResponse.json({ data: current });
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

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  await deleteGroup(id);
  return NextResponse.json({ ok: true });
}
