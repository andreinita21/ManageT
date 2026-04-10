/**
 * @file index.ts — Public API for the monitoring subsystem.
 *
 * Re-exports every module and provides a single `initMonitoring()`
 * entry point that wires up the metric collector, alert engine, and
 * metric pruner.
 */

export { MetricCollector } from "./metric-collector";
export { LogStreamer } from "./log-streamer";
export { AlertEngine } from "./alert-engine";
export type { AlertThresholds } from "./alert-engine";
export { startPruner, stopPruner, pruneOnce } from "./pruner";
export { ProcessInspector } from "./process-inspector";
export type { ProcessInfo, ContainerInfo } from "./process-inspector";

import { MetricCollector } from "./metric-collector";
import { AlertEngine } from "./alert-engine";
import { startPruner } from "./pruner";
import { connectionPool } from "../ssh/connection-pool";

let _initialized = false;

/**
 * Bootstrap the entire monitoring subsystem.
 *
 * Call this once during application startup. It:
 *   1. Creates the MetricCollector singleton.
 *   2. Creates the AlertEngine singleton and binds it to collector events.
 *   3. Starts the background metric pruner.
 *   4. Auto-enrols servers into polling whenever the connection pool reports
 *      a `connection:ready`, and unenrols them on `connection:lost`. This
 *      mirrors the rule we want for the dashboard: a server gets metrics
 *      iff it currently has a live SSH client.
 */
function initMonitoring(): void {
  if (_initialized) return;
  _initialized = true;

  const collector = MetricCollector.getInstance();

  // Wire alert engine to metric events
  const alertEngine = AlertEngine.getInstance();
  alertEngine.start();

  // Start background pruning
  startPruner();

  connectionPool.on("connection:ready", (serverId: string) => {
    collector.startPolling(serverId);
  });
  connectionPool.on("connection:lost", (serverId: string) => {
    collector.stopPolling(serverId);
  });
}

export { initMonitoring };
