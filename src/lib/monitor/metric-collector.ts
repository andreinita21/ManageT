/**
 * @file metric-collector.ts — Agentless metric collection over SSH.
 *
 * Polls remote servers at configurable intervals for CPU, memory, disk,
 * load-average, and active-connection metrics. Results are persisted to
 * the database and emitted as typed EventEmitter events so other
 * subsystems (AlertEngine, WebSocket broadcaster) can react in real time.
 */

import { EventEmitter } from "events";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { metricSnapshots } from "@/lib/db/schema";
import { executeCommand } from "@/lib/ssh/exec";
import type { MetricSnapshot } from "@/types";

// ---------------------------------------------------------------------------
// Typed events
// ---------------------------------------------------------------------------

interface MetricCollectorEvents {
  "metrics:collected": (snapshot: MetricSnapshot) => void;
  "metrics:error": (serverId: string, error: Error) => void;
}

/**
 * Strongly-typed EventEmitter wrapper so callers get autocomplete and
 * compile-time safety on event names / payloads.
 */
declare interface MetricCollector {
  on<K extends keyof MetricCollectorEvents>(
    event: K,
    listener: MetricCollectorEvents[K],
  ): this;
  off<K extends keyof MetricCollectorEvents>(
    event: K,
    listener: MetricCollectorEvents[K],
  ): this;
  emit<K extends keyof MetricCollectorEvents>(
    event: K,
    ...args: Parameters<MetricCollectorEvents[K]>
  ): boolean;
}

// ---------------------------------------------------------------------------
// Polling interval constants (milliseconds)
// ---------------------------------------------------------------------------

const INTERVAL_CPU_MEM_LOAD = 10_000;
const INTERVAL_DISK = 60_000;
const INTERVAL_CONNECTIONS = 30_000;
const SSH_TIMEOUT = 5_000;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse CPU usage from `top -bn1 | grep 'Cpu(s)'`.
 *
 * Handles several common formats:
 *   %Cpu(s):  1.3 us,  0.7 sy, ...
 *   Cpu(s):  1.3%us,  0.7%sy, ...
 *   top - ... %Cpu(s): ...
 *
 * Returns the total (user + system) percentage, or undefined on failure.
 */
function parseCpu(raw: string): number | undefined {
  // Try to extract user and system percentages
  const usMatch = raw.match(/([\d.]+)\s*[%]?\s*us/);
  const syMatch = raw.match(/([\d.]+)\s*[%]?\s*sy/);
  if (usMatch && syMatch) {
    return parseFloat(usMatch[1]) + parseFloat(syMatch[1]);
  }

  // Fallback: look for idle and subtract from 100
  const idMatch = raw.match(/([\d.]+)\s*[%]?\s*id/);
  if (idMatch) {
    return Math.max(0, 100 - parseFloat(idMatch[1]));
  }

  return undefined;
}

/**
 * Parse memory from `free -m | grep Mem`.
 *
 * Expected columns: Mem: total used free shared buff/cache available
 */
function parseMemory(raw: string): { usedMb: number; totalMb: number } | undefined {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) return undefined;
  const total = parseInt(parts[1], 10);
  const used = parseInt(parts[2], 10);
  if (Number.isNaN(total) || Number.isNaN(used)) return undefined;
  return { usedMb: used, totalMb: total };
}

/**
 * Parse disk usage from `df -h / | tail -1`.
 *
 * Handles the common format: /dev/sda1  50G  20G  30G  40% /
 */
function parseDisk(raw: string): number | undefined {
  const match = raw.match(/([\d.]+)%/);
  if (!match) return undefined;
  return parseFloat(match[1]);
}

/**
 * Parse load averages from `cat /proc/loadavg`.
 *
 * Format: "0.12 0.34 0.56 1/234 5678"
 */
function parseLoad(raw: string): { l1: number; l5: number; l15: number } | undefined {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) return undefined;
  const l1 = parseFloat(parts[0]);
  const l5 = parseFloat(parts[1]);
  const l15 = parseFloat(parts[2]);
  if (Number.isNaN(l1) || Number.isNaN(l5) || Number.isNaN(l15)) return undefined;
  return { l1, l5, l15 };
}

/**
 * Parse connection count from `ss -tunp | tail -n +2 | wc -l`.
 */
function parseConnections(raw: string): number | undefined {
  const n = parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? undefined : n;
}

// ---------------------------------------------------------------------------
// MetricCollector
// ---------------------------------------------------------------------------

/** Holds the per-server interval handles. */
interface ServerIntervals {
  cpuMemLoad: ReturnType<typeof setInterval>;
  disk: ReturnType<typeof setInterval>;
  connections: ReturnType<typeof setInterval>;
}

class MetricCollector extends EventEmitter {
  private static instance: MetricCollector | null = null;
  private serverIntervals = new Map<string, ServerIntervals>();

  private constructor() {
    super();
  }

