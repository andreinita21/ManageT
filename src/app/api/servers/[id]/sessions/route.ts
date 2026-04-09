/**
 * API route for listing sessions associated with a server.
 * GET /api/servers/[id]/sessions — list sessions for a server
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessions, servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { Session } from "@/types";

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

  const rows = await db.select().from(sessions).where(eq(sessions.serverId, id));

  const data: Session[] = rows.map((r) => ({
    ...r,
    status: r.status as Session["status"],
    restartPolicy: r.restartPolicy as Session["restartPolicy"],
    cwd: r.cwd ?? undefined,
    lastCommand: r.lastCommand ?? undefined,
    envSnapshot: r.envSnapshot ? (JSON.parse(r.envSnapshot) as Record<string, string>) : undefined,
    scrollBufferTail: r.scrollBufferTail ?? undefined,
    disconnectedAt: r.disconnectedAt ?? undefined,
  }));

  return NextResponse.json({ data });
}
