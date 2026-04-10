/**
 * API routes for individual session operations.
 * GET /api/sessions/[id] — get session details
 * PUT /api/sessions/[id] — update session (restartPolicy, status)
 * DELETE /api/sessions/[id] — kill the session and remove it
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { sessionManager } from "@/lib/ssh/session-manager";
import type { Session } from "@/types";

const updateSessionSchema = z.object({
  restartPolicy: z.enum(["auto", "ask", "never"]).optional(),
  status: z
    .enum(["active", "disconnected", "reconnecting", "recovering", "closed"])
    .optional(),
});

function rowToSession(r: typeof sessions.$inferSelect): Session {
  return {
    ...r,
    status: r.status as Session["status"],
    restartPolicy: r.restartPolicy as Session["restartPolicy"],
    cwd: r.cwd ?? undefined,
    lastCommand: r.lastCommand ?? undefined,
    envSnapshot: r.envSnapshot
      ? (JSON.parse(r.envSnapshot) as Record<string, string>)
      : undefined,
    scrollBufferTail: r.scrollBufferTail ?? undefined,
    disconnectedAt: r.disconnectedAt ?? undefined,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({ data: rowToSession(rows[0]) });
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

  const parsed = updateSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const existing = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const input = parsed.data;
  const updates: Record<string, unknown> = { updatedAt: Date.now() };

  if (input.restartPolicy !== undefined) updates.restartPolicy = input.restartPolicy;
  if (input.status !== undefined) updates.status = input.status;

  await db.update(sessions).set(updates).where(eq(sessions.id, id));

  const updated = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return NextResponse.json({ data: rowToSession(updated[0]) });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // killSession ends the SSH stream, drops the in-memory snapshot, and
  // marks the row as "closed". Calling it on an unknown session is a no-op.
  try {
    await sessionManager.killSession(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Drop the row entirely. The session is gone — no reason to keep a tombstone
  // around to clutter the sessions list.
  await db.delete(sessions).where(eq(sessions.id, id));

  return NextResponse.json({ ok: true });
}
