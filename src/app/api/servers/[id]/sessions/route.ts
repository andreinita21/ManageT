/**
 * GET  /api/servers/[id]/sessions — list sessions for a server.
 *   The dashboard reconciles its DB cache against the agent's authoritative
 *   list before returning, so sessions started locally via `managet new`
 *   on the host show up here too.
 *
 * POST /api/servers/[id]/sessions — create a session via the agent.
 *   Body: { command?: string, name?: string, rows?: number, cols?: number }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessions, servers } from "@/lib/db/schema";
import { createSession, reconcileServer } from "@/lib/ssh/session-manager";
import type { Session } from "@/types";

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
    stackId: r.stackId ?? undefined,
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
  const serverRows = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  if (serverRows.length === 0) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
  // Best-effort reconcile. If the agent is down we fall back to whatever the
  // DB has (already handled inside reconcileServer).
  const merged = await reconcileServer(id);
  return NextResponse.json({ data: merged });
}

const createBody = z.object({
  command: z.string().optional(),
  name: z.string().optional(),
  rows: z.number().int().positive().optional(),
  cols: z.number().int().positive().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: serverId } = await params;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine */
  }
  const parsed = createBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }
  try {
    const created = await createSession(serverId, parsed.data);
    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, created.sessionId))
      .limit(1);
    return NextResponse.json({ data: rowToSession(rows[0]) }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
