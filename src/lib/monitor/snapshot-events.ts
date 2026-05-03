/**
 * @file snapshot-events.ts — Shared metric snapshot event bus.
 *
 * Used to decouple the snapshot producer (the agent heartbeat route) from
 * consumers (AlertEngine, future WebSocket broadcaster). Previously, metrics
 * were collected by an SSH-based `MetricCollector` that emitted its own
 * events; now the Rust agent pushes snapshots into the heartbeat endpoint,
 * and that endpoint republishes them here so downstream subsystems can
 * react without caring about the transport.
 */
import { EventEmitter } from "node:events";
import type { MetricSnapshot } from "@/types";

/** Event payload map — add more as new consumers show up. */
interface SnapshotEvents {
  "metrics:collected": [snapshot: MetricSnapshot];
  "metrics:error": [serverId: string, error: Error];
}

/**
 * Process-wide event bus. This is a singleton module, so importing it from
 * anywhere yields the same instance. Listeners attached at startup (e.g.
 * AlertEngine in `initMonitoring()`) will observe every snapshot pushed by
 * the heartbeat route.
 */
export const snapshotEvents = new EventEmitter<SnapshotEvents>();
