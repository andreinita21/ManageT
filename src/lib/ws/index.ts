/**
 * WebSocket server.
 *
 * Acts as a thin byte-shovel between the browser's xterm and the remote
 * agent's PTY. The dashboard process holds NO PTY state — everything
 * lives in the per-host Rust agent. That means refreshing the browser
 * or restarting the dashboard simply reattaches to the same PTY; running
 * processes (npm run dev, vim, htop) survive untouched.
 *
 * Per-WS state we keep:
 *   - `wsAttachments` : ws → Map<sessionId, attachedHandle>
 *     Each attached session has its own forwarded SSH stream; closing
 *     the WS or detaching closes that stream (the PTY keeps running on
 *     the agent).
 *   - `wsToUser`      : ws → userId (for auth)
 *
 * Browser protocol (unchanged from the previous implementation, so the
 * xterm component didn't need rewriting):
 *   client → server:
 *     {type:"session:create", serverId, command?, name?}
 *     {type:"session:attach", sessionId, serverId}
 *     {type:"session:detach", sessionId}
 *     {type:"session:kill",   sessionId}
 *     {type:"terminal:input",  sessionId, data}
 *     {type:"terminal:resize", sessionId, rows, cols}
 *   server → client:
 *     {type:"session:state", session: SessionSnapshot}
 *     {type:"terminal:output", sessionId, data}
 *     {type:"session:lost",   sessionId, reason}
 *
 * Note: `session:attach` carries an explicit `serverId` now. The previous
 * code looked it up from an in-memory snapshot; with PTYs out of process,
 * the dashboard needs to be told which agent to connect to.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parse as parseUrl } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { servers, sessions } from "@/lib/db/schema";
import {
  attachSession,
  createSession,
  killSession,
  resizeSession,
} from "@/lib/ssh/session-manager";
import type { Session, SessionSnapshot } from "@/types";

const WS_OPEN = WebSocket.OPEN;

/** Per-WS state: which session(s) this client is currently piping. */
interface AttachState {
  sessionId: string;
  serverId: string;
  stream: Duplex;
}

const wsAttachments = new Map<WebSocket, Map<string, AttachState>>();
const wsToUser = new Map<WebSocket, string>();

const wss = new WebSocketServer({ noServer: true });

// ---------------------------------------------------------------------------
// Browser-bound protocol types (kept in lockstep with src/types/index.ts)
// ---------------------------------------------------------------------------

interface IncomingCreate {
  type: "session:create";
  serverId: string;
  command?: string;
  name?: string;
  cwd?: string; // accepted but currently unused — agent doesn't honor it yet
}
interface IncomingAttach {
  type: "session:attach";
  sessionId: string;
  serverId: string;
}
interface IncomingDetach {
  type: "session:detach";
  sessionId: string;
}
interface IncomingKill {
  type: "session:kill";
  sessionId: string;
  serverId: string;
}
interface IncomingInput {
  type: "terminal:input";
  sessionId: string;
  data: string;
}
interface IncomingResize {
  type: "terminal:resize";
  sessionId: string;
  rows: number;
  cols: number;
  /** Optional — supplied by the new client; helps when the dashboard hasn't
   * cached which server hosts the session yet. */
  serverId?: string;
}
type IncomingMsg =
  | IncomingCreate
  | IncomingAttach
  | IncomingDetach
  | IncomingKill
  | IncomingInput
  | IncomingResize;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WS_OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.error(`[WS] send failed: ${m}`);
    }
  }
}

function getAttachments(ws: WebSocket): Map<string, AttachState> {
  let map = wsAttachments.get(ws);
  if (!map) {
    map = new Map();
    wsAttachments.set(ws, map);
  }
  return map;
}

/** Resolve the server id for a session. Tries the per-WS map first; falls
 *  back to a DB lookup. */
