/**
 * Shared bucket-aggregation query for server metric snapshots. Used by
 * both the GET /api/servers/[id]/metrics API route and the server
 * component that pre-renders the server detail page. Wrapped in
 * `unstable_cache` so repeated calls within the TTL skip the DB.
 */
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { metricSnapshots } from "@/lib/db/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";

export type MetricsRange = "1h" | "6h" | "24h";

interface RangeSpec {
  windowMs: number;
  bucketMs: number;
}

// Each range targets ~60 buckets so charts stay readable without
// dragging thousands of rows over the wire.
export const METRICS_RANGES: Record<MetricsRange, RangeSpec> = {
  "1h": { windowMs: 60 * 60 * 1000, bucketMs: 60 * 1000 },
  "6h": { windowMs: 6 * 60 * 60 * 1000, bucketMs: 6 * 60 * 1000 },
  "24h": { windowMs: 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 1000 },
};

export function parseMetricsRange(value: string | null | undefined): MetricsRange {
  return value === "6h" || value === "24h" ? value : "1h";
}

export interface BucketedMetric {
  id: string;
  serverId: string;
  capturedAt: number;
  cpuPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  diskUsedPercent: number | null;
  load1m: number | null;
  load5m: number | null;
  load15m: number | null;
  activeConnections: number | null;
}

export function fetchMetricBuckets(
  serverId: string,
  range: MetricsRange,
  from: number,
  to: number
) {
  const { bucketMs } = METRICS_RANGES[range];
  return unstable_cache(
    async (): Promise<BucketedMetric[]> => {
      const rows = await db
        .select({
          capturedAt: sql<number>`(${metricSnapshots.capturedAt} / ${bucketMs}) * ${bucketMs}`.as(
            "captured_at"
          ),
          cpuPercent: sql<number | null>`AVG(${metricSnapshots.cpuPercent})`.as("cpu_percent"),
          memoryUsedMb: sql<number | null>`CAST(AVG(${metricSnapshots.memoryUsedMb}) AS INTEGER)`.as(
            "memory_used_mb"
          ),
          memoryTotalMb: sql<number | null>`CAST(AVG(${metricSnapshots.memoryTotalMb}) AS INTEGER)`.as(
            "memory_total_mb"
          ),
          diskUsedPercent: sql<number | null>`AVG(${metricSnapshots.diskUsedPercent})`.as(
            "disk_used_percent"
          ),
          load1m: sql<number | null>`AVG(${metricSnapshots.load1m})`.as("load_1m"),
          load5m: sql<number | null>`AVG(${metricSnapshots.load5m})`.as("load_5m"),
          load15m: sql<number | null>`AVG(${metricSnapshots.load15m})`.as("load_15m"),
          activeConnections: sql<number | null>`CAST(AVG(${metricSnapshots.activeConnections}) AS INTEGER)`.as(
            "active_connections"
          ),
        })
        .from(metricSnapshots)
        .where(
          and(
            eq(metricSnapshots.serverId, serverId),
            gte(metricSnapshots.capturedAt, from),
            lte(metricSnapshots.capturedAt, to)
          )
        )
        .groupBy(sql`${metricSnapshots.capturedAt} / ${bucketMs}`)
        .orderBy(sql`${metricSnapshots.capturedAt} / ${bucketMs}`)
        .limit(120);

      return rows.map((r) => ({
        id: `${serverId}-${r.capturedAt}`,
        serverId,
        capturedAt: r.capturedAt,
        cpuPercent: r.cpuPercent,
        memoryUsedMb: r.memoryUsedMb,
        memoryTotalMb: r.memoryTotalMb,
        diskUsedPercent: r.diskUsedPercent,
        load1m: r.load1m,
        load5m: r.load5m,
        load15m: r.load15m,
        activeConnections: r.activeConnections,
      }));
    },
    ["server-metrics", serverId, range, String(from), String(to)],
    { revalidate: 15 }
  )();
}

/**
 * Resolves the (from, to) window for a range. Snaps `to` to the nearest
 * 15s tick so two visits within the same tick hit the same cache key.
 */
export function defaultMetricsWindow(range: MetricsRange): { from: number; to: number } {
  const now = Math.floor(Date.now() / 15000) * 15000;
  const { windowMs } = METRICS_RANGES[range];
  return { from: now - windowMs, to: now };
}
