/**
 * POST /api/stacks/[id]/stop — kill every session that was started by
 * this stack (matched via `sessions.stackId`).
 */
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guard";
import { stopStack } from "@/lib/stacks";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Stopping a stack kills sessions on hosts — operator+.
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  try {
    const result = await stopStack(id);
    return NextResponse.json({ data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
