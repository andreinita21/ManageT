/**
 * POST /api/cli/groups/[id]/members
 *
 * CLI-auth variant of the browser route. Unlike the browser version,
 * which only links an *existing* session into a group, this one creates
 * the session on the chosen server first and then links it — that's the
 * one-shot flow the `managet group add` picker needs (browser uses two
 * separate REST calls).
 *
 * Body: { serverId: string, name?: string, command?: string }
 * Returns: { session, group }
 */
import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { sessions, servers } from "@/lib/db/schema";
import { rowToSession } from "@/lib/db/transform";
import { addMember, GroupConstraintError } from "@/lib/groups";
import { createSession } from "@/lib/ssh/session-manager";
import { broadcastToAll } from "@/lib/ws";

const bodySchema = z.object({
  serverId: z.string().min(1),
  name: z.string().optional(),
  command: z.string().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: groupId } = await params;

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    /* empty body is fine */
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }
  const { serverId, name, command } = parsed.data;

  // Mirror the gating logic of POST /api/servers/[id]/sessions: refuse
  // if the agent is stopped/installing, and honor the per-server
  // session cap. Keeping the two paths in sync means the CLI picker
  // and the browser "+ New terminal" affordance fail the same way.
  const serverRows = await db
    .select({
      username: servers.username,
      maxSessions: servers.maxSessions,
      agentStatus: servers.agentStatus,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (serverRows.length === 0) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
  const { username, maxSessions, agentStatus } = serverRows[0];

  if (agentStatus === "manually_stopped") {
    return NextResponse.json(
      {
        error:
          "This server is temporarily not accessible because `managet stop` " +
          "was issued. Run `managet start` on the host to resume.",
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
          error: `This server has reached its max-sessions cap (${maxSessions}). Close an existing session or raise the cap.`,
        },
        { status: 409 }
      );
    }
  }

  try {
    const created = await createSession(serverId, {
      name,
      command,
      user: username,
    });
    const group = await addMember(groupId, created.sessionId);
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, created.sessionId))
      .limit(1);
    // Push to every connected WebSocket so any open browser tab
    // viewing this group (or its sessions list) refetches without the
    // user having to reload.
    broadcastToAll({ type: "group:changed", groupId });
    return NextResponse.json(
      { data: { session: rowToSession(sessionRows[0]), group } },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof GroupConstraintError) {
      const status = err.code === "session_not_found" ? 404 : 400;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status }
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
