/**
 * API route for server metric snapshots.
 * GET /api/servers/[id]/metrics — bucket-aggregated graph data for the
 * server detail page.
 *
 * Query params:
 *   range = 1h | 6h | 24h        (default: 1h)
 *   from, to = epoch-ms          (override range; for ad-hoc zooms)
 *
 * The actual bucket-aggregation SQL lives in
 * `src/lib/monitor/metrics-buckets.ts` so the server-rendered detail
 * page can call it directly without a round-trip through this route.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  defaultMetricsWindow,
  fetchMetricBuckets,
  parseMetricsRange,
} from "@/lib/monitor/metrics-buckets";

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
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  if (serverRows.length === 0) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const range = parseMetricsRange(url.searchParams.get("range"));
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  let { from, to } = defaultMetricsWindow(range);
  if (fromParam) {
    const parsed = parseInt(fromParam, 10);
    if (!isNaN(parsed)) from = parsed;
  }
  if (toParam) {
    const parsed = parseInt(toParam, 10);
    if (!isNaN(parsed)) to = parsed;
  }

  const rows = await fetchMetricBuckets(id, range, from, to);

  return NextResponse.json(
    { data: rows },
    {
      headers: {
        "Cache-Control": "private, max-age=10, stale-while-revalidate=30",
      },
    }
  );
}
