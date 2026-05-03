/**
 * @file alert-engine.ts — Threshold-based alerting for ManageT.
 *
 * Listens to `snapshotEvents` "metrics:collected" events (published by the
 * agent heartbeat route), compares each snapshot against configurable
 * thresholds, and persists / emits alerts when values are exceeded.
 */

import { EventEmitter } from "events";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { alerts } from "@/lib/db/schema";
import { snapshotEvents } from "./snapshot-events";
import type { Alert, MetricSnapshot } from "@/types";

// ---------------------------------------------------------------------------
// Typed events
// ---------------------------------------------------------------------------

interface AlertEngineEvents {
  "alert:triggered": (alert: Alert) => void;
  "alert:acknowledged": (alert: Alert) => void;
}

declare interface AlertEngine {
  on<K extends keyof AlertEngineEvents>(
    event: K,
    listener: AlertEngineEvents[K],
  ): this;
  off<K extends keyof AlertEngineEvents>(
    event: K,
    listener: AlertEngineEvents[K],
  ): this;
  emit<K extends keyof AlertEngineEvents>(
    event: K,
    ...args: Parameters<AlertEngineEvents[K]>
  ): boolean;
}

// ---------------------------------------------------------------------------
// Threshold configuration
// ---------------------------------------------------------------------------

/** Thresholds that can be overridden at runtime. */
interface AlertThresholds {
  /** CPU usage percentage (default 90). */
  cpuPercent: number;
  /** Memory usage percentage (default 85). */
  memoryPercent: number;
  /** Disk usage percentage (default 90). */
  diskUsedPercent: number;
  /**
   * Load average multiplier relative to CPU count.
   * A value of 2.0 means "alert when load1m > 2 * cpuCount".
   * Because we cannot always know cpuCount we treat it as an
   * absolute load threshold (default 2.0).
   */
  loadMultiplier: number;
}

const DEFAULT_THRESHOLDS: Readonly<AlertThresholds> = {
  cpuPercent: 90,
  memoryPercent: 85,
  diskUsedPercent: 90,
  loadMultiplier: 2.0,
};

// ---------------------------------------------------------------------------
// AlertEngine
// ---------------------------------------------------------------------------

class AlertEngine extends EventEmitter {
  private static instance: AlertEngine | null = null;
  private thresholds: AlertThresholds;
  private listening = false;

  private constructor(thresholds?: Partial<AlertThresholds>) {
    super();
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /** Get or create the singleton instance. */
  static getInstance(thresholds?: Partial<AlertThresholds>): AlertEngine {
    if (!AlertEngine.instance) {
      AlertEngine.instance = new AlertEngine(thresholds);
    }
    return AlertEngine.instance;
  }

  /** Update thresholds at runtime. */
  setThresholds(partial: Partial<AlertThresholds>): void {
    this.thresholds = { ...this.thresholds, ...partial };
  }

  /** Return the current threshold values. */
  getThresholds(): Readonly<AlertThresholds> {
    return { ...this.thresholds };
  }

  /**
   * Bind to the shared snapshot event bus. Safe to call multiple times —
   * the listener is only attached once.
   */
  start(): void {
    if (this.listening) return;
    snapshotEvents.on("metrics:collected", this.handleSnapshot);
    this.listening = true;
  }

  /** Unbind from the snapshot event bus. */
  stop(): void {
    if (!this.listening) return;
    snapshotEvents.off("metrics:collected", this.handleSnapshot);
    this.listening = false;
  }

  /**
   * Acknowledge an alert by its ID.
   *
   * @returns The updated alert, or null if not found.
   */
  async acknowledgeAlert(alertId: string): Promise<Alert | null> {
    await db
      .update(alerts)
      .set({ acknowledged: 1 })
      .where(eq(alerts.id, alertId));

    const rows = await db
      .select()
      .from(alerts)
      .where(eq(alerts.id, alertId));

    if (rows.length === 0) return null;

    const row = rows[0];
    const alert: Alert = {
      id: row.id,
      serverId: row.serverId,
      metric: row.metric,
      threshold: row.threshold,
      actualValue: row.actualValue,
      acknowledged: row.acknowledged === 1,
      triggeredAt: row.triggeredAt,
    };

    this.emit("alert:acknowledged", alert);
    return alert;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /** Bound handler so we can cleanly remove the listener. */
  private handleSnapshot = (snapshot: MetricSnapshot): void => {
    void this.evaluate(snapshot);
  };

  /**
   * Compare a snapshot against thresholds and fire alerts for any
   * metric that exceeds its limit.
   */
  private async evaluate(snapshot: MetricSnapshot): Promise<void> {
    const checks: Array<{ metric: string; threshold: number; value: number }> = [];

    if (
      snapshot.cpuPercent !== undefined &&
      snapshot.cpuPercent > this.thresholds.cpuPercent
    ) {
      checks.push({
        metric: "cpuPercent",
        threshold: this.thresholds.cpuPercent,
        value: snapshot.cpuPercent,
      });
    }

    if (
      snapshot.memoryUsedMb !== undefined &&
      snapshot.memoryTotalMb !== undefined &&
      snapshot.memoryTotalMb > 0
    ) {
      const memPercent =
        (snapshot.memoryUsedMb / snapshot.memoryTotalMb) * 100;
      if (memPercent > this.thresholds.memoryPercent) {
        checks.push({
          metric: "memoryPercent",
          threshold: this.thresholds.memoryPercent,
          value: Math.round(memPercent * 100) / 100,
        });
      }
    }

    if (
      snapshot.diskUsedPercent !== undefined &&
      snapshot.diskUsedPercent > this.thresholds.diskUsedPercent
    ) {
      checks.push({
        metric: "diskUsedPercent",
        threshold: this.thresholds.diskUsedPercent,
        value: snapshot.diskUsedPercent,
      });
    }

    if (
      snapshot.load1m !== undefined &&
      snapshot.load1m > this.thresholds.loadMultiplier
    ) {
      checks.push({
        metric: "load1m",
        threshold: this.thresholds.loadMultiplier,
        value: snapshot.load1m,
      });
    }

    for (const check of checks) {
      await this.createAlert(snapshot.serverId, check.metric, check.threshold, check.value);
    }
  }

  private async createAlert(
    serverId: string,
    metric: string,
    threshold: number,
    actualValue: number,
  ): Promise<void> {
    const alert: Alert = {
      id: uuid(),
      serverId,
      metric,
      threshold,
      actualValue,
      acknowledged: false,
      triggeredAt: Date.now(),
    };

    await db.insert(alerts).values({
      id: alert.id,
      serverId: alert.serverId,
      metric: alert.metric,
      threshold: alert.threshold,
      actualValue: alert.actualValue,
      acknowledged: 0,
      triggeredAt: alert.triggeredAt,
    });

    this.emit("alert:triggered", alert);
  }
}

export { AlertEngine };
export type { AlertThresholds };
