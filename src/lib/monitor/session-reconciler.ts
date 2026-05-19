/**
 * Background session reconciler.
 *
 * Every `RECONCILE_INTERVAL_MS`, for each server whose agent recently
 * responded, ask the agent for its session list and compare with the
 * `sessions` table:
 *
 *   - Agent session not in DB → INSERT a row (status: "active" if the
 *     shell is still running, "closed" if it has exited). The user
 *     then sees the session in the UI and can choose to attach or
 *     kill it. This is what re-imports sessions created via `managet
 *     new` directly on the host, and what surfaces "orphans" if the
 *     dashboard ever loses track (e.g. dashboard restart between an
 *     agent kill request and the DB delete).
 *
 *   - DB session not in agent → mark the row as "closed". This catches
 *     sessions whose shell exited (via the user typing `exit`, a
 *     command crash, or external kill) so the UI stops showing them
 *     as live.
 *
 * The reconciler never *kills* sessions on its own — that would be too
 * aggressive given that `managet new` is a supported workflow on the
 * host. Killing remains an explicit user action.
 *
 * Designed to be cheap: list responses come back in single-digit ms
 * over the existing SSH connection pool, and we batch the DB writes
 * inside `reconcileServer` itself.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { reconcileServer } from "@/lib/ssh/session-manager";

/**
 * 60 seconds is a balance between "user sees fresh state quickly after
 * doing CLI work on the host" and "we don't spam the agent every few
 * seconds." Bump down to 15–30s if real-time is needed; bump up to 5
 * minutes on heavily-loaded hosts.
 */
const RECONCILE_INTERVAL_MS = 60_000;

/**
 * Skip reconcile for servers that haven't sent a heartbeat in this
 * long. We'd hit SSH timeouts otherwise, which is wasted work.
 */
const STALE_HEARTBEAT_MS = 120_000;

let timer: NodeJS.Timeout | null = null;

async function reconcileOnce(): Promise<void> {
  const rows = await db.select().from(servers);
  const now = Date.now();
  for (const row of rows) {
    // Only touch hosts we know are alive. The agent status monitor
    // flips `agentStatus` to "unreachable" after STALE_HEARTBEAT_MS,
    // but heartbeats can also be momentarily late — gate on the
    // actual heartbeat timestamp.
    const lastHb = row.agentLastHeartbeatAt;
    if (lastHb == null || now - lastHb > STALE_HEARTBEAT_MS) continue;
    try {
      await reconcileServer(row.id);
    } catch (err) {
      // reconcileServer already swallows agent-unreachable failures
      // and returns DB-only state, so a throw here is something
      // unexpected. Log and continue — one bad server shouldn't
      // block the rest.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[session-reconciler] ${row.name} (${row.host}) failed: ${msg}`
      );
    }
  }
}

export function startSessionReconciler(): void {
  if (timer) return;
  // First run after a short startup delay so we don't pile onto the
  // dashboard's boot-time work (agent-status sweep, alert-engine
  // subscription, etc.).
  timer = setTimeout(function tick() {
    reconcileOnce()
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[session-reconciler] reconcileOnce: ${msg}`);
      })
      .finally(() => {
        timer = setTimeout(tick, RECONCILE_INTERVAL_MS);
      });
  }, 10_000);
}

export function stopSessionReconciler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Exposed for tests / manual triggering (e.g. an admin API). */
export { reconcileOnce };

// Suppress an unused-warning hint from drizzle helpers we may want
// for future extensions of this file. `eq` is kept because the
// natural next change is filtering rows by id; remove if you
// genuinely don't need it.
void eq;
