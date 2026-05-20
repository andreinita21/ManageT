/**
 * Dashboard-side session orchestrator.
 *
 * The dashboard no longer holds PTYs. The Rust agent on each managed host
 * owns the PTY processes (see `agent/src/sessions/`). This module is a
 * thin facade over `agent-socket.ts`:
 *
 *   - `createSession(serverId, opts)`  → asks the agent to spawn a PTY.
 *                                        Inserts a row into `sessions`
 *                                        whose `id` IS the agent's
 *                                        session id (1:1 mapping).
 *   - `attachSession(serverId, id)`    → opens a forwarded byte pipe to
 *                                        the agent's `Attach` endpoint.
 *                                        Returns the raw Duplex stream;
 *                                        the WS layer pumps bytes both
 *                                        ways. Multiple attaches are
 *                                        fine — the agent fans out via
 *                                        broadcast.
 *   - `detachSession(stream)`          → just closes the stream. PTY
 *                                        keeps running. This is what
 *                                        survives dashboard restart,
 *                                        browser refresh, network blips.
 *   - `killSession(serverId, id)`      → asks the agent to SIGTERM the
 *                                        PTY child. Removes the DB row.
 *   - `listSessions(serverId)`         → asks the agent for its current
 *                                        session list (used for UI
 *                                        reconciliation).
 *   - `resizeSession(serverId, id,…)`  → forwards SIGWINCH-equivalent.
 *
 * Connection caching: re-uses the existing `connectionPool` (one ssh2
 * Client per server). The agent socket helper opens a new forwarded
 * channel per call — they're cheap and short-lived.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { rowToSession } from "@/lib/db/transform";
import { cleanupEmptyGroupIfNeeded } from "@/lib/groups";
import type { Session } from "@/types";
import {
  agentRequest,
  openAgentAttach,
  type AgentSessionInfo,
  type AttachedHandle,
} from "./agent-socket";

/** Options accepted when creating a session through the dashboard. */
export interface CreateOptions {
  command?: string;
  /** Friendly name; defaults to `session-<8 chars>` on the agent side. */
  name?: string;
  /** Initial PTY size — defaults are 24×80 inside the agent. */
  rows?: number;
  cols?: number;
  /** If set, link the new session to a stack launch for grouping. */
  stackId?: string;
  /** Unix user on the target host to spawn the shell as. The agent runs
   *  as root and uses `su -l <user>` to drop privileges and establish a
   *  proper login environment (HOME/USER/.bash_profile/etc.). Omit to
   *  keep the legacy "shell runs as the agent's identity" behaviour. */
  user?: string;
}

export interface CreatedSession {
  sessionId: string;
  sessionName: string;
  serverId: string;
}

