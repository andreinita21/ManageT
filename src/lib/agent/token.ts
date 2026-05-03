/**
 * Agent bearer-token helpers.
 *
 * Tokens are 32-byte cryptographic secrets. The plaintext is handed to the
 * agent exactly once (during install) and never persisted server-side — we
 * only store a sha256 hash in `servers.agent_token_hash`.
 */
import { createHash, randomBytes } from "node:crypto";

/** Generate a fresh 64-hex-char bearer token. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** sha256 hex of a token, used for DB lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
