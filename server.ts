/**
 * Custom Next.js server for ManageT.
 * Adds WebSocket upgrade handling alongside the Next.js HTTP server.
 */
import { createServer } from "http";
import next from "next";
import { handleUpgrade } from "./src/lib/ws/index.js";
import { initMonitoring } from "./src/lib/monitor/index.js";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();
const port = parseInt(process.env.PORT || "3000", 10);

/**
 * On startup, mark all sessions whose status implies an in-memory PTY stream
 * as "disconnected". The session manager keeps PTY streams in process memory,
 * so any restart of this Node process invalidates them. Without this cleanup
 * the client would try to reattach to a session id whose stream no longer
 * exists and get a "session not found" error.
 */
async function markStaleSessionsDisconnected(): Promise<void> {
  const { db } = await import("./src/lib/db/index.js");
  const { sessions } = await import("./src/lib/db/schema.js");
  const { inArray } = await import("drizzle-orm");
  const now = Date.now();
  const result = await db
    .update(sessions)
    .set({ status: "disconnected", disconnectedAt: now, updatedAt: now })
    .where(inArray(sessions.status, ["active", "reconnecting", "recovering"]));
  console.log(`> Marked stale sessions as disconnected`, result);
}

app.prepare().then(async () => {
  await markStaleSessionsDisconnected().catch((err) => {
    console.error("> Failed to mark stale sessions:", err);
  });

  // Bring the metric collector / alert engine / pruner online and have them
  // listen to connection-pool events. Without this call, the dashboard never
  // sees CPU/memory data because nothing is ever polling.
  initMonitoring();

  const server = createServer(handle);

  server.on("upgrade", (req, socket, head) => {
    // Only handle /api/ws upgrades
    if (req.url?.startsWith("/api/ws")) {
      handleUpgrade(req, socket, head);
    } else {
      // Let Next.js HMR WebSocket through
      // Don't destroy - Next.js dev server needs its own WS
    }
  });

  server.listen(port, () => {
    console.log(`> ManageT running on http://localhost:${port}`);
    console.log(`> WebSocket server ready at ws://localhost:${port}/api/ws`);
  });
});