async function resolveServerId(
  ws: WebSocket,
  sessionId: string,
  hint?: string
): Promise<string | null> {
  if (hint) return hint;
  const attached = wsAttachments.get(ws)?.get(sessionId);
  if (attached) return attached.serverId;
  const rows = await db
    .select({ serverId: sessions.serverId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows[0]?.serverId ?? null;
}

async function handleAttachLifecycle(
  ws: WebSocket,
  serverId: string,
  sessionId: string,
  rows?: number,
  cols?: number
): Promise<void> {
  // Don't double-attach the same WS to the same session — produces double
  // input. If a previous attach is open, close it first.
  const map = getAttachments(ws);
  const existing = map.get(sessionId);
  if (existing) {
    try {
      existing.stream.destroy();
    } catch {
      /* ignore */
    }
    map.delete(sessionId);
  }

  const handle = await attachSession(serverId, sessionId, rows, cols);
  if (!handle) {
    sendJson(ws, {
      type: "session:lost",
      sessionId,
      reason: "Session no longer exists on the agent",
    });
    return;
  }

  const state: AttachState = {
    sessionId,
    serverId,
    stream: handle.stream,
  };
  map.set(sessionId, state);

  // Decode the byte stream as UTF-8 with **a stateful decoder** so
  // multi-byte characters that straddle chunk boundaries aren't
  // mangled. The agent ships raw PTY bytes; tools like `ls --color`,
  // emoji-laden prompts, or any non-ASCII output produce multi-byte
  // sequences. Calling `Buffer.toString("utf-8")` on each chunk
  // independently splits those sequences at random offsets and emits
  // U+FFFD replacement characters that xterm's parser then chokes on
  // (visible as repeated "Parsing error: code 192/204/255..." logs).
  // StringDecoder buffers the trailing partial bytes from each
  // chunk and prepends them to the next, which is exactly what we
  // need. One decoder per session — never reset across the
  // session's lifetime.
  const decoder = new StringDecoder("utf-8");

  // Flush the agent's scrollback replay first. The agent sends the
  // `Attached` JSON line and then immediately dumps the session's
  // scrollback ring — both usually land in the same TCP read.
  // `openAgentAttach` already split the handshake newline off and gave
  // us the trailing bytes as `initialBytes`. Forwarding them BEFORE we
  // attach the live `data` listener keeps the ordering deterministic
  // ("scrollback first, then live output") and matches what the user
  // expects when they re-open a tab on an existing session.
  if (handle.initialBytes.length > 0) {
    const text = decoder.write(handle.initialBytes);
    if (text.length > 0) {
      sendJson(ws, { type: "terminal:output", sessionId, data: text });
    }
  }

  // Pipe live agent output → browser. Attaching the listener auto-
  // resumes the stream (paused during handshake) so anything that
  // arrived in between sits in the internal buffer and now flows.
  handle.stream.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (text.length === 0) return; // chunk ended mid-codepoint
    sendJson(ws, { type: "terminal:output", sessionId, data: text });
  });

  handle.stream.on("close", () => {
    // Flush any trailing bytes from the decoder. In practice this is
    // never visible output (a partial UTF-8 sequence at EOF is
    // invalid), but it stops the decoder from holding onto bytes.
    const rest = decoder.end();
    if (rest.length > 0 && ws.readyState === WS_OPEN) {
      sendJson(ws, { type: "terminal:output", sessionId, data: rest });
    }
    const m = wsAttachments.get(ws);
    if (m && m.get(sessionId) === state) {
      m.delete(sessionId);
    }
    if (ws.readyState === WS_OPEN) {
      sendJson(ws, {
        type: "session:lost",
        sessionId,
        reason: "Agent stream closed",
      });
    }
  });

  handle.stream.on("error", (e: Error) => {
    console.error(`[WS] agent stream error for ${sessionId}: ${e.message}`);
  });

  // Synthesise a SessionSnapshot for backwards compatibility with the
  // existing browser code that expects this on attach/create.
  const snapshot: SessionSnapshot = {
    sessionId: handle.sessionId,
    serverId,
    sessionName: handle.sessionName,
    cwd: "",
    lastCommand: "",
    env: {},
    scrollBuffer: [],
    status: "active",
    retryCount: 0,
  };
  sendJson(ws, { type: "session:state", session: snapshot });
}

// ---------------------------------------------------------------------------
// Top-level message handler
// ---------------------------------------------------------------------------

