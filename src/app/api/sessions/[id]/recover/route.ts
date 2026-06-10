/**
 * API route for manual session recovery.
 * POST /api/sessions/[id]/recover — trigger manual recovery (placeholder)
 */
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;

  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Placeholder: recovery logic will be implemented by the session agent
  return NextResponse.json(
    { error: "Session recovery is not yet implemented" },
    { status: 501 }
  );
}
