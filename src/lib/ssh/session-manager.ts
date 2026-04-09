/**
 * @fileoverview Session manager for ManageT.
 * Manages SSH terminal sessions with tmux integration, CWD tracking,
 * and reconnection support. This is the most critical module in the
 * SSH subsystem.
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
 * Manages the lifecycle of SSH terminal sessions backed by tmux.
 * Handles creation, attachment, detachment, recovery, and cleanup.
 */
export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly snapshots = new Map<string, SessionSnapshot>();
  private readonly activeStreams = new Map<string, ActiveStream>();

  /**
   * Generate the tmux session name for a given session ID.
   * @param sessionId - The session UUID
   * @returns tmux session name in the form `managet_<first8>`
   */
  private tmuxName(sessionId: string): string {
    return `managet_${sessionId.slice(0, 8)}`;
  }

  /**
   * Create a new terminal session on the specified server.
   * Opens an SSH shell, creates a tmux session, optionally runs a command,
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
    const client = connectionPool.getConnection(serverId);
    if (!client) {
      throw new Error(`[SESSION] No active connection for server ${serverId}`);
    }

    const sessionId = uuidv4();
    const tmuxSession = this.tmuxName(sessionId);

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

    // Create tmux session
    const tmuxCmd = `tmux new-session -d -s ${tmuxSession} -x 120 -y 30 2>/dev/null; tmux attach-session -t ${tmuxSession}\n`;
    this.writeToStream(stream, tmuxCmd);

    // Wait briefly for tmux to start
    await this.delay(500);

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
      tmuxSession,
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
      `[SESSION] Created session ${sessionId} on server ${serverId} (tmux: ${tmuxSession})`
    );
    this.emit("session:created", snapshot);

    return snapshot;
  }

  /**
   * Attach to an existing session, returning the SSH stream.
   * If a stream is already active, it is returned directly.
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

    // Reattach to existing tmux session
    this.writeToStream(stream, `tmux attach-session -t ${snapshot.tmuxSession}\n`);
    await this.delay(300);

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
   * Detach from a session, closing the SSH stream but preserving
   * the tmux session on the remote host.
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
   * Kill a session entirely, destroying the tmux session on the remote host.
   * @param sessionId - The session to kill
   */
  async killSession(sessionId: string): Promise<void> {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      return;
    }

    // Try to kill the remote tmux session
    const client = connectionPool.getConnection(snapshot.serverId);
    if (client) {
      try {
        await this.execOnClient(
          client,
          `tmux kill-session -t ${snapshot.tmuxSession} 2>/dev/null`
        );
      } catch {
        // tmux session may already be gone
      }
    }

    // Cleanup local state
    this.detachSession(sessionId);
    cwdTracker.stopPeriodicFallback(sessionId);
    this.snapshots.delete(sessionId);

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
   * Handle a server reconnection by attempting to reattach or recreate
   * sessions that were previously active on that server.
   * @param serverId - The reconnected server ID
   */
  async handleReconnect(serverId: string): Promise<void> {
    const client = connectionPool.getConnection(serverId);
    if (!client) {
      return;
    }

    // List existing tmux sessions on the remote
    let remoteSessions: string[] = [];
    try {
      const result = await this.execOnClient(
        client,
        "tmux list-sessions -F '#{session_name}' 2>/dev/null"
      );
      remoteSessions = result
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("managet_"));
    } catch {
      // tmux may not have any sessions
    }

    for (const [sessionId, snapshot] of this.snapshots) {
      if (
        snapshot.serverId === serverId &&
        (snapshot.status === "disconnected" || snapshot.status === "reconnecting")
      ) {
        snapshot.status = "recovering";
        this.updateSnapshot(sessionId, { status: "recovering" });

        if (remoteSessions.includes(snapshot.tmuxSession)) {
          // Tmux session still alive, reattach
          try {
            await this.attachSession(sessionId);
            snapshot.status = "active";
            snapshot.retryCount = 0;
            this.updateSnapshot(sessionId, {
              status: "active",
              retryCount: 0,
            });
            console.log(
              `[SESSION] Reattached session ${sessionId} to tmux ${snapshot.tmuxSession}`
            );
            this.emit(
              "session:recovered",
              sessionId,
              "reattach",
              undefined,
              snapshot.cwd
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[SESSION] Failed to reattach session ${sessionId}: ${msg}`
            );
            snapshot.status = "disconnected";
            this.updateSnapshot(sessionId, { status: "disconnected" });
          }
        } else {
          // Tmux session is gone, decide whether to recreate
          const classification = await classifyCommand(snapshot.lastCommand);

          if (classification.action === "auto") {
            try {
              await this.recreateSession(sessionId, snapshot);
              console.log(
                `[SESSION] Recreated session ${sessionId} with command: ${snapshot.lastCommand}`
              );
              this.emit(
                "session:recovered",
                sessionId,
                "recreate",
                snapshot.lastCommand,
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
            snapshot.status = "closed";
            this.updateSnapshot(sessionId, { status: "closed" });
            console.log(
              `[SESSION] Session ${sessionId} not recreated (policy: never) for command: ${snapshot.lastCommand}`
            );
          } else {
            // action === "ask" — leave in disconnected state for user decision
            snapshot.status = "disconnected";
            this.updateSnapshot(sessionId, { status: "disconnected" });
            console.log(
              `[SESSION] Session ${sessionId} awaiting user decision for command: ${snapshot.lastCommand}`
            );
            this.emit(
              "session:lost",
              sessionId,
              `Tmux session gone. Command "${snapshot.lastCommand}" classified as "${classification.action}". Awaiting user decision.`
            );
          }
        }
      }
    }
  }

  /**
   * Recreate a session that was lost by creating a new tmux session
   * with the same working directory and command.
   */
  private async recreateSession(
    sessionId: string,
    snapshot: SessionSnapshot
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

    // Create new tmux session with the same name
    const tmuxCmd = `tmux new-session -d -s ${snapshot.tmuxSession} -x 120 -y 30 2>/dev/null; tmux attach-session -t ${snapshot.tmuxSession}\n`;
    this.writeToStream(stream, tmuxCmd);
    await this.delay(500);

    // Restore CWD
    if (snapshot.cwd && snapshot.cwd !== "/") {
      this.writeToStream(stream, `cd ${this.escapeShellArg(snapshot.cwd)}\n`);
      await this.delay(200);
    }

    cwdTracker.injectPromptCommand(stream);
    await this.delay(200);

    // Re-run the last command
    if (snapshot.lastCommand) {
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
   * Execute a single command on an SSH client and return the stdout.
   */
  private execOnClient(
    client: import("ssh2").Client,
    command: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        let output = "";
        stream.on("data", (data: Buffer) => {
          output += data.toString("utf-8");
        });
        stream.stderr.on("data", () => {
          // Ignore stderr for internal commands
        });
        stream.on("close", () => {
          resolve(output);
        });
      });
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
      tmuxSessionName: snapshot.tmuxSession,
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
