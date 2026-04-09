/**
 * @fileoverview WebSocket server for ManageT.
 * Handles terminal I/O, session lifecycle, and real-time event forwarding
 * between the browser and SSH sessions.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { parse as parseUrl } from "node:url";
import { parse as parseCookie } from "node:querystring";
import { sessionManager } from "@/lib/ssh/session-manager";
import type { ClientMessage, ServerMessage, SessionSnapshot } from "@/types";

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

/**
 * Send a typed server message to a WebSocket client.
 * Silently drops if the socket is not open.
 */
function sendMessage(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Broadcast a server message to all WebSocket clients of a user.
 */
function broadcastToUser(userId: string, message: ServerMessage): void {
  const clients = clientsByUser.get(userId);
  if (!clients) return;
  for (const ws of clients) {
    sendMessage(ws, message);
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
 * Checks for a token query parameter or session cookie.
 * In production this should validate a JWT or session token.
 */
function extractUserId(req: IncomingMessage): string | null {
  const parsed = parseUrl(req.url || "", true);

  // Check query parameter
  const token = parsed.query.token;
  if (typeof token === "string" && token.length > 0) {
    // In production, decode and verify JWT here
    return token;
  }

  // Check cookie for next-auth session
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookie(cookieHeader, "; ");
    const sessionToken = cookies["next-auth.session-token"];
    if (typeof sessionToken === "string" && sessionToken.length > 0) {
      // In production, verify this session token against the DB/JWT
      return sessionToken;
    }
  }

  return null;
}

/**
 * Handle an incoming WebSocket message from a client.
 */
async function handleMessage(
  ws: WebSocket,
  raw: string
): Promise<void> {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    console.error("[WS] Failed to parse client message");
    return;
  }

  switch (message.type) {
    case "terminal:input": {
      await handleTerminalInput(ws, message.sessionId, message.data);
      break;
    }
    case "terminal:resize": {
      await handleTerminalResize(
        message.sessionId,
        message.cols,
        message.rows
      );
      break;
    }
    case "session:create": {
      await handleSessionCreate(ws, message.serverId, message.command, message.cwd);
      break;
    }
    case "session:attach": {
      await handleSessionAttach(ws, message.sessionId);
      break;
    }
    case "session:detach": {
      handleSessionDetach(ws, message.sessionId);
      break;
    }
    case "session:kill": {
      await handleSessionKill(ws, message.sessionId);
      break;
    }
  }
}

/**
 * Handle terminal input by writing to the session's SSH stream.
 */
async function handleTerminalInput(
  _ws: WebSocket,
  sessionId: string,
  data: string
): Promise<void> {
  try {
    const stream = await sessionManager.attachSession(sessionId);
    if (!stream.write(data)) {
      stream.once("drain", () => {
        // Backpressure resolved
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WS] Failed to write terminal input for ${sessionId}: ${msg}`);
  }
}

/**
 * Handle terminal resize by sending a window change to the SSH stream.
 */
async function handleTerminalResize(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  try {
    const stream = await sessionManager.attachSession(sessionId);
    stream.setWindow(rows, cols, rows * 16, cols * 8);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WS] Failed to resize terminal for ${sessionId}: ${msg}`);
  }
}

/**
 * Handle session creation request.
 */
async function handleSessionCreate(
  ws: WebSocket,
  serverId: string,
  command?: string,
  cwd?: string
): Promise<void> {
  try {
    const snapshot = await sessionManager.createSession(serverId, command, cwd);
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
}

/**
 * Handle session attach request.
 */
async function handleSessionAttach(
  ws: WebSocket,
  sessionId: string
): Promise<void> {
  try {
    await sessionManager.attachSession(sessionId);
    subscribeToSession(ws, sessionId);

    const snapshot = sessionManager.getSnapshot(sessionId);
    if (snapshot) {
      sendMessage(ws, { type: "session:state", session: snapshot });

      // Send buffered output so the client can see recent history
      if (snapshot.scrollBuffer.length > 0) {
        const recentOutput = snapshot.scrollBuffer.slice(-50).join("");
        sendMessage(ws, {
          type: "terminal:output",
          sessionId,
          data: recentOutput,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WS] Failed to attach session ${sessionId}: ${msg}`);
    sendMessage(ws, {
      type: "session:lost",
      sessionId,
      reason: `Failed to attach: ${msg}`,
    });
  }
}

/**
 * Handle session detach request.
 */
function handleSessionDetach(ws: WebSocket, sessionId: string): void {
  unsubscribeFromSession(ws, sessionId);
  sessionManager.detachSession(sessionId);
}

/**
 * Handle session kill request.
 */
async function handleSessionKill(
  ws: WebSocket,
  sessionId: string
): Promise<void> {
  try {
    await sessionManager.killSession(sessionId);
    unsubscribeFromSession(ws, sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WS] Failed to kill session ${sessionId}: ${msg}`);
  }
}

/**
 * Subscribe a WebSocket client to receive output from a session.
 */
function subscribeToSession(ws: WebSocket, sessionId: string): void {
  let subs = subscriptions.get(ws);
  if (!subs) {
    subs = new Set();
    subscriptions.set(ws, subs);
  }
  subs.add(sessionId);
}

/**
 * Unsubscribe a WebSocket client from a session.
 */
function unsubscribeFromSession(ws: WebSocket, sessionId: string): void {
  const subs = subscriptions.get(ws);
  if (subs) {
    subs.delete(sessionId);
  }
}

/**
 * Clean up all state when a WebSocket disconnects.
 */
function handleDisconnect(ws: WebSocket): void {
  const userId = wsToUser.get(ws);
  if (userId) {
    const userClients = clientsByUser.get(userId);
    if (userClients) {
      userClients.delete(ws);
      if (userClients.size === 0) {
        clientsByUser.delete(userId);
      }
    }
    wsToUser.delete(ws);
  }
  subscriptions.delete(ws);
}

// --- Wire up SessionManager events to broadcast to WS clients ---

sessionManager.on("session:output", (sessionId: string, data: string) => {
  broadcastToSession(sessionId, {
    type: "terminal:output",
    sessionId,
    data,
  });
});

sessionManager.on("session:lost", (sessionId: string, reason: string) => {
  broadcastToAll({
    type: "session:lost",
    sessionId,
    reason,
  });
});

sessionManager.on(
  "session:recovered",
  (
    sessionId: string,
    method: "reattach" | "recreate",
    command?: string,
    cwd?: string
  ) => {
    broadcastToAll({
      type: "session:recovered",
      sessionId,
      method,
      command,
      cwd,
    });
  }
);

sessionManager.on("session:created", (snapshot: SessionSnapshot) => {
  broadcastToAll({
    type: "session:state",
    session: snapshot,
  });
});

// --- WebSocket server connection handler ---

wss.on("connection", (ws: WebSocket) => {
  console.log("[WS] New client connected");

  ws.on("message", (raw: Buffer | string) => {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    handleMessage(ws, data).catch((err: Error) => {
      console.error(`[WS] Unhandled error in message handler: ${err.message}`);
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
 * Verifies authentication before completing the upgrade.
 *
 * @param req - The incoming HTTP upgrade request
 * @param socket - The network socket
 * @param head - The first packet of the upgrade stream
 */
export function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const userId = extractUserId(req);

  if (!userId) {
    console.log("[WS] Upgrade rejected: no valid auth token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    // Track the user-to-ws mapping
    wsToUser.set(ws, userId);
    let userClients = clientsByUser.get(userId);
    if (!userClients) {
      userClients = new Set();
      clientsByUser.set(userId, userClients);
    }
    userClients.add(ws);

    // Initialize subscriptions
    subscriptions.set(ws, new Set());

    console.log(`[WS] Client authenticated as user ${userId}`);
    wss.emit("connection", ws, req);
  });
}
