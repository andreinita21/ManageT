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
import { StringDecoder } from "node:string_decoder";
import { eq } from "drizzle-orm";
import { getToken } from "next-auth/jwt";

import { extractBearerToken, getUserIdForCliToken } from "@/lib/cli-auth/token";
import { db } from "@/lib/db";
import { servers, sessions } from "@/lib/db/schema";
import {
  attachSession,
  createSession,
  killSession,
  resizeSession,
} from "@/lib/ssh/session-manager";

/** Server states that block terminal interactions from the browser.
 *  `manually_stopped` is the operator-initiated freeze we want a clear
 *  message on; the others are pre-/post-deploy states where the
 *  agent socket simply isn't there to talk to. */
const TERMINAL_BLOCKED_STATUSES: ReadonlyArray<string> = [
  "manually_stopped",
  "not_installed",
  "installing",
  "install_failed",
  "uninstalling",
  "uninstall_failed",
];

/** Look up just enough server state to decide whether terminal-shaped
 *  WS operations should be allowed. Returns null when no server with
 *  that id exists (caller should bubble up an error). */
async function serverGate(
  serverId: string
): Promise<{ agentStatus: string } | null> {
  const rows = await db
    .select({ agentStatus: servers.agentStatus })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return rows[0] ?? null;
}

function blockedReason(status: string): string {
  if (status === "manually_stopped") {
    return (
      "This server is temporarily not accessible because the " +
      "`managet stop` command was issued. Run `managet start` on " +
      "the host to resume receiving data."
    );
  }
  return `Agent is currently '${status}'; terminal operations are unavailable.`;
}
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

// `tsx` loads server.ts (and this file) as its own ESM copy of the
// module, while Next.js bundles every API route as a self-contained
// chunk that imports `@/lib/ws` *separately*. Without intervention each
// copy ends up with its own `wss` (and its own `wss.clients` set), so a
// route that calls `broadcastToAll` writes to an empty Set while the
// real clients live on server.ts's instance. Pinning the WSS to
// `globalThis` so every copy shares one instance is the standard
// Next.js custom-server fix for this class of bug.
type GlobalWsState = {
  wss?: WebSocketServer;
  listenersRegistered?: boolean;
};
const __globalWs = globalThis as unknown as { __managetWs?: GlobalWsState };
__globalWs.__managetWs ??= {};
const wss: WebSocketServer =
  __globalWs.__managetWs.wss ??
  (__globalWs.__managetWs.wss = new WebSocketServer({ noServer: true }));

/**
 * Push a payload to every currently-connected WebSocket. Used for
 * out-of-band notifications that aren't tied to a specific session —
 * e.g. group membership changed via the REST API, so the dashboard's
 * group view needs to refetch. Stays in-process: API routes import this
 * directly since the WS server and the Next.js handlers share the
 * Node process.
 */
export function broadcastToAll(payload: object): void {
  const text = JSON.stringify(payload);
  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState === WS_OPEN) {
      try {
        client.send(text);
        sent++;
      } catch {
        /* a dead client shouldn't break the broadcast loop */
      }
    }
  }
  console.log(`[WS] broadcast ${JSON.stringify(payload)} → ${sent} client(s)`);
}

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
        // Refuse to spawn on a server the operator has manually
        // stopped (or one that's not in a state where the agent
        // socket is reachable). The browser disables the New
        // Terminal button when it sees the same status, but the
        // server-side check is the authoritative one in case the
        // client misses a refresh.
        const gate = await serverGate(msg.serverId);
        if (!gate) {
          sendJson(ws, {
            type: "session:lost",
            sessionId: "",
            reason: `Unknown server ${msg.serverId}`,
          });
          break;
        }
        if (TERMINAL_BLOCKED_STATUSES.includes(gate.agentStatus)) {
          sendJson(ws, {
            type: "session:lost",
            sessionId: "",
            reason: blockedReason(gate.agentStatus),
          });
          break;
        }

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
        const gate = await serverGate(msg.serverId);
        if (gate && TERMINAL_BLOCKED_STATUSES.includes(gate.agentStatus)) {
          sendJson(ws, {
            type: "session:lost",
            sessionId: msg.sessionId,
            reason: blockedReason(gate.agentStatus),
          });
          break;
        }
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

/**
 * Validate the upgrade request against the NextAuth session cookie and
 * return the authenticated user id, or `null` if the request isn't
 * a logged-in user.
 *
 * Previous version of this function trusted the raw cookie value as
 * the user id and also accepted *any* non-empty `?token=` query param
 * — so any external client that knew or guessed the WS URL could
 * upgrade and start spawning shells. We now:
 *
 *   1. Drop the `?token=` escape hatch entirely. It existed for early
 *      WS-from-CLI experiments that never shipped, and it bypasses
 *      cookie-based auth completely. Anything legitimate that needs
 *      to call into the WS layer can carry the standard session
 *      cookie.
 *   2. Run the cookie through `getToken` from `next-auth/jwt`, which
 *      verifies the JWT/JWE signature against `AUTH_SECRET` and
 *      returns the decoded payload only on success.
 *   3. Pull the `id` claim our `jwt` callback in `lib/auth/index.ts`
 *      sets — that's the real users.id, not the cookie blob.
 *
 * On any error (missing secret, bad cookie, expired token) the
 * function returns `null` and the upgrade is refused. Fail-closed.
 */
