/**
 * POST /api/agent/session-created
 *
 * Fired by the agent the instant it spawns a PTY (e.g. `managet new` run
 * directly on a server), so the session shows up in the dashboard within a
 * beat instead of waiting up to ~60s for the session reconciler. Auth is the
 * per-server agent bearer token (same as the heartbeat). Idempotent: inserts
 * the row only if absent — the reconciler still backstops everything.
 *
 * Body: { sessionId, name?, command?, cwd?, status? }
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { authenticateAgent } from "@/lib/agent/auth";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { broadcastToAll } from "@/lib/ws";

export async function POST(request: Request) {
  const server = await authenticateAgent(request);
  if (!server) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    sessionId?: unknown;
    name?: unknown;
    command?: unknown;
    cwd?: unknown;
    status?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }
  const name =
    typeof body.name === "string" && body.name.length > 0
      ? body.name
      : `session-${sessionId.slice(0, 8)}`;
  const command = typeof body.command === "string" ? body.command : null;
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const status = body.status === "closed" ? "closed" : "active";

  const existing = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const now = Date.now();
  if (existing.length === 0) {
    await db.insert(sessions).values({
      id: sessionId,
      serverId: server.id,
      sessionName: name,
      status,
      cwd,
      lastCommand: command,
      envSnapshot: null,
      scrollBufferTail: null,
      restartPolicy: "ask",
      retryCount: 0,
      stackId: null,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    // Already known (e.g. created via the dashboard) — just refresh status.
    await db
      .update(sessions)
      .set({ status, updatedAt: now })
      .where(eq(sessions.id, sessionId));
  }

  // Nudge any open dashboard tabs to refetch their session lists.
  broadcastToAll({ type: "sessions:changed", serverId: server.id });

  return NextResponse.json({ data: { ok: true } });
}
