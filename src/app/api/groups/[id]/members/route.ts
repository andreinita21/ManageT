/**
 * POST /api/groups/[id]/members — add an existing session to a group.
 *                                  Body: { sessionId }
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/guard";
import { addMember, GroupConstraintError } from "@/lib/groups";

const addSchema = z.object({ sessionId: z.string().min(1) });

export async function POST(
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
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }
  try {
    const group = await addMember(id, parsed.data.sessionId);
    return NextResponse.json({ data: group });
  } catch (err) {
    if (err instanceof GroupConstraintError) {
      const status = err.code === "session_not_found" ? 404 : 400;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status }
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
