/**
 * POST /api/stacks/[id]/stop — kill every session that was started by
 * this stack (matched via `sessions.stackId`).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { stopStack } from "@/lib/stacks";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const result = await stopStack(id);
    return NextResponse.json({ data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
