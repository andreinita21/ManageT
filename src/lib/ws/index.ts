/**
 * @fileoverview WebSocket server for ManageT.
 * Handles terminal I/O, session lifecycle, and real-time event forwarding
 * between the browser and SSH sessions.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parse as parseUrl } from "node:url";
import type { ClientMessage, ServerMessage } from "../../types";

/** WebSocket ready states */
const WS_OPEN = WebSocket.OPEN;

/** Map of userId to their connected WebSocket clients */
const clientsByUser = new Map<string, Set<WebSocket>>();

/** Map of WebSocket to the sessions it is subscribed to */
const subscriptions = new Map<WebSocket, Set<string>>();

/** Map of WebSocket to userId */
const wsToUser = new Map<WebSocket, string>();

/** The shared WebSocket server instance */
const wss = new WebSocketServer({ noServer: true });

/** Lazy-loaded session manager to avoid circular imports */
let _sessionManager: typeof import("../ssh/session-manager").sessionManager | null = null;
let _sessionManagerWired = false;

async function getSessionManager() {
  if (!_sessionManager) {
    const mod = await import("../ssh/session-manager");
    _sessionManager = mod.sessionManager;
  }
  return _sessionManager;
}

/**
 * Wire up SessionManager events to broadcast to WS clients.
 * Called once on first connection.
 */
async function wireSessionManagerEvents() {
  if (_sessionManagerWired) return;
  _sessionManagerWired = true;

  const sm = await getSessionManager();

  sm.on("session:output", (sessionId: string, data: string) => {
    broadcastToSession(sessionId, {
      type: "terminal:output",
      sessionId,
      data,
    });
  });

  sm.on("session:lost", (sessionId: string, reason: string) => {
    broadcastToSession(sessionId, {
      type: "session:lost",
      sessionId,
      reason,
    });
  });

  sm.on(
    "session:recovered",
    (
      sessionId: string,
      method: "reattach" | "recreate",
      command?: string,
      cwd?: string
    ) => {
      broadcastToSession(sessionId, {
        type: "session:recovered",
        sessionId,
        method,
        command,
        cwd,
      });
    }
  );

  // Note: `session:created` is intentionally NOT broadcast here.
  // The creating client receives `session:state` directly from the
  // `session:create` message handler below. Broadcasting to all clients
  // caused every pane to latch onto every new session, which routed input
  // to the wrong server.
}

/**
 * Send a typed server message to a WebSocket client.
 */
function sendMessage(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Broadcast a server message to all connected clients subscribed to a session.
 */
function broadcastToSession(sessionId: string, message: ServerMessage): void {
  for (const [ws, subs] of subscriptions) {
    if (subs.has(sessionId) && ws.readyState === WS_OPEN) {
      sendMessage(ws, message);
    }
  }
}

/**
 * Broadcast a server message to all connected clients.
 */
function broadcastToAll(message: ServerMessage): void {
  for (const ws of subscriptions.keys()) {
    sendMessage(ws, message);
  }
}

/**
 * Extract user ID from the upgrade request.
 * Checks for session cookie (authjs.session-token or next-auth.session-token).
 */
function extractUserId(req: IncomingMessage): string | null {
  // Check cookie for next-auth session
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    // Parse cookies manually (simple key=value; key=value)
    const cookies: Record<string, string> = {};
    cookieHeader.split(";").forEach((part) => {
      const [key, ...rest] = part.trim().split("=");
      if (key) cookies[key.trim()] = rest.join("=");
    });

    // NextAuth v5 uses authjs.session-token
    const sessionToken =
      cookies["authjs.session-token"] ||
      cookies["next-auth.session-token"] ||
      cookies["__Secure-authjs.session-token"];
    if (sessionToken && sessionToken.length > 0) {
      return sessionToken;
    }
  }

  // Check query parameter as fallback
  const parsed = parseUrl(req.url || "", true);
  const token = parsed.query.token;
  if (typeof token === "string" && token.length > 0) {
    return token;
  }

  return null;
}

/**
 * Handle an incoming WebSocket message from a client.
 */
