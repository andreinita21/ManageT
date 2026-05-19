/**
 * @file index.ts — Public API for the monitoring subsystem.
 *
 * Re-exports the monitoring modules and provides a single
 * `initMonitoring()` entry point that wires up the alert engine, the
 * metric pruner, and the agent status monitor.
 *
 * Historical note: metrics used to be collected in-process by an
 * SSH-based `MetricCollector` that polled every connected server. That
 * file has been deleted in favour of a push model: the Rust agent
 * installed on each remote host POSTs metrics to
 * `/api/agent/heartbeat`, which persists them and republishes on
 * `snapshotEvents`. `AlertEngine` listens to that bus instead.
 */

export { LogStreamer } from "./log-streamer";
export { AlertEngine } from "./alert-engine";
export type { AlertThresholds } from "./alert-engine";
export { startPruner, stopPruner, pruneOnce } from "./pruner";
export { ProcessInspector } from "./process-inspector";
export type { ProcessInfo, ContainerInfo } from "./process-inspector";
export { snapshotEvents } from "./snapshot-events";

import { AlertEngine } from "./alert-engine";
import { startPruner } from "./pruner";
import { startStatusMonitor } from "@/lib/agent/status-monitor";
import { startSessionReconciler } from "./session-reconciler";

let _initialized = false;

/**
 * Bootstrap the monitoring subsystem.
 *
 * Call this once during application startup. It:
 *   1. Starts the AlertEngine, which subscribes to the snapshot event bus
 *      that the agent heartbeat route publishes on.
 *   2. Starts the background metric pruner.
 *   3. Starts the agent status monitor, which flips servers to
 *      `unreachable` after missed heartbeats.
 *   4. Starts the session reconciler, which keeps the `sessions` table
 *      in sync with each agent's in-memory list — re-imports CLI-
 *      created sessions and surfaces orphans the dashboard had lost
 *      track of, so the user can manage them from the UI.
 *
 * Metrics themselves are NOT collected here — they arrive via
 * POST /api/agent/heartbeat from the Rust agent running on each host.
 */
function initMonitoring(): void {
  if (_initialized) return;
  _initialized = true;

  AlertEngine.getInstance().start();
  startPruner();
  startStatusMonitor();
  startSessionReconciler();
}

export { initMonitoring };
