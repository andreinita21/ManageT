/**
 * SSH reconnection engine.
 *
 * Listens for `connection:lost` events from the connection pool and tries
 * to re-establish the SSH transport with exponential backoff + jitter.
 *
 * With PTYs hosted in the per-host Rust agent, sessions themselves don't
 * need recovery — the agent keeps every PTY running across SSH drops.
 * All this engine has to do is restore the dashboard's SSH transport
 * (which the agent-socket helpers and the installer both depend on).
 */
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { connectionPool } from "./connection-pool";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { rowToServer } from "@/lib/db/transform";
import type { Server } from "@/types";

interface BackoffConfig {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  jitterFactor: number;
  maxAttempts: number;
}

const DEFAULT_BACKOFF: BackoffConfig = {
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 30000,
  jitterFactor: 0.25,
  maxAttempts: 10,
};

interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  serverId: string;
}

interface ReconnectionEvents {
  "reconnect:attempt": [serverId: string, attempt: number];
  "reconnect:success": [serverId: string];
  "reconnect:failed": [serverId: string, reason: string];
  "reconnect:exhausted": [serverId: string];
}

export class ReconnectionEngine extends EventEmitter<ReconnectionEvents> {
  private readonly states = new Map<string, ReconnectState>();
  private readonly config: BackoffConfig;
  private serverCache = new Map<string, Server>();

  constructor(config: Partial<BackoffConfig> = {}) {
    super();
    this.config = { ...DEFAULT_BACKOFF, ...config };
    this.setupListeners();
  }

  private setupListeners(): void {
    connectionPool.on("connection:lost", (serverId: string, reason: string) => {
      console.log(
        `[SSH] Connection lost for server ${serverId}: ${reason}. Starting reconnection.`
      );
      this.startReconnection(serverId);
    });
  }

  private startReconnection(serverId: string): void {
    if (this.states.has(serverId)) return;
    const state: ReconnectState = { attempts: 0, timer: null, serverId };
    this.states.set(serverId, state);
    this.updateServerStatus(serverId, "reconnecting");
    this.scheduleAttempt(serverId);
  }

  private scheduleAttempt(serverId: string): void {
    const state = this.states.get(serverId);
    if (!state) return;
    const delay = this.calculateDelay(state.attempts);
    console.log(
      `[SSH] Scheduling reconnection attempt ${state.attempts + 1}/${this.config.maxAttempts} for server ${serverId} in ${delay}ms`
    );
    state.timer = setTimeout(() => {
      void this.attempt(serverId);
    }, delay);
  }

  private async attempt(serverId: string): Promise<void> {
    const state = this.states.get(serverId);
    if (!state) return;
    state.attempts += 1;
    this.emit("reconnect:attempt", serverId, state.attempts);

    const server = await this.getServer(serverId);
    if (!server) {
      this.cleanup(serverId);
      return;
    }

    try {
      await connectionPool.connect(server);
      this.cleanup(serverId);
      this.updateServerStatus(serverId, "connected");
      this.emit("reconnect:success", serverId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.emit("reconnect:failed", serverId, reason);
      if (state.attempts >= this.config.maxAttempts) {
        this.cleanup(serverId);
        this.updateServerStatus(serverId, "unreachable");
        this.emit("reconnect:exhausted", serverId);
      } else {
        this.scheduleAttempt(serverId);
      }
    }
  }

  retryNow(serverId: string): void {
    const existing = this.states.get(serverId);
    if (existing?.timer) clearTimeout(existing.timer);
    this.states.delete(serverId);
    const state: ReconnectState = { attempts: 0, timer: null, serverId };
    this.states.set(serverId, state);
    this.updateServerStatus(serverId, "reconnecting");
    void this.attempt(serverId);
  }

  private calculateDelay(attempts: number): number {
    const base = Math.min(
      this.config.initialDelayMs * Math.pow(this.config.multiplier, attempts),
      this.config.maxDelayMs
    );
    const jitter = base * this.config.jitterFactor;
    const offset = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(base + offset));
  }

  private cleanup(serverId: string): void {
    const state = this.states.get(serverId);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(serverId);
    this.serverCache.delete(serverId);
  }

  private async getServer(serverId: string): Promise<Server | null> {
    const cached = this.serverCache.get(serverId);
    if (cached) return cached;
    const rows = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!rows[0]) return null;
    const server = rowToServer(rows[0]);
    this.serverCache.set(serverId, server);
    return server;
  }

  private updateServerStatus(
    serverId: string,
    status: Server["status"]
  ): void {
    const now = Date.now();
    const update: Record<string, unknown> = { status, updatedAt: now };
    if (status === "connected") update.lastConnectedAt = now;
    db.update(servers)
      .set(update)
      .where(eq(servers.id, serverId))
      .catch((err: Error) => {
        console.error(
          `[SSH] Failed to update server ${serverId} status to ${status}: ${err.message}`
        );
      });
  }
}

export const reconnectionEngine = new ReconnectionEngine();
