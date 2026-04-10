/**
 * @fileoverview Session manager for ManageT.
 * Manages SSH terminal sessions using direct PTY shell channels,
 * CWD tracking, and reconnection support. No tmux or other terminal
 * multiplexer is required on the remote server.
 */
import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import type { ClientChannel } from "ssh2";
import { eq } from "drizzle-orm";
import { connectionPool } from "./connection-pool";
import { cwdTracker } from "./cwd-tracker";
import { classifyCommand } from "@/lib/restart/classify";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import type { SessionSnapshot, Session } from "@/types";

/** Maximum number of lines to retain in the scroll buffer */
const SCROLL_BUFFER_MAX = 1000;

/** Events emitted by the SessionManager */
interface SessionManagerEvents {
  "session:created": [snapshot: SessionSnapshot];
  "session:attached": [sessionId: string, stream: ClientChannel];
  "session:detached": [sessionId: string];
  "session:lost": [sessionId: string, reason: string];
  "session:recovered": [
    sessionId: string,
    method: "reattach" | "recreate",
    command?: string,
    cwd?: string,
  ];
  "session:output": [sessionId: string, data: string];
  "session:killed": [sessionId: string];
}

/** Tracks an active stream attachment for a session */
interface ActiveStream {
  stream: ClientChannel;
  sessionId: string;
}

/**
 * Manages the lifecycle of SSH terminal sessions using direct PTY channels.
 * Handles creation, attachment, detachment, recovery, and cleanup.
 * No tmux or terminal multiplexer required on the remote server.
 */