async function handleMessage(ws: WebSocket, raw: string): Promise<void> {
  let msg: IncomingMsg;
  try {
    msg = JSON.parse(raw) as IncomingMsg;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[WS] bad JSON: ${m}`);
    return;
  }

  switch (msg.type) {
    case "session:create": {
      try {
        // Resolve the configured Unix user for this server so the agent
        // can spawn the shell as that user instead of as root. We look
        // it up here (not in the agent) because the dashboard is the
        // source of truth for per-server credentials — the agent only
        // sees what the wire protocol carries. Missing row → leave
        // `user` undefined and the agent keeps the legacy root-shell
        // behaviour rather than failing the create.
        const serverRows = await db
          .select({ username: servers.username })
          .from(servers)
          .where(eq(servers.id, msg.serverId))
          .limit(1);
        const username = serverRows[0]?.username;

        const created = await createSession(msg.serverId, {
          command: msg.command,
          name: msg.name,
          user: username,
        });
        // Immediately attach this WS to the new session.
        await handleAttachLifecycle(ws, msg.serverId, created.sessionId);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[WS] create failed: ${m}`);
        sendJson(ws, {
          type: "session:lost",
          sessionId: "",
          reason: `Failed to create session: ${m}`,
        });
      }
      break;
    }
    case "session:attach": {
      try {
        await handleAttachLifecycle(ws, msg.serverId, msg.sessionId);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[WS] attach failed: ${m}`);
        sendJson(ws, {
          type: "session:lost",
          sessionId: msg.sessionId,
          reason: `Failed to attach: ${m}`,
        });
      }
      break;
    }
    case "session:detach": {
      const map = wsAttachments.get(ws);
      const state = map?.get(msg.sessionId);
      if (state) {
        try {
          state.stream.destroy();
        } catch {
          /* ignore */
        }
        map!.delete(msg.sessionId);
      }
      break;
    }
    case "session:kill": {
      try {
        const map = wsAttachments.get(ws);
        const existing = map?.get(msg.sessionId);
        if (existing) {
          try {
            existing.stream.destroy();
          } catch {
            /* ignore */
          }
          map!.delete(msg.sessionId);
        }
        await killSession(msg.serverId, msg.sessionId);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[WS] kill failed: ${m}`);
      }
      break;
    }
    case "terminal:input": {
      const state = wsAttachments.get(ws)?.get(msg.sessionId);
      if (!state) {
        // Not attached yet — drop input. Browser will retry once the
        // attach completes.
        return;
      }
      try {
        state.stream.write(msg.data);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`[WS] input write failed: ${m}`);
      }
      break;
    }
    case "terminal:resize": {
      const serverId = await resolveServerId(ws, msg.sessionId, msg.serverId);
      if (!serverId) {
        return;
      }
      try {
        await resizeSession(serverId, msg.sessionId, msg.rows, msg.cols);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        // Resize is best-effort — not worth disconnecting the client over.
        console.warn(`[WS] resize failed for ${msg.sessionId}: ${m}`);
      }
      break;
    }
  }
}

function handleDisconnect(ws: WebSocket): void {
  const map = wsAttachments.get(ws);
  if (map) {
    for (const state of map.values()) {
      try {
        state.stream.destroy();
      } catch {
        /* ignore */
      }
    }
    wsAttachments.delete(ws);
  }
  wsToUser.delete(ws);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function extractUserId(req: IncomingMessage): string | null {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies: Record<string, string> = {};
    cookieHeader.split(";").forEach((part) => {
      const [key, ...rest] = part.trim().split("=");
      if (key) cookies[key.trim()] = rest.join("=");
    });
    const sessionToken =
      cookies["authjs.session-token"] ||
      cookies["next-auth.session-token"] ||
      cookies["__Secure-authjs.session-token"];
    if (sessionToken && sessionToken.length > 0) {
      return sessionToken;
    }
  }
  const parsed = parseUrl(req.url || "", true);
  const token = parsed.query.token;
  if (typeof token === "string" && token.length > 0) {
    return token;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

wss.on("connection", (ws: WebSocket) => {
  console.log("[WS] client connected");

  ws.on("message", (raw: Buffer | string) => {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    handleMessage(ws, data).catch((err: Error) => {
      console.error(`[WS] unhandled error: ${err.message}`);
    });
  });

  ws.on("close", () => {
    console.log("[WS] client disconnected");
    handleDisconnect(ws);
  });

  ws.on("error", (err: Error) => {
    console.error(`[WS] client error: ${err.message}`);
    handleDisconnect(ws);
  });
});

// Unused export kept for compatibility with any old import sites.
export type _SessionForAttach = Session;

export function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const userId = extractUserId(req);
  if (!userId) {
    console.log("[WS] upgrade rejected: no auth token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wsToUser.set(ws, userId);
    console.log("[WS] client authenticated");
    wss.emit("connection", ws, req);
  });
}
