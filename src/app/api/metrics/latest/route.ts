/**
 * GET /api/metrics/latest
 *
 * Returns the latest metric snapshot per server, plus a short CPU history
 * (most recent ~5 minutes of samples) so the dashboard sparkline has data
 * to plot. Used by the dashboard grid to keep all ServerCards live without
 * issuing one request per server.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { metricSnapshots } from "@/lib/db/schema";
import { gte } from "drizzle-orm";

interface PerServerMetrics {
  cpuPercent?: number;
  cpuHistory: number[];
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  diskUsedPercent?: number;
  load1m?: number;
  capturedAt: number;
}

const WINDOW_MS = 5 * 60 * 1000; // last 5 minutes
const MAX_HISTORY = 30;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = Date.now() - WINDOW_MS;
  const rows = await db
    .select()
    .from(metricSnapshots)
    .where(gte(metricSnapshots.capturedAt, cutoff));

  // Sort once in JS rather than relying on a particular DB orderBy
  // implementation — the result set is small (one server × ~30 samples).
  rows.sort((a, b) => a.capturedAt - b.capturedAt);

  const data: Record<string, PerServerMetrics> = {};

  for (const row of rows) {
    const entry =
      data[row.serverId] ??
      (data[row.serverId] = {
        cpuHistory: [],
        capturedAt: 0,
      });

    if (row.cpuPercent != null) {
      entry.cpuHistory.push(row.cpuPercent);
      if (entry.cpuHistory.length > MAX_HISTORY) {
        entry.cpuHistory.splice(0, entry.cpuHistory.length - MAX_HISTORY);
      }
      entry.cpuPercent = row.cpuPercent;
    }
    if (row.memoryUsedMb != null) entry.memoryUsedMb = row.memoryUsedMb;
    if (row.memoryTotalMb != null) entry.memoryTotalMb = row.memoryTotalMb;
    if (row.diskUsedPercent != null) entry.diskUsedPercent = row.diskUsedPercent;
    if (row.load1m != null) entry.load1m = row.load1m;
    if (row.capturedAt > entry.capturedAt) entry.capturedAt = row.capturedAt;
  }

  return NextResponse.json({ data });
}