/** Ask the agent on `serverId` to spawn a new PTY. */
export async function createSession(
  serverId: string,
  opts: CreateOptions = {}
): Promise<CreatedSession> {
  const resp = await agentRequest(serverId, {
    op: "new",
    name: opts.name,
    command: opts.command,
    rows: opts.rows,
    cols: opts.cols,
    user: opts.user,
  });
  if (resp.result !== "created") {
    throw new Error(
      `session-manager: unexpected create response: ${JSON.stringify(resp)}`
    );
  }

  const now = Date.now();
  await db.insert(sessions).values({
    id: resp.id,
    serverId,
    sessionName: resp.name,
    status: "active",
    cwd: null,
    lastCommand: opts.command ?? null,
    envSnapshot: null,
    scrollBufferTail: null,
    restartPolicy: "ask",
    retryCount: 0,
    stackId: opts.stackId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return {
    sessionId: resp.id,
    sessionName: resp.name,
    serverId,
  };
}

/**
 * Open a raw byte channel to the agent's `Attach` endpoint. The caller
 * is responsible for piping the returned stream's data into the WebSocket
 * client and writing browser keystrokes back into it.
 *
 * Returns null if the session no longer exists on the agent (e.g. it
 * was killed elsewhere). The caller should treat that as "session lost"
 * and tell the browser.
 */
export async function attachSession(
  serverId: string,
  sessionId: string,
  rows?: number,
  cols?: number
): Promise<AttachedHandle | null> {
  try {
    const handle = await openAgentAttach(serverId, sessionId, rows, cols);
    // Refresh the DB row so the UI shows it as active.
    await db
      .update(sessions)
      .set({ status: "active", updatedAt: Date.now() })
      .where(eq(sessions.id, sessionId));
    return handle;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The agent returns `no session matches` when an id is unknown. Treat
    // that as a soft miss so the UI can clear stale tabs gracefully.
    if (/no session matches/i.test(msg)) {
      await db
        .update(sessions)
        .set({ status: "closed", updatedAt: Date.now() })
        .where(eq(sessions.id, sessionId));
      return null;
    }
    throw err;
  }
}

/** Resize the PTY for a session. Idempotent; safe to call repeatedly. */
export async function resizeSession(
  serverId: string,
  sessionId: string,
  rows: number,
  cols: number
): Promise<void> {
  await agentRequest(serverId, { op: "resize", id: sessionId, rows, cols });
}

/** Result of pushing a rename to the agent. Distinguishes the three
 *  outcomes the PUT handler needs to differentiate:
 *   - `pushed`: agent accepted, name updated on the host.
 *   - `stale`: agent has no such session id (DB row is stale; the
 *     rename is still valid for the dashboard's view).
 *   - `agent_rejected`: the agent ran and replied with an error
 *     that isn't a stale lookup (unknown op on an old agent,
 *     internal failure, etc.). The caller should treat this as a
 *     hard failure so the dashboard's view doesn't diverge from
 *     what `managet ls` shows on the host. */
export type RenameOutcome =
  | { kind: "pushed" }
  | { kind: "stale" }
  | { kind: "agent_rejected"; message: string };

const STALE_SESSION_RE = /no session matches/i;

/** Push a display-name update to the agent so `managet list` /
 *  `managet attach <name>` on the host see the same name the dashboard
 *  does after a UI rename. The caller (PUT route) decides whether to
 *  proceed with the DB write based on the returned outcome. */
export async function renameSession(
  serverId: string,
  sessionId: string,
  newName: string
): Promise<RenameOutcome> {
  try {
    await agentRequest(serverId, {
      op: "rename",
      id: sessionId,
      name: newName,
    });
    return { kind: "pushed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (STALE_SESSION_RE.test(msg)) {
      // Agent doesn't know about this session id anymore (process
      // restarted, PTY exited, …). Renaming the DB row is still
      // meaningful — the row will get reconciled to closed on the
      // next reconcile pass anyway.
      return { kind: "stale" };
    }
    console.warn(
      `[session-manager] agent rename rejected for ${sessionId}: ${msg}`
    );
    return { kind: "agent_rejected", message: msg };
  }
}

/** SIGTERM the PTY child and drop the DB row. */
export async function killSession(
  serverId: string,
  sessionId: string
): Promise<void> {
  // Capture the group link before deletion so we can auto-clean an empty
  // group afterwards (the FK is ON DELETE SET NULL on the column, which
  // doesn't help us here — we need the *id* the row used to belong to).
  const linkRows = await db
    .select({ groupId: sessions.groupId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const groupId = linkRows[0]?.groupId ?? null;

  try {
    await agentRequest(serverId, { op: "kill", id: sessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // If the session is already gone on the agent, that's fine — we still
    // want to drop our DB row.
    if (!/no session matches/i.test(msg)) throw err;
  }
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  if (groupId) await cleanupEmptyGroupIfNeeded(groupId);
}

/** Fetch the live session list from the agent on a server. */
export async function listSessions(
  serverId: string
): Promise<AgentSessionInfo[]> {
  const resp = await agentRequest(serverId, { op: "list" });
  if (resp.result !== "session_list") {
    throw new Error(
      `session-manager: unexpected list response: ${JSON.stringify(resp)}`
    );
  }
  return resp.sessions;
}

/**
 * Reconcile the DB sessions table for a single server against the agent's
 * authoritative list. Inserts rows for any agent-side sessions we didn't
 * know about (e.g. created via `managet new` on the host directly), and
 * marks rows as `closed` if the agent no longer knows about them.
 *
 * Returns the merged set as `Session` rows for direct use by the UI.
 */
export async function reconcileServer(serverId: string): Promise<Session[]> {
  let live: AgentSessionInfo[];
  try {
    live = await listSessions(serverId);
  } catch (err) {
    // If the agent is unreachable we just return whatever the DB has.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[session-manager] reconcile failed for ${serverId}: ${msg} — returning DB state`
    );
    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.serverId, serverId));
    return rows.map(rowToSession);
  }

  const now = Date.now();
  const dbRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.serverId, serverId));
  const dbById = new Map(dbRows.map((r) => [r.id, r]));
  const liveById = new Map(live.map((s) => [s.id, s]));

  // Insert agent sessions we don't know about.
  for (const s of live) {
    if (!dbById.has(s.id)) {
      await db.insert(sessions).values({
        id: s.id,
        serverId,
        sessionName: s.name,
        status: s.running ? "active" : "closed",
        cwd: null,
        lastCommand: s.command,
        envSnapshot: null,
        scrollBufferTail: null,
        restartPolicy: "ask",
        retryCount: 0,
        stackId: null,
        createdAt: s.created_at_ms,
        updatedAt: now,
      });
    } else {
      const row = dbById.get(s.id)!;
      const desiredStatus = s.running ? "active" : "closed";
      if (row.status !== desiredStatus) {
        await db
          .update(sessions)
          .set({ status: desiredStatus, updatedAt: now })
          .where(eq(sessions.id, s.id));
      }
    }
  }

  // Mark DB rows the agent no longer knows about as closed.
  for (const row of dbRows) {
    if (!liveById.has(row.id) && row.status !== "closed") {
      await db
        .update(sessions)
        .set({ status: "closed", updatedAt: now })
        .where(eq(sessions.id, row.id));
    }
  }

  const after = await db
    .select()
    .from(sessions)
    .where(eq(sessions.serverId, serverId));
  return after.map(rowToSession);
}

