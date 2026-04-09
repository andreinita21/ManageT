/**
 * Custom Next.js server for ManageT.
 * Adds WebSocket upgrade handling alongside the Next.js HTTP server.
 */
import { createServer } from "http";
import next from "next";
import { handleUpgrade } from "./src/lib/ws";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();
const port = parseInt(process.env.PORT || "3000", 10);

app.prepare().then(() => {
  const server = createServer(handle);
  server.on("upgrade", handleUpgrade);
  server.listen(port, () => {
    console.log(`> ManageT running on http://localhost:${port}`);
  });
});