async function extractUserId(req: IncomingMessage): Promise<string | null> {
  const bearer = extractBearerToken(req.headers.authorization);
  if (bearer) {
    return getUserIdForCliToken(bearer);
  }

  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    // Server is misconfigured; refusing the upgrade is the safest
    // behaviour. A loud log line surfaces it during deploys.
    console.error(
      "[WS] AUTH_SECRET / NEXTAUTH_SECRET not set — refusing every upgrade"
    );
    return null;
  }
  try {
    // `getToken` only checks ONE cookie-name variant per call — which
    // one depends on `secureCookie`. Behind a TLS-terminating proxy
    // (Cloudflare tunnel in our deployment) the browser holds a
    // `__Secure-authjs.session-token` cookie set during an HTTPS
    // response, but the upgrade request reaches us as HTTP and
    // `getToken`'s auto-detect picks the un-prefixed name. The cookie
    // name is also the JWE salt, so the wrong variant doesn't just
    // miss the read — it fails decryption.
    //
    // Try both modes and accept the first one that decodes. Cheap (a
    // single sha256 on miss) and robust to either deployment topology.
    for (const secureCookie of [true, false]) {
      const jwt = await getToken({
        req: req as unknown as Request,
        secret,
        secureCookie,
      });
      if (jwt) {
        const userId =
          (jwt.id as string | undefined) ?? (jwt.sub as string | undefined);
        if (userId) return userId;
      }
    }
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[WS] auth validation failed: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

// Only the *first* copy of this module to load gets to wire up the
// per-connection handlers. A second copy (the bundled API route) would
// otherwise double-attach them and we'd process every byte twice.
if (!__globalWs.__managetWs.listenersRegistered) {
  __globalWs.__managetWs.listenersRegistered = true;

  // Liveness flag per socket. The keepalive interval below pings every
  // client; a healthy client answers with a pong which flips this back to
  // true. This is also what defeats the Cloudflare Tunnel's ~100s idle
  // WebSocket timeout: without traffic the proxy silently drops idle
  // sockets, the browser then reconnects and re-renders the replayed
  // scrollback, which the user saw as the prompt/`logout` lines repeating.
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (ws: WebSocket) => {
    console.log("[WS] client connected");
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

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

  // Keepalive sweep: ping every client every 30s (well under the ~100s
  // proxy idle cap); terminate any that missed the previous pong.
  const KEEPALIVE_MS = 30_000;
  const keepalive = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, KEEPALIVE_MS);
  // Don't keep the event loop alive solely for the keepalive timer.
  if (typeof keepalive.unref === "function") keepalive.unref();
}

// Unused export kept for compatibility with any old import sites.
export type _SessionForAttach = Session;

/**
 * Reject upgrade requests whose Origin header doesn't match the host
 * we're listening on. Without this, a malicious site could open a
 * WebSocket from the user's browser (the cookies tag along
 * automatically), guess a session id, and start running shells. The
 * Same-Origin Policy doesn't apply to WebSocket connect itself —
 * only to the data read back over them — so this manual check is
 * the standard CSRF defence.
 *
 * `NEXTAUTH_URL` (when set, e.g. behind a proxy) plus the request's
 * own Host header are both accepted. Connections without an Origin
 * header (non-browser clients like `wscat`) are allowed when
 * `WS_ALLOW_NO_ORIGIN=1` — defaults to refuse, because real browsers
 * always send one.
 */
function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    if (extractBearerToken(req.headers.authorization)) return true;
    return process.env.WS_ALLOW_NO_ORIGIN === "1";
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const reqHost = req.headers.host;
  if (reqHost && originHost === reqHost) return true;

  const configured = process.env.NEXTAUTH_URL ?? process.env.AUTH_URL;
  if (configured) {
    try {
      if (new URL(configured).host === originHost) return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

export function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  // The raw upgrade socket can emit 'error' (ECONNRESET/EPIPE) at any time,
  // including during the awaited auth work below. With no listener, Node
  // re-throws on the socket and crashes the whole process (a pre-auth remote
  // DoS). Attach a listener first so a client reset just tears down the one
  // connection.
  socket.on("error", () => {
    socket.destroy();
  });

  // Best-effort write that never throws on an already-dead socket.
  const refuse = (statusLine: string) => {
    try {
      if (!socket.destroyed) socket.write(statusLine);
    } catch {
      /* socket already gone */
    }
    socket.destroy();
  };

  if (!isOriginAllowed(req)) {
    console.log(
      `[WS] upgrade rejected: origin '${req.headers.origin ?? "<none>"}' not allowed for host '${req.headers.host ?? "<none>"}'`
    );
    refuse("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  // `extractUserId` is now async (it verifies the JWT). The upgrade
  // handler is sync per Node's `'upgrade'` event contract, so we kick
  // off the validation and await it inside a small wrapper. The
  // socket stays untouched until we have a verdict; failure → 401 +
  // destroy. We don't keep-alive the socket on rejection because a
  // legitimate browser will reconnect over a fresh TCP handshake.
  void (async () => {
    const userId = await extractUserId(req);
    // The client may have reset the connection while we verified the JWT.
    if (socket.destroyed) return;
    if (!userId) {
      console.log("[WS] upgrade rejected: invalid or missing session");
      refuse("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wsToUser.set(ws, userId);
      console.log(`[WS] client authenticated (user=${userId})`);
      wss.emit("connection", ws, req);
    });
  })();
}
