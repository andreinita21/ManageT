/**
 * Custom Next.js server for ManageT.
 * Adds WebSocket upgrade handling alongside the Next.js HTTP server.
 *
 * Sessions are owned by the per-host Rust agent (see agent/src/sessions),
 * not by this Node process. We do NOT mark anything as "stale" on
 * startup — the agent's `list` reconciliation handles that lazily on the
 * first relevant API call.
 */
import { createServer } from "http";
import next from "next";
import { handleUpgrade } from "./src/lib/ws/index.js";
import { initMonitoring } from "./src/lib/monitor/index.js";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();
const port = parseInt(process.env.PORT || "3000", 10);

app.prepare().then(async () => {
  initMonitoring();

  const server = createServer(handle);

  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/ws")) {
      handleUpgrade(req, socket, head);
    }
  });

  server.listen(port, () => {
    console.log(`> ManageT running on http://localhost:${port}`);
    console.log(`> WebSocket server ready at ws://localhost:${port}/api/ws`);
  });
});