  /** Get or create the singleton instance. */
  static getInstance(): MetricCollector {
    if (!MetricCollector.instance) {
      MetricCollector.instance = new MetricCollector();
    }
    return MetricCollector.instance;
  }

  /**
   * Start polling a server for metrics.
   * If the server is already being polled, this is a no-op.
   */
  startPolling(serverId: string): void {
    if (this.serverIntervals.has(serverId)) return;

    // Fire immediately, then on interval
    void this.collectCpuMemLoad(serverId);
    void this.collectDisk(serverId);
    void this.collectConnections(serverId);

    const cpuMemLoad = setInterval(
      () => void this.collectCpuMemLoad(serverId),
      INTERVAL_CPU_MEM_LOAD,
    );
    const disk = setInterval(
      () => void this.collectDisk(serverId),
      INTERVAL_DISK,
    );
    const connections = setInterval(
      () => void this.collectConnections(serverId),
      INTERVAL_CONNECTIONS,
    );

    this.serverIntervals.set(serverId, { cpuMemLoad, disk, connections });
  }

  /** Stop polling a single server. */
  stopPolling(serverId: string): void {
    const intervals = this.serverIntervals.get(serverId);
    if (!intervals) return;
    clearInterval(intervals.cpuMemLoad);
    clearInterval(intervals.disk);
    clearInterval(intervals.connections);
    this.serverIntervals.delete(serverId);
  }

  /** Stop polling all servers. */
  stopAll(): void {
    for (const serverId of this.serverIntervals.keys()) {
      this.stopPolling(serverId);
    }
  }

  /** Returns true if the given server is currently being polled. */
  isPolling(serverId: string): boolean {
    return this.serverIntervals.has(serverId);
  }

  // -----------------------------------------------------------------------
  // Collection routines
  // -----------------------------------------------------------------------

  private async collectCpuMemLoad(serverId: string): Promise<void> {
    try {
      const [cpuRes, memRes, loadRes] = await Promise.allSettled([
        executeCommand(serverId, "top -bn1 | grep 'Cpu(s)'", undefined, SSH_TIMEOUT),
        executeCommand(serverId, "free -m | grep Mem", undefined, SSH_TIMEOUT),
        executeCommand(serverId, "cat /proc/loadavg", undefined, SSH_TIMEOUT),
      ]);

      const cpu =
        cpuRes.status === "fulfilled" ? parseCpu(cpuRes.value.stdout) : undefined;
      const mem =
        memRes.status === "fulfilled" ? parseMemory(memRes.value.stdout) : undefined;
      const load =
        loadRes.status === "fulfilled" ? parseLoad(loadRes.value.stdout) : undefined;

      const snapshot: MetricSnapshot = {
        id: uuid(),
        serverId,
        cpuPercent: cpu,
        memoryUsedMb: mem?.usedMb,
        memoryTotalMb: mem?.totalMb,
        load1m: load?.l1,
        load5m: load?.l5,
        load15m: load?.l15,
        capturedAt: Date.now(),
      };

      await this.persistAndEmit(snapshot);
    } catch (err) {
      this.emit(
        "metrics:error",
        serverId,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private async collectDisk(serverId: string): Promise<void> {
    try {
      const res = await executeCommand(serverId, "df -h / | tail -1", undefined, SSH_TIMEOUT);
      const diskPercent = parseDisk(res.stdout);

      const snapshot: MetricSnapshot = {
        id: uuid(),
        serverId,
        diskUsedPercent: diskPercent,
        capturedAt: Date.now(),
      };

      await this.persistAndEmit(snapshot);
    } catch (err) {
      this.emit(
        "metrics:error",
        serverId,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private async collectConnections(serverId: string): Promise<void> {
    try {
      const res = await executeCommand(serverId, "ss -tunp | tail -n +2 | wc -l", undefined, SSH_TIMEOUT);
      const conns = parseConnections(res.stdout);

      const snapshot: MetricSnapshot = {
        id: uuid(),
        serverId,
        activeConnections: conns,
        capturedAt: Date.now(),
      };

      await this.persistAndEmit(snapshot);
    } catch (err) {
      this.emit(
        "metrics:error",
        serverId,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private async persistAndEmit(snapshot: MetricSnapshot): Promise<void> {
    await db.insert(metricSnapshots).values({
      id: snapshot.id,
      serverId: snapshot.serverId,
      cpuPercent: snapshot.cpuPercent ?? null,
      memoryUsedMb: snapshot.memoryUsedMb ?? null,
      memoryTotalMb: snapshot.memoryTotalMb ?? null,
      diskUsedPercent: snapshot.diskUsedPercent ?? null,
      load1m: snapshot.load1m ?? null,
      load5m: snapshot.load5m ?? null,
      load15m: snapshot.load15m ?? null,
      activeConnections: snapshot.activeConnections ?? null,
      capturedAt: snapshot.capturedAt,
    });

    this.emit("metrics:collected", snapshot);
  }
}

export { MetricCollector };