export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly snapshots = new Map<string, SessionSnapshot>();
  private readonly activeStreams = new Map<string, ActiveStream>();

  /**
   * Generate a human-readable session name for display.
   * @param sessionId - The session UUID
   * @returns Session name in the form `session-<first8>`
   */
  private generateSessionName(sessionId: string): string {
    return `session-${sessionId.slice(0, 8)}`;
  }

  /**
   * Create a new terminal session on the specified server.
   * Opens a direct SSH PTY shell, optionally runs a command,
   * and sets up CWD tracking.
   * @param serverId - Target server ID (must have an active connection)
   * @param command - Optional initial command to execute
   * @param cwd - Optional working directory to start in
   * @returns The created SessionSnapshot
   */
  async createSession(
    serverId: string,
    command?: string,
    cwd?: string
  ): Promise<SessionSnapshot> {
    let client = connectionPool.getConnection(serverId);
    if (!client) {
      console.log(`[SESSION] No active connection for ${serverId}, connecting...`);
      const { servers } = await import("@/lib/db/schema");
      const rows = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
      const serverRow = rows[0];
      if (!serverRow) {
        throw new Error(`[SESSION] Server ${serverId} not found in database`);
      }
      const serverData: import("@/types").Server = {
        ...serverRow,
        labels: JSON.parse(serverRow.labels) as string[],
        authMethod: serverRow.authMethod as "key" | "password",
        status: serverRow.status as import("@/types").Server["status"],
        lastConnectedAt: serverRow.lastConnectedAt ?? undefined,
        privateKeyPath: serverRow.privateKeyPath ?? undefined,
        passwordEncrypted: serverRow.passwordEncrypted ?? undefined,
        groupName: serverRow.groupName ?? undefined,
      };
      client = await connectionPool.connect(serverData);
    }

    const sessionId = uuidv4();
    const sessionName = this.generateSessionName(sessionId);

    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        { term: "xterm-256color", cols: 120, rows: 30 },
        (err, ch) => {
          if (err) {
            reject(new Error(`[SESSION] Failed to open shell: ${err.message}`));
            return;
          }
          resolve(ch);
        }
      );
    });

    // Change directory if specified
    if (cwd) {
      this.writeToStream(stream, `cd ${this.escapeShellArg(cwd)}\n`);
      await this.delay(200);
    }

    // Inject CWD tracker
    cwdTracker.injectPromptCommand(stream);
    await this.delay(200);

    // Execute initial command if specified
    if (command) {
      this.writeToStream(stream, `${command}\n`);
    }

    const snapshot: SessionSnapshot = {
      sessionId,
      serverId,
      sessionName,
      cwd: cwd || "/",
      lastCommand: command || "",
      env: {},
      scrollBuffer: [],
      status: "active",
      retryCount: 0,
    };

    this.snapshots.set(sessionId, snapshot);
    this.activeStreams.set(sessionId, { stream, sessionId });

    // Wire up stream data handling
    this.setupStreamHandlers(sessionId, stream);

    // Persist to database
    await this.persistSession(snapshot);

    console.log(
      `[SESSION] Created session ${sessionId} on server ${serverId} (${sessionName})`
    );
    this.emit("session:created", snapshot);

    return snapshot;
  }

  /**
   * Attach to an existing session, returning the SSH stream.
   * If a stream is already active, it is returned directly.
   * If the stream was lost but the snapshot exists, a new shell is opened.
   * @param sessionId - The session to attach to
   * @returns The SSH channel for the session
   */
  async attachSession(sessionId: string): Promise<ClientChannel> {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      throw new Error(`[SESSION] Session ${sessionId} not found`);
    }

    const existing = this.activeStreams.get(sessionId);
    if (existing) {
      return existing.stream;
    }

    const client = connectionPool.getConnection(snapshot.serverId);
    if (!client) {
      throw new Error(
        `[SESSION] No active connection for server ${snapshot.serverId}`
      );
    }

    // Open a new shell channel (previous one was lost)
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        { term: "xterm-256color", cols: 120, rows: 30 },
        (err, ch) => {
          if (err) {
            reject(
              new Error(`[SESSION] Failed to open shell for attach: ${err.message}`)
            );
            return;
          }
          resolve(ch);
        }
      );
    });

    // Restore working directory
    if (snapshot.cwd && snapshot.cwd !== "/") {
      this.writeToStream(stream, `cd ${this.escapeShellArg(snapshot.cwd)}\n`);
      await this.delay(200);
    }

    cwdTracker.injectPromptCommand(stream);
    this.activeStreams.set(sessionId, { stream, sessionId });
    this.setupStreamHandlers(sessionId, stream);

    snapshot.status = "active";
    this.updateSnapshot(sessionId, { status: "active" });

    console.log(`[SESSION] Attached to session ${sessionId}`);
    this.emit("session:attached", sessionId, stream);

    return stream;
  }

  /**
   * Detach from a session, closing the SSH stream.
   * Without a terminal multiplexer, detaching ends the remote shell process.
   * The session snapshot is preserved for potential recreation.
   * @param sessionId - The session to detach from
   */
  detachSession(sessionId: string): void {
    const active = this.activeStreams.get(sessionId);
    if (active) {
      cwdTracker.stopPeriodicFallback(sessionId);
      try {
        active.stream.end();
      } catch {
        // Stream already closed
      }
      this.activeStreams.delete(sessionId);
      console.log(`[SESSION] Detached session ${sessionId}`);
      this.emit("session:detached", sessionId);
    }
  }

  /**
   * Kill a session entirely, closing the SSH channel and cleaning up state.
   * If this was the last session for the server, also drop the pooled SSH
   * client so the remote host stops showing a phantom login.
   * @param sessionId - The session to kill
   */
  async killSession(sessionId: string): Promise<void> {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      return;
    }
    const serverId = snapshot.serverId;

    // Cleanup local state and close SSH channel
    this.detachSession(sessionId);
    cwdTracker.stopPeriodicFallback(sessionId);
    this.snapshots.delete(sessionId);

    // If no other in-memory sessions reference this server, drop the SSH
    // client. Without this, every server we ever connected to leaks a
    // long-lived ssh2 Client (and the corresponding `who` entry on the
    // remote) for the lifetime of the Node process.
    const stillInUse = Array.from(this.snapshots.values()).some(
      (s) => s.serverId === serverId
    );
    if (!stillInUse) {
      connectionPool.disconnect(serverId);
    }

    // Update DB
    const now = Date.now();
    await db
      .update(sessions)
      .set({ status: "closed", updatedAt: now })
      .where(eq(sessions.id, sessionId));

    console.log(`[SESSION] Killed session ${sessionId}`);
    this.emit("session:killed", sessionId);
  }

  /**
   * Get the in-memory snapshot for a session.
   * @param sessionId - The session ID
   * @returns The snapshot or undefined if not found
   */
  getSnapshot(sessionId: string): SessionSnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  /**
   * Update a session snapshot in memory and persist to the database.
   * @param sessionId - The session to update
   * @param partial - Partial snapshot fields to merge
   */
  updateSnapshot(
    sessionId: string,
    partial: Partial<SessionSnapshot>
  ): void {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      return;
    }

    Object.assign(snapshot, partial);

    // Async DB update, fire-and-forget with error logging
    const now = Date.now();
    const dbUpdate: Record<string, unknown> = { updatedAt: now };

    if (partial.status !== undefined) dbUpdate.status = partial.status;
    if (partial.cwd !== undefined) dbUpdate.cwd = partial.cwd;
    if (partial.lastCommand !== undefined) dbUpdate.lastCommand = partial.lastCommand;
    if (partial.disconnectedAt !== undefined)
      dbUpdate.disconnectedAt = partial.disconnectedAt;
    if (partial.retryCount !== undefined) dbUpdate.retryCount = partial.retryCount;
    if (partial.env !== undefined)
      dbUpdate.envSnapshot = JSON.stringify(partial.env);
    if (partial.scrollBuffer !== undefined)
      dbUpdate.scrollBufferTail = partial.scrollBuffer.slice(-100).join("\n");

    db.update(sessions)
      .set(dbUpdate)
      .where(eq(sessions.id, sessionId))
      .catch((err: Error) => {
        console.error(
          `[SESSION] Failed to persist snapshot for ${sessionId}: ${err.message}`
        );
      });
  }

  /**
   * Handle a server disconnection by marking all sessions as disconnected.
   * Without a terminal multiplexer, all remote processes are lost when
   * the SSH connection drops.
   * @param serverId - The disconnected server ID
   */
  handleDisconnect(serverId: string): void {
    const now = Date.now();
    for (const [sessionId, snapshot] of this.snapshots) {
      if (snapshot.serverId === serverId && snapshot.status === "active") {
        snapshot.status = "disconnected";
        snapshot.disconnectedAt = now;

        const active = this.activeStreams.get(sessionId);
        if (active) {
          cwdTracker.stopPeriodicFallback(sessionId);
          try {
            active.stream.end();
          } catch {
            // Already closed
          }
          this.activeStreams.delete(sessionId);
        }

        this.updateSnapshot(sessionId, {
          status: "disconnected",
          disconnectedAt: now,
        });

        console.log(
          `[SESSION] Session ${sessionId} lost due to server ${serverId} disconnect`
        );
        this.emit("session:lost", sessionId, "Server connection lost");
      }
    }
  }

  /**
   * Handle a server reconnection by attempting to recreate sessions
   * that were previously active on that server.
   * Since there is no terminal multiplexer, remote processes do not survive
   * SSH disconnection. Recovery always creates a new shell and optionally
   * re-executes the last command based on the restart classification.
   * @param serverId - The reconnected server ID
   */
  async handleReconnect(serverId: string): Promise<void> {
    const client = connectionPool.getConnection(serverId);
    if (!client) {
      return;
    }

    const recoveryPromises: Promise<void>[] = [];

    for (const [sessionId, snapshot] of this.snapshots) {
      if (
        snapshot.serverId === serverId &&
        (snapshot.status === "disconnected" || snapshot.status === "reconnecting")
      ) {
        recoveryPromises.push(this.recoverSession(sessionId, snapshot));
      }
    }

    if (recoveryPromises.length > 0) {
      const results = await Promise.allSettled(recoveryPromises);
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(`[SESSION] Recovery failed: ${result.reason}`);
        }
      }
    }
  }

  /**
   * Attempt to recover a single session after reconnection.
   * Classifies the last command to decide whether to auto-restart, ask, or skip.
   */
  private async recoverSession(
    sessionId: string,
    snapshot: SessionSnapshot
  ): Promise<void> {
    snapshot.status = "recovering";
    this.updateSnapshot(sessionId, { status: "recovering" });

    // Without a terminal multiplexer, remote processes are always gone
    // after SSH disconnect. Classify the last command to decide recovery action.
    const lastCommand = snapshot.lastCommand;

    if (!lastCommand) {
      // No command was running — just recreate the shell
      try {
        await this.recreateSession(sessionId, snapshot, false);
        console.log(`[SESSION] Recreated shell for session ${sessionId} (no previous command)`);
        this.emit("session:recovered", sessionId, "recreate", undefined, snapshot.cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[SESSION] Failed to recreate session ${sessionId}: ${msg}`);
        snapshot.status = "disconnected";
        this.updateSnapshot(sessionId, { status: "disconnected" });
      }
      return;
    }

    const classification = await classifyCommand(lastCommand);

    if (classification.action === "auto") {
      try {
        await this.recreateSession(sessionId, snapshot, true);
        console.log(
          `[SESSION] Recreated session ${sessionId} with command: ${lastCommand}`
        );
        this.emit(
          "session:recovered",
          sessionId,
          "recreate",
          lastCommand,
          snapshot.cwd
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[SESSION] Failed to recreate session ${sessionId}: ${msg}`
        );
        snapshot.status = "disconnected";
        this.updateSnapshot(sessionId, { status: "disconnected" });
      }
    } else if (classification.action === "never") {
      // Recreate shell without the command
      try {
        await this.recreateSession(sessionId, snapshot, false);
        console.log(
          `[SESSION] Session ${sessionId} recreated without command (policy: never) for: ${lastCommand}`
        );
        this.emit("session:recovered", sessionId, "recreate", undefined, snapshot.cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[SESSION] Failed to recreate session ${sessionId}: ${msg}`);
        snapshot.status = "disconnected";
        this.updateSnapshot(sessionId, { status: "disconnected" });
      }
    } else {
      // action === "ask" — recreate shell but don't run command, notify user
      try {
        await this.recreateSession(sessionId, snapshot, false);
        console.log(
          `[SESSION] Session ${sessionId} awaiting user decision for command: ${lastCommand}`
        );
        this.emit(
          "session:recovered",
          sessionId,
          "recreate",
          lastCommand,
          snapshot.cwd
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[SESSION] Failed to recreate session ${sessionId}: ${msg}`);
        snapshot.status = "disconnected";
        this.updateSnapshot(sessionId, { status: "disconnected" });
        this.emit(
          "session:lost",
          sessionId,
          `Recovery failed. Command "${lastCommand}" classified as "${classification.action}".`
        );
      }
    }
  }

  /**
   * Recreate a session by opening a new SSH shell,
   * restoring the working directory, and optionally re-executing the command.
   */
  private async recreateSession(
    sessionId: string,
    snapshot: SessionSnapshot,
    executeCommand: boolean
  ): Promise<void> {
    const client = connectionPool.getConnection(snapshot.serverId);
    if (!client) {
      throw new Error(`No connection for server ${snapshot.serverId}`);
    }

    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        { term: "xterm-256color", cols: 120, rows: 30 },
        (err, ch) => {
          if (err) {
            reject(
              new Error(`[SESSION] Failed to open shell for recreate: ${err.message}`)
            );
            return;
          }
          resolve(ch);
        }
      );
    });

    // Restore CWD
    if (snapshot.cwd && snapshot.cwd !== "/") {
      this.writeToStream(stream, `cd ${this.escapeShellArg(snapshot.cwd)}\n`);
      await this.delay(200);
    }

    cwdTracker.injectPromptCommand(stream);
    await this.delay(200);

    // Re-run the last command if allowed
    if (executeCommand && snapshot.lastCommand) {
      this.writeToStream(stream, `${snapshot.lastCommand}\n`);
    }

    this.activeStreams.set(sessionId, { stream, sessionId });
    this.setupStreamHandlers(sessionId, stream);

    snapshot.status = "active";
    snapshot.retryCount = 0;
    snapshot.scrollBuffer = [];
    this.updateSnapshot(sessionId, {
      status: "active",
      retryCount: 0,
      scrollBuffer: [],
    });
  }

  /**
   * Set up data and close handlers on an SSH stream for a session.
   */
  private setupStreamHandlers(
    sessionId: string,
    stream: ClientChannel
  ): void {
    stream.on("data", (data: Buffer) => {
      const raw = data.toString("utf-8");
      const { cleanData, cwd } = cwdTracker.extractCwd(raw);

      if (cwd) {
        this.updateSnapshot(sessionId, { cwd });
      }

      if (cleanData.length > 0) {
        const snapshot = this.snapshots.get(sessionId);
        if (snapshot) {
          snapshot.scrollBuffer.push(cleanData);
          if (snapshot.scrollBuffer.length > SCROLL_BUFFER_MAX) {
            snapshot.scrollBuffer = snapshot.scrollBuffer.slice(-SCROLL_BUFFER_MAX);
          }
        }
        this.emit("session:output", sessionId, cleanData);
      }
    });

    stream.on("close", () => {
      this.activeStreams.delete(sessionId);
      cwdTracker.stopPeriodicFallback(sessionId);
      console.log(`[SESSION] Stream closed for session ${sessionId}`);
    });

    stream.stderr.on("data", (data: Buffer) => {
      const raw = data.toString("utf-8");
      this.emit("session:output", sessionId, raw);
    });
  }

  /**
   * Write data to an SSH stream, handling backpressure.
   */
  private writeToStream(stream: ClientChannel, data: string): void {
    if (!stream.write(data)) {
      stream.once("drain", () => {
        // Backpressure resolved
      });
    }
  }

  /**
   * Escape a string for safe use in shell commands.
   */
  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Persist a new session to the database.
   */
  private async persistSession(snapshot: SessionSnapshot): Promise<void> {
    const now = Date.now();
    await db.insert(sessions).values({
      id: snapshot.sessionId,
      serverId: snapshot.serverId,
      sessionName: snapshot.sessionName,
      status: snapshot.status,
      cwd: snapshot.cwd,
      lastCommand: snapshot.lastCommand,
      envSnapshot: JSON.stringify(snapshot.env),
      scrollBufferTail: "",
      restartPolicy: "ask",
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Simple delay utility.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Singleton session manager instance */
export const sessionManager = new SessionManager();
