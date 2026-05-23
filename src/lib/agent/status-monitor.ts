/**
 * Agent status monitor.
 *
 * In the old (SSH-only) world, `servers.status` tracked the state of the
 * SSH client: it was "connected" while the dashboard had a live ssh2 client
 * and "disconnected"/"reconnecting" otherwise. That meant a perfectly
 * healthy production box would appear `unknown` whenever nobody had a
 * terminal open.
 *
 * In the new (agent-based) world, status is derived from how recently the
 * agent has phoned home. This module is a simple periodic sweeper that
 * flags servers as `unreachable` if no heartbeat has arrived for a while.
 * Transitions back to `healthy` are driven by the heartbeat route itself.
 */
import { and, eq, lt, not } from "drizzle-orm";

import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";

/** How often the sweeper runs. */
const SWEEP_INTERVAL_MS = 15_000;

/**
 * How long to tolerate missing heartbeats before flipping a server to
 * `unreachable`. The Rust agent sends a heartbeat every 10s by default, so
 * 30s = 3 missed cycles — enough tolerance for a momentary network blip
 * without being slow to notice real outages.
 */
const STALE_HEARTBEAT_MS = 30_000;

/**
 * After a successful SSH-push install, the installer leaves the row in
 * `agentStatus = 'installing'` with stage `awaiting first heartbeat` and
 * waits for the agent itself to confirm it's alive. If no heartbeat lands
 * within this window, something is wrong end-to-end (wrong dashboard URL
 * baked into config.toml, firewall blocking the callback, launchd unit
 * broken on macOS, agent crashed silently, etc.) and we surface a clear
 * `install_failed` so the user can hit Retry.
 */
const AWAITING_HEARTBEAT_TIMEOUT_MS = 60_000;
const AWAITING_HEARTBEAT_STAGE = "awaiting first heartbeat";

let timer: NodeJS.Timeout | null = null;

/**
 * Run one sweep:
 *   1. Healthy → Unreachable when no recent heartbeat.
 *   2. Installing/awaiting-heartbeat → install_failed when the post-install
 *      grace period elapses without a heartbeat.
 *
 * Also keeps the legacy `status` column in sync so UI components that read
 * `status` still render something sensible.
 */
export async function runStatusSweep(): Promise<void> {
  const now = Date.now();
  const staleCutoff = now - STALE_HEARTBEAT_MS;
  const awaitingCutoff = now - AWAITING_HEARTBEAT_TIMEOUT_MS;

  try {
    // Only flip rows whose last-known state was `healthy`. We
    // deliberately leave `manually_stopped` alone: the operator told
    // us the agent is intentionally down via `managet stop`, and
    // dropping it to `unreachable` would muddle the message and force
    // the UI to re-explain the situation. The transition back to
    // healthy is driven by the heartbeat route the moment the agent
    // restarts — no sweeper involvement needed.
    //
    // The `not(pendingUninstall = 1)` guard also stays so a server in
    // the middle of being uninstalled doesn't briefly flicker to
    // `unreachable` between its last heartbeat and the row being
    // hard-deleted.
    await db
      .update(servers)
      .set({
        agentStatus: "unreachable",
        status: "unreachable",
        updatedAt: now,
      })
      .where(
        and(
          eq(servers.agentStatus, "healthy"),
          lt(servers.agentLastHeartbeatAt, staleCutoff),
          not(eq(servers.pendingUninstall, 1))
        )
      );

    // Watchdog: install command succeeded (`installing` + the awaiting
    // stage), but no heartbeat has arrived inside the grace window. The row's
    // `updatedAt` was bumped when the installer wrote the awaiting stage,
    // so `updatedAt < awaitingCutoff` measures elapsed-since-install. The
    // heartbeat handler also bumps `updatedAt`, so a successful first
    // heartbeat resets the clock and clears `agentStatus`, which means this
    // sweep can never race with a real heartbeat.
    await db
      .update(servers)
      .set({
        agentStatus: "install_failed",
        agentInstallError:
          "Install command finished but no heartbeat received within 60s. " +
          "The agent service is running on the remote host but cannot reach " +
          "the dashboard. Check that the api_url in /etc/managet-agent/config.toml " +
          "(Linux) or /usr/local/etc/managet-agent/config.toml (macOS) is reachable " +
          "from the target, and that no firewall is blocking the dashboard's port.",
        agentInstallStage: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(servers.agentStatus, "installing"),
          eq(servers.agentInstallStage, AWAITING_HEARTBEAT_STAGE),
          lt(servers.updatedAt, awaitingCutoff)
        )
      );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] status sweep failed: ${message}`);
  }
}

/**
 * Start the periodic status sweeper. Idempotent — calling twice has no
 * effect. The timer is `unref`'d so it doesn't keep the Node process alive
 * on its own.
 */
export function startStatusMonitor(): void {
  if (timer) return;
  // Kick off an immediate sweep so startup doesn't have to wait the full
  // interval before marking dead servers unreachable.
  void runStatusSweep();
  timer = setInterval(() => {
    void runStatusSweep();
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[agent] status monitor started (interval=${SWEEP_INTERVAL_MS}ms, stale=${STALE_HEARTBEAT_MS}ms)`
  );
}

/** Stop the sweeper. Safe to call even if it was never started. */
export function stopStatusMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
