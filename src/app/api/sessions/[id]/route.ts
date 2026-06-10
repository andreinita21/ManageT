/**
 * API routes for individual session operations.
 * GET /api/sessions/[id] — get session details
 * PUT /api/sessions/[id] — update session (restartPolicy, status, sessionName)
 * DELETE /api/sessions/[id] — kill the session and remove it
 */
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { rowToSession } from "@/lib/db/transform";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { killSession, renameSession } from "@/lib/ssh/session-manager";

const updateSessionSchema = z.object({
  restartPolicy: z.enum(["auto", "ask", "never"]).optional(),
  status: z
    .enum(["active", "disconnected", "reconnecting", "recovering", "closed"])
    .optional(),
  // Display name for the session — surfaces in /sessions, /terminal
  // tabs, group mosaic bars, etc. Bounded to keep table cells readable.
  // We don't touch the agent's view of the PTY: the rename is purely a
  // dashboard-side label.
  sessionName: z.string().trim().min(1).max(80).optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireRole("viewer");
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

  return NextResponse.json({ data: rowToSession(rows[0]) });
}

export async function PUT(
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
  if (input.sessionName !== undefined) updates.sessionName = input.sessionName;

  // Sync the session name to the agent BEFORE writing the DB. If the
  // agent rejects (e.g. older binary without rename op), we want the
  // dashboard's name to stay identical to what `managet ls` / `managet
  // attach <name>` reports on the host — that's the entire point of
  // the round-trip — so the DB write only happens if the agent
  // accepted or the row is already stale (agent never knew about it).
  if (
    input.sessionName !== undefined &&
    input.sessionName !== existing[0].sessionName
  ) {
    const outcome = await renameSession(
      existing[0].serverId,
      id,
      input.sessionName
    );
    if (outcome.kind === "agent_rejected") {
      return NextResponse.json(
        {
          error:
            "Agent refused the rename — likely an older agent binary without the `rename` op. Redeploy the agent and try again.",
          detail: outcome.message,
        },
        { status: 502 }
      );
    }
    // `pushed` and `stale` both fall through to the DB update. Stale
    // sessions get reconciled to `closed` on the next /sessions read,
    // and renaming a row that's about to be closed is harmless.
  }

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
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;

  // Look up the server id so we know which agent to talk to.
  const rows = await db
    .select({ serverId: sessions.serverId })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ ok: true });
  }
  try {
    await killSession(rows[0].serverId, id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
