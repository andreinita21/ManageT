/**
 * Authenticate an incoming agent request via its bearer token.
 *
 * This is NOT NextAuth — agents run on remote machines and cannot hold a
 * browser session. Each agent carries a per-server token issued at install
 * time, and the dashboard stores the sha256 hash in `servers.agent_token_hash`.
 */
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { hashToken } from "./token";

type ServerRow = typeof servers.$inferSelect;

/**
 * Extract the bearer token from the Authorization header and look up the
 * server row that matches its hash. Returns `null` if no Authorization
 * header is present, the scheme isn't Bearer, or no server matches.
 */
export async function authenticateAgent(req: Request): Promise<ServerRow | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^\s*Bearer\s+(.+)\s*$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;

  const hash = hashToken(token);
  const rows = await db
    .select()
    .from(servers)
    .where(eq(servers.agentTokenHash, hash))
    .limit(1);
  return rows[0] ?? null;
}
