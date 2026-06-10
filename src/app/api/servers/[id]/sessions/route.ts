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
import { and, eq, ne } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guard";
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
  // Spawning a session runs a shell on the host via the agent — operator+.
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;
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
      .select({
        username: servers.username,
        maxSessions: servers.maxSessions,
        agentStatus: servers.agentStatus,
      })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    const username = serverRows[0]?.username;
    const maxSessions = serverRows[0]?.maxSessions ?? null;
    const agentStatus = serverRows[0]?.agentStatus;

    // Refuse on operator-stopped or pre-/post-deploy states so the
    // REST path matches the WS path's gate. The UI also disables the
    // "+ New terminal" affordance based on the same status, but the
    // server-side check is the authoritative one (handles a stale
    // page or an external API caller).
    if (agentStatus === "manually_stopped") {
      return NextResponse.json(
        {
          error:
            "This server is temporarily not accessible because the " +
            "`managet stop` command was issued. Run `managet start` " +
            "on the host to resume.",
        },
        { status: 409 }
      );
    }
    if (
      agentStatus === "not_installed" ||
      agentStatus === "installing" ||
      agentStatus === "install_failed" ||
      agentStatus === "uninstalling" ||
      agentStatus === "uninstall_failed"
    ) {
      return NextResponse.json(
        {
          error: `Agent is currently '${agentStatus}'; cannot create sessions until it's healthy.`,
        },
        { status: 409 }
      );
    }

    // Per-server session cap (Settings → server → Agent settings).
    // Counts every row that isn't `closed` — active, disconnected,
    // reconnecting, recovering — so a paused-but-resumable session
    // still occupies a slot. NULL means no cap.
    if (maxSessions != null) {
      const live = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(eq(sessions.serverId, serverId), ne(sessions.status, "closed"))
        );
      if (live.length >= maxSessions) {
        return NextResponse.json(
          {
            error: `This server has reached its max-sessions cap (${maxSessions}). Close an existing session or raise the cap in Settings → Servers.`,
          },
          { status: 409 }
        );
      }
    }

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
