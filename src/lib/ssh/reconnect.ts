/**
 * @fileoverview Reconnection engine for ManageT.
 * Listens for connection-lost events and attempts to reconnect
 * with exponential backoff and jitter.
 */
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { connectionPool } from "./connection-pool";
import { sessionManager } from "./session-manager";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import type { Server } from "@/types";

/** Configuration for the backoff strategy */
interface BackoffConfig {
  /** Initial delay in milliseconds */
  initialDelayMs: number;
  /** Multiplier applied after each failure */
  multiplier: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Jitter factor (0.25 = +/-25%) */
  jitterFactor: number;
  /** Maximum number of retry attempts before giving up */
  maxAttempts: number;
}

const DEFAULT_BACKOFF: BackoffConfig = {
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 30000,
  jitterFactor: 0.25,
  maxAttempts: 10,
};

/** State tracked per-server for reconnection attempts */
interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  serverId: string;
}

/** Events emitted by the ReconnectionEngine */
interface ReconnectionEvents {
  "reconnect:attempt": [serverId: string, attempt: number];
  "reconnect:success": [serverId: string];
  "reconnect:failed": [serverId: string, reason: string];
  "reconnect:exhausted": [serverId: string];
}

/**
 * Handles automatic reconnection to servers after connection loss.
 * Uses exponential backoff with jitter to avoid thundering herd.
 */
export class ReconnectionEngine extends EventEmitter<ReconnectionEvents> {
  private readonly states = new Map<string, ReconnectState>();
  private readonly config: BackoffConfig;
  private serverCache = new Map<string, Server>();

  constructor(config: Partial<BackoffConfig> = {}) {
    super();
    this.config = { ...DEFAULT_BACKOFF, ...config };
    this.setupListeners();
  }

  /**
   * Wire up listeners to the connection pool.
   */
  private setupListeners(): void {
    connectionPool.on("connection:lost", (serverId: string, reason: string) => {
      console.log(
        `[SSH] Connection lost for server ${serverId}: ${reason}. Starting reconnection.`
      );
      sessionManager.handleDisconnect(serverId);
      this.startReconnection(serverId);
    });
  }

  /**
   * Begin the reconnection loop for a server.
   * @param serverId - The server to reconnect to
   */
  private startReconnection(serverId: string): void {
    // Don't start if already reconnecting
    if (this.states.has(serverId)) {
      return;
    }

    const state: ReconnectState = {
      attempts: 0,
      timer: null,
      serverId,
    };
    this.states.set(serverId, state);

    this.updateServerStatus(serverId, "reconnecting");
    this.scheduleAttempt(serverId);
  }

  /**
   * Schedule the next reconnection attempt with backoff.
   */
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

  /**
   * Perform a single reconnection attempt.
   */
  private async attempt(serverId: string): Promise<void> {
    const state = this.states.get(serverId);
    if (!state) return;

    state.attempts += 1;
    this.emit("reconnect:attempt", serverId, state.attempts);

    const server = await this.getServer(serverId);
    if (!server) {
      console.error(
        `[SSH] Cannot reconnect: server ${serverId} not found in database`
      );
      this.cleanup(serverId);
      return;
    }

    try {
      await connectionPool.connect(server);

      // Success
      console.log(
        `[SSH] Reconnected to server ${serverId} after ${state.attempts} attempt(s)`
      );
      this.cleanup(serverId);
      this.updateServerStatus(serverId, "connected");
      this.emit("reconnect:success", serverId);

      // Trigger session recovery
      await sessionManager.handleReconnect(serverId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[SSH] Reconnection attempt ${state.attempts} failed for server ${serverId}: ${reason}`
      );
      this.emit("reconnect:failed", serverId, reason);

      if (state.attempts >= this.config.maxAttempts) {
        console.error(
          `[SSH] Exhausted ${this.config.maxAttempts} reconnection attempts for server ${serverId}`
        );
        this.cleanup(serverId);
        this.updateServerStatus(serverId, "unreachable");
        this.emit("reconnect:exhausted", serverId);
      } else {
        this.scheduleAttempt(serverId);
      }
    }
  }

  /**
   * Manually trigger an immediate reconnection attempt, resetting the counter.
   * @param serverId - The server to retry
   */
  retryNow(serverId: string): void {
    // Clear any existing state
    const existing = this.states.get(serverId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }
    this.states.delete(serverId);

    // Start fresh
    const state: ReconnectState = {
      attempts: 0,
      timer: null,
      serverId,
    };
    this.states.set(serverId, state);
    this.updateServerStatus(serverId, "reconnecting");

    console.log(`[SSH] Manual retry triggered for server ${serverId}`);
    void this.attempt(serverId);
  }

  /**
   * Calculate backoff delay with jitter.
   */
  private calculateDelay(attempts: number): number {
    const baseDelay = Math.min(
      this.config.initialDelayMs * Math.pow(this.config.multiplier, attempts),
      this.config.maxDelayMs
    );
    const jitter = baseDelay * this.config.jitterFactor;
    const offset = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(baseDelay + offset));
  }

  /**
   * Clean up reconnection state for a server.
   */
  private cleanup(serverId: string): void {
    const state = this.states.get(serverId);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.states.delete(serverId);
    this.serverCache.delete(serverId);
  }

  /**
   * Fetch server record from DB, with a short-lived cache.
   */
  private async getServer(serverId: string): Promise<Server | null> {
    const cached = this.serverCache.get(serverId);
    if (cached) return cached;

    const rows = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const server: Server = {
      ...row,
      labels: JSON.parse(row.labels) as string[],
      lastConnectedAt: row.lastConnectedAt ?? undefined,
      privateKeyPath: row.privateKeyPath ?? undefined,
      passwordEncrypted: row.passwordEncrypted ?? undefined,
      groupName: row.groupName ?? undefined,
    };

    this.serverCache.set(serverId, server);
    return server;
  }

  /**
   * Update a server's status in the database.
   */
  private updateServerStatus(
    serverId: string,
    status: Server["status"]
  ): void {
    const now = Date.now();
    const update: Record<string, unknown> = { status, updatedAt: now };
    if (status === "connected") {
      update.lastConnectedAt = now;
    }
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

/** Singleton reconnection engine instance */
export const reconnectionEngine = new ReconnectionEngine();