async function handleMessage(ws: WebSocket, raw: string): Promise<void> {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    console.error("[WS] Failed to parse client message");
    return;
  }

  const sm = await getSessionManager();

  switch (message.type) {
    case "terminal:input": {
      try {
        const stream = await sm.attachSession(message.sessionId);
        if (!stream.write(message.data)) {
          stream.once("drain", () => {});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WS] Failed to write terminal input: ${msg}`);
      }
      break;
    }
    case "terminal:resize": {
      try {
        const stream = await sm.attachSession(message.sessionId);
        stream.setWindow(message.rows, message.cols, message.rows * 16, message.cols * 8);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WS] Failed to resize terminal: ${msg}`);
      }
      break;
    }
    case "session:create": {
      try {
        const snapshot = await sm.createSession(message.serverId, message.command, message.cwd);
        subscribeToSession(ws, snapshot.sessionId);
        sendMessage(ws, { type: "session:state", session: snapshot });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WS] Failed to create session: ${msg}`);
        sendMessage(ws, {
          type: "session:lost",
          sessionId: "",
          reason: `Failed to create session: ${msg}`,
        });
      }
      break;
    }
    case "session:attach": {
      try {
        await sm.attachSession(message.sessionId);
        subscribeToSession(ws, message.sessionId);
        const snapshot = sm.getSnapshot(message.sessionId);
        if (snapshot) {
          sendMessage(ws, { type: "session:state", session: snapshot });
          if (snapshot.scrollBuffer.length > 0) {
            const recentOutput = snapshot.scrollBuffer.slice(-50).join("");
            sendMessage(ws, { type: "terminal:output", sessionId: message.sessionId, data: recentOutput });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WS] Failed to attach session: ${msg}`);
        sendMessage(ws, { type: "session:lost", sessionId: message.sessionId, reason: `Failed to attach: ${msg}` });
      }
      break;
    }
    case "session:detach": {
      unsubscribeFromSession(ws, message.sessionId);
      sm.detachSession(message.sessionId);
      break;
    }
    case "session:kill": {
      try {
        await sm.killSession(message.sessionId);
        unsubscribeFromSession(ws, message.sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WS] Failed to kill session: ${msg}`);
      }
      break;
    }
  }
}

function subscribeToSession(ws: WebSocket, sessionId: string): void {
  let subs = subscriptions.get(ws);
  if (!subs) {
    subs = new Set();
    subscriptions.set(ws, subs);
  }
  subs.add(sessionId);
}

function unsubscribeFromSession(ws: WebSocket, sessionId: string): void {
  const subs = subscriptions.get(ws);
  if (subs) subs.delete(sessionId);
}

function handleDisconnect(ws: WebSocket): void {
  const userId = wsToUser.get(ws);
  if (userId) {
    const userClients = clientsByUser.get(userId);
    if (userClients) {
      userClients.delete(ws);
      if (userClients.size === 0) clientsByUser.delete(userId);
    }
    wsToUser.delete(ws);
  }
  subscriptions.delete(ws);
}

// --- WebSocket server connection handler ---

wss.on("connection", (ws: WebSocket) => {
  console.log("[WS] New client connected");

  ws.on("message", (raw: Buffer | string) => {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    handleMessage(ws, data).catch((err: Error) => {
      console.error(`[WS] Unhandled error: ${err.message}`);
    });
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
    handleDisconnect(ws);
  });

  ws.on("error", (err: Error) => {
    console.error(`[WS] Client error: ${err.message}`);
    handleDisconnect(ws);
  });
});

/**
 * Handle HTTP upgrade requests for WebSocket connections.
 */
export function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const userId = extractUserId(req);

  if (!userId) {
    console.log("[WS] Upgrade rejected: no valid auth token");
    console.log("[WS] Cookies:", req.headers.cookie ? "present" : "none");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Wire up session manager events on first connection
  wireSessionManagerEvents().catch((err) => {
    console.error("[WS] Failed to wire session manager:", err);
  });

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wsToUser.set(ws, userId);
    let userClients = clientsByUser.get(userId);
    if (!userClients) {
      userClients = new Set();
      clientsByUser.set(userId, userClients);
    }
    userClients.add(ws);
    subscriptions.set(ws, new Set());

    console.log(`[WS] Client authenticated (cookie-based)`);
    wss.emit("connection", ws, req);
  });
}
