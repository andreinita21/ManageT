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
import { rowToSession } from "@/lib/db/transform";
import { createSession, reconcileServer } from "@/lib/ssh/session-manager";

export async function GET(
  request: Request,
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
  // Drop rows the reconciler just marked as `closed` (orphans whose PTY
  // no longer exists on the agent) so callers don't see ghost sessions.
  // Matches the GET /api/sessions filter — both endpoints converge on
  // the same "currently live" view by default.
  const url = new URL(request.url);
  const includeClosed = url.searchParams.get("includeClosed") === "1";
  const data = includeClosed
    ? merged
    : merged.filter((s) => s.status !== "closed");
  return NextResponse.json({ data });
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
    // Mirror the WS session:create handler: look up the server's
    // configured Unix username so the agent spawns the shell as that
    // user instead of as itself (root, on hosts where the agent runs
    // as root). Without this the group-view "+ Add terminal" flow
    // landed users in a root shell — see the WS handler for the
    // original rationale.
    const serverRows = await db
      .select({ username: servers.username })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    const username = serverRows[0]?.username;

    const created = await createSession(serverId, {
      ...parsed.data,
      user: username,
    });
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
