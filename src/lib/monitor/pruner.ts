/**
 * @file pruner.ts — Time-based metric retention and down-sampling.
 *
 * Runs on a 1-hour interval and enforces the following retention policy:
 *
 *   - Last 24 hours  : keep every sample
 *   - 24 h – 7 days  : keep one sample per minute (delete the rest)
 *   - 7 d – 30 days  : keep one sample per 15 minutes
 *   - Older than 30 d: delete entirely
 */

import { and, lt, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { metricSnapshots, alerts } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_HOUR = 60 * 60 * 1_000;
const ONE_DAY = 24 * ONE_HOUR;
const SEVEN_DAYS = 7 * ONE_DAY;
const THIRTY_DAYS = 30 * ONE_DAY;
const ONE_MINUTE = 60 * 1_000;
const FIFTEEN_MINUTES = 15 * ONE_MINUTE;
const PRUNE_INTERVAL = ONE_HOUR;

// ---------------------------------------------------------------------------
// MetricPruner
// ---------------------------------------------------------------------------

let pruneTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Execute a single pruning pass.
 *
 * This function is exported so callers can trigger an immediate prune
 * (useful in tests) without waiting for the next interval tick.
 */
async function pruneOnce(): Promise<void> {
  const now = Date.now();

  // 1. Delete everything older than 30 days
  await db
    .delete(metricSnapshots)
    .where(lt(metricSnapshots.capturedAt, now - THIRTY_DAYS));

  // 2. Down-sample 7d – 30d window to one per 15 minutes
  await downsample(now - THIRTY_DAYS, now - SEVEN_DAYS, FIFTEEN_MINUTES);

  // 3. Down-sample 24h – 7d window to one per minute
  await downsample(now - SEVEN_DAYS, now - ONE_DAY, ONE_MINUTE);

  // 4. Prune old alerts. The alerts table had no retention at all, so it
  //    grew unbounded (especially before edge-triggered alerting). Keep the
  //    same 30-day horizon as metrics.
  await db.delete(alerts).where(lt(alerts.triggeredAt, now - THIRTY_DAYS));
}

/**
 * Within the time window [start, end) keep only the oldest row per
 * bucket of `bucketMs` milliseconds and delete the rest.
 */
async function downsample(
  start: number,
  end: number,
  bucketMs: number,
): Promise<void> {
  // We use a raw SQL approach because Drizzle's query builder
  // doesn't directly support "delete duplicates within buckets".
  //
  // Strategy:
  //   - For each row in the window compute a bucket key
  //     (capturedAt / bucketMs rounded down).
  //   - For each (serverId, bucket) keep the earliest-inserted row and
  //     delete the rest.
  //
  // We key the survivor on MIN(rowid), not MIN(id): `id` is a random UUID
  // text column, so MIN(id) keeps a lexicographically-random row rather than
  // the oldest. SQLite's implicit integer `rowid` is monotonic with insertion
  // order, which is the "earliest sample in the bucket" we actually want.

  await db.run(sql`
    DELETE FROM metric_snapshots
    WHERE captured_at >= ${start}
      AND captured_at < ${end}
      AND rowid NOT IN (
        SELECT MIN(rowid)
        FROM metric_snapshots
        WHERE captured_at >= ${start}
          AND captured_at < ${end}
        GROUP BY server_id, (captured_at / ${bucketMs})
      )
  `);
}

/**
 * Start the background pruning timer.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
function startPruner(): void {
  if (pruneTimer !== null) return;

  // Run once immediately, then every hour. A rejected prune (locked DB,
  // disk error) must not become an unhandled rejection that crashes the
  // process — log it and let the next interval retry.
  const runPrune = () => {
    void pruneOnce().catch((err) => {
      console.error("[pruner] pruneOnce failed:", err);
    });
  };

  runPrune();

  pruneTimer = setInterval(runPrune, PRUNE_INTERVAL);
  // Don't let the prune timer keep the event loop alive on shutdown.
  pruneTimer.unref?.();
}

/**
 * Stop the background pruning timer.
 */
function stopPruner(): void {
  if (pruneTimer === null) return;
  clearInterval(pruneTimer);
  pruneTimer = null;
}

export { startPruner, stopPruner, pruneOnce };
