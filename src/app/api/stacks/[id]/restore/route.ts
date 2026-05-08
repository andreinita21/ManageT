/**
 * POST /api/stacks/[id]/restore — pull a soft-deleted stack out of the
 * Trash by clearing `deletedAt`. 404 if the stack has been hard-deleted
 * (force=true on DELETE) or never existed; 200 if it was already live.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { stacks } from "@/lib/db/schema";
import { getStack } from "@/lib/stacks";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const existing = await db
    .select()
    .from(stacks)
    .where(eq(stacks.id, id))
    .limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Stack not found" }, { status: 404 });
  }
  const now = Date.now();
  await db
    .update(stacks)
    .set({ deletedAt: null, updatedAt: now })
    .where(eq(stacks.id, id));
  const refreshed = await getStack(id);
  return NextResponse.json({ data: refreshed });
}
