/**
 * @fileoverview SSH connection pool for ManageT.
 * Maintains a pool of ssh2 Client connections keyed by server ID.
 * Emits typed events for connection lifecycle management.
 */
import { EventEmitter } from "node:events";
import { Client } from "ssh2";
import { readFileSync } from "node:fs";
import { decryptPassword } from "@/lib/crypto";
import type { Server } from "@/types";

/** Events emitted by the ConnectionPool */
interface ConnectionPoolEvents {
  "connection:ready": [serverId: string];
  "connection:lost": [serverId: string, reason: string];
}

/**
 * Manages a pool of SSH connections keyed by server ID.
 * Handles connection lifecycle, keepalive, and error propagation.
 */
export class ConnectionPool extends EventEmitter<ConnectionPoolEvents> {
  private readonly connections = new Map<string, Client>();
  /**
   * In-flight dials keyed by server id. Without this, two near-simultaneous
   * `connect()` calls (e.g. a terminal attach racing the monitor loop after a
   * drop) both see no existing client and both dial; the loser's client is
   * orphaned — connected and keepalive'd forever but unreachable via the map.
   * Sharing the pending promise means concurrent callers get the same dial.
   */
  private readonly pending = new Map<string, Promise<Client>>();

  /**
   * Ensure an SSH connection exists for a server, returning the existing
   * client if one is already in the pool.
   *
   * **Idempotent.** Previously this method tore down any existing connection
   * before creating a new one — that turned out to be hostile to long-lived
   * consumers like the interactive terminal: when the SSH-push installer
   * called `connect()` for the same server (e.g. on Retry install), the
   * shell PTY stream the user was typing into was killed mid-session.
   *
   * Callers that genuinely need to drop and reopen a connection (e.g. after
   * editing a server's host or credentials) should call `disconnect()`
   * explicitly first.
   *
   * Dead connections clean themselves out of the pool via the `close`,
   * `end`, and `error` event handlers below, so a stale entry here always
   * means an actually-live ssh2 client.
   *
   * @param server - The server entity containing connection details
   * @returns A connected ssh2 Client
   */
  connect(server: Server): Promise<Client> {
    const existing = this.connections.get(server.id);
    if (existing) {
      return Promise.resolve(existing);
    }

    // Coalesce concurrent dials for the same server onto one promise.
    const inflight = this.pending.get(server.id);
    if (inflight) {
      return inflight;
    }

    const dial = new Promise<Client>((resolve, reject) => {
      const client = new Client();

      client.on("ready", () => {
        console.log(`[SSH] Connection ready for server ${server.id} (${server.host})`);
        this.connections.set(server.id, client);
        this.emit("connection:ready", server.id);
        resolve(client);
      });

      client.on("error", (err: Error) => {
        console.error(`[SSH] Connection error for server ${server.id}: ${err.message}`);
        this.connections.delete(server.id);
        this.emit("connection:lost", server.id, err.message);
        reject(err);
      });

      client.on("close", () => {
        if (this.connections.has(server.id)) {
          console.log(`[SSH] Connection closed for server ${server.id}`);
          this.connections.delete(server.id);
          this.emit("connection:lost", server.id, "Connection closed");
        }
      });

      client.on("end", () => {
        if (this.connections.has(server.id)) {
          console.log(`[SSH] Connection ended for server ${server.id}`);
          this.connections.delete(server.id);
          this.emit("connection:lost", server.id, "Connection ended");
        }
      });

      const connectConfig: Parameters<Client["connect"]>[0] = {
        host: server.host,
        port: server.port,
        username: server.username,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        readyTimeout: 20000,
      };

      if (server.authMethod === "key" && server.privateKeyPath) {
        try {
          connectConfig.privateKey = readFileSync(server.privateKeyPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          reject(new Error(`Failed to read private key at ${server.privateKeyPath}: ${msg}`));
          return;
        }
      } else if (server.authMethod === "password" && server.passwordEncrypted) {
        connectConfig.password = decryptPassword(server.passwordEncrypted);
      } else {
        reject(
          new Error(
            `Server ${server.id}: invalid auth configuration. ` +
              `authMethod=${server.authMethod}, ` +
              `hasKey=${!!server.privateKeyPath}, hasPassword=${!!server.passwordEncrypted}`
          )
        );
        return;
      }

      client.connect(connectConfig);
    });

    this.pending.set(server.id, dial);
    // Clear the in-flight marker once settled — but only if it's still ours,
    // so we don't wipe a newer dial that started after this one resolved.
    const clearPending = () => {
      if (this.pending.get(server.id) === dial) {
        this.pending.delete(server.id);
      }
    };
    dial.then(clearPending, clearPending);
    return dial;
  }

  /**
   * Retrieve an existing connection for a server.
   * @param serverId - The server ID
   * @returns The ssh2 Client if connected, undefined otherwise
   */
  getConnection(serverId: string): Client | undefined {
    return this.connections.get(serverId);
  }

  /**
   * Disconnect and remove a server connection from the pool.
   * @param serverId - The server ID to disconnect
   */
  disconnect(serverId: string): void {
    const client = this.connections.get(serverId);
    if (client) {
      this.connections.delete(serverId);
      try {
        client.end();
      } catch {
        // Already closed, ignore
      }
      console.log(`[SSH] Disconnected server ${serverId}`);
    }
  }

  /**
   * Check whether a server has an active connection.
   * @param serverId - The server ID
   * @returns true if a connection exists
   */
  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }
}

/** Singleton connection pool instance */
export const connectionPool = new ConnectionPool();
