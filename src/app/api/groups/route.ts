/**
 * GET  /api/groups   — list every group with its ordered members.
 * POST /api/groups   — create a new group with a single starting member.
 *                       Body: { name, sessionId }
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guard";
import {
  cleanupAllEmptyGroups,
  createGroupWithFirstMember,
  GroupConstraintError,
  listGroups,
} from "@/lib/groups";

const createSchema = z.object({
  name: z.string().min(1),
  sessionId: z.string().min(1),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Opportunistically sweep groups whose last live member has gone
  // (all-closed or truly empty) so orphans don't linger in the list.
  await cleanupAllEmptyGroups();
  const data = await listGroups();
  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }
  try {
    const group = await createGroupWithFirstMember({
      name: parsed.data.name,
      sessionId: parsed.data.sessionId,
      createdBy: gate.id,
    });
    return NextResponse.json({ data: group }, { status: 201 });
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
