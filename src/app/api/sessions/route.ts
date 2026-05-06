/**
 * API route for listing all sessions across servers.
 * GET /api/sessions[?serverId=...] — list sessions, optionally filtered.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const serverId = url.searchParams.get("serverId");

  const rows = serverId
    ? await db.select().from(sessions).where(eq(sessions.serverId, serverId))
    : await db.select().from(sessions);

  const data: Session[] = rows.map(rowToSession);
  return NextResponse.json({ data });
}
