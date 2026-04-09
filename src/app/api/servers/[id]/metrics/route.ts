/**
 * API route for server metric snapshots.
 * GET /api/servers/[id]/metrics — query metrics with optional ?from=&to= filters
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { metricSnapshots, servers } from "@/lib/db/schema";
import { eq, and, gte, lte } from "drizzle-orm";

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

  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const conditions = [eq(metricSnapshots.serverId, id)];

  if (fromParam) {
    const fromTs = parseInt(fromParam, 10);
    if (!isNaN(fromTs)) {
      conditions.push(gte(metricSnapshots.capturedAt, fromTs));
    }
  }

  if (toParam) {
    const toTs = parseInt(toParam, 10);
    if (!isNaN(toTs)) {
      conditions.push(lte(metricSnapshots.capturedAt, toTs));
    }
  }

  const rows = await db
    .select()
    .from(metricSnapshots)
    .where(and(...conditions));

  return NextResponse.json({ data: rows });
}
