/**
 * API route for listing all sessions across servers.
 * GET /api/sessions[?serverId=...][&includeClosed=1] — list sessions, optionally filtered.
 *
 * "Closed" rows are excluded by default. The session-reconciler marks rows
 * as `closed` when the agent no longer knows about the PTY (orphans), so
 * filtering them out here keeps the /sessions hub and the per-server
 * detail page consistent — both call this endpoint via `useSessions(...)`.
 * Pass `?includeClosed=1` for diagnostics / cleanup tooling that wants to
 * see the orphan rows themselves.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { rowToSession } from "@/lib/db/transform";
import { and, eq, ne } from "drizzle-orm";
import type { Session } from "@/types";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const serverId = url.searchParams.get("serverId");
  const includeClosed = url.searchParams.get("includeClosed") === "1";

  // Build the WHERE clause: always exclude `closed` unless explicitly
  // opted-in, optionally pin to a single server.
  const conds = [
    ...(includeClosed ? [] : [ne(sessions.status, "closed")]),
    ...(serverId ? [eq(sessions.serverId, serverId)] : []),
  ];
  const where = conds.length === 0
    ? undefined
    : conds.length === 1
    ? conds[0]
    : and(...conds);

  const rows = where
    ? await db.select().from(sessions).where(where)
    : await db.select().from(sessions);

  const data: Session[] = rows.map(rowToSession);
  return NextResponse.json({ data });
}
