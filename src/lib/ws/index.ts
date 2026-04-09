/**
 * WebSocket upgrade handler for ManageT.
 * Placeholder — will be implemented by the WebSocket agent.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Handle HTTP upgrade requests for WebSocket connections.
 * Currently a no-op placeholder.
 */
export function handleUpgrade(
  _req: IncomingMessage,
  _socket: Duplex,
  _head: Buffer
): void {
  // Will be implemented by the WebSocket/terminal agent
}
