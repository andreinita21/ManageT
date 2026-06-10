import { createHash } from "node:crypto";
import { and, eq, isNull, or, gt } from "drizzle-orm";

import { db } from "@/lib/db";
import { userCliTokens } from "@/lib/db/schema";

export const CLI_TOKEN_PREFIX = "mgt_";

/** Default lifetime for a newly minted CLI token (90 days). */
export const CLI_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function hashCliToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function extractBearerToken(
  authorization: string | string[] | null | undefined
): string | null {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export async function getUserIdForCliToken(token: string): Promise<string | null> {
  if (!token.startsWith(CLI_TOKEN_PREFIX)) return null;
  const now = Date.now();
  const rows = await db
    .select({ id: userCliTokens.id, userId: userCliTokens.userId })
    .from(userCliTokens)
    .where(
      and(
        eq(userCliTokens.tokenHash, hashCliToken(token)),
        isNull(userCliTokens.revokedAt),
        // Not expired: either no expiry set (legacy) or still in the future.
        or(isNull(userCliTokens.expiresAt), gt(userCliTokens.expiresAt, now))
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  await db
    .update(userCliTokens)
    .set({ lastUsedAt: Date.now() })
    .where(eq(userCliTokens.id, row.id));
  return row.userId;
}

export async function requireCliUserId(request: Request): Promise<string> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) throw new Error("Unauthorized");
  const userId = await getUserIdForCliToken(token);
  if (!userId) throw new Error("Unauthorized");
  return userId;
}
