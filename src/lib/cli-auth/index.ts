import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";

import { verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { userCliTokens, users } from "@/lib/db/schema";
import { CLI_TOKEN_PREFIX, CLI_TOKEN_TTL_MS, hashCliToken } from "./token";
export { extractBearerToken, getUserIdForCliToken, requireCliUserId } from "./token";

export async function createCliToken(input: {
  username: string;
  password: string;
  name?: string;
}): Promise<{
  token: string;
  user: { id: string; username: string; role: string };
}> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);
  const user = rows[0];
  if (!user || !verifyPassword(input.password, user.passwordHash)) {
    throw new Error("Invalid username or password");
  }

  const token = `${CLI_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  await db.insert(userCliTokens).values({
    id: uuidv4(),
    userId: user.id,
    name: input.name?.trim() || "managet CLI",
    tokenHash: hashCliToken(token),
    createdAt: now,
    lastUsedAt: now,
    revokedAt: null,
    expiresAt: now + CLI_TOKEN_TTL_MS,
  });

  return {
    token,
    user: { id: user.id, username: user.username, role: user.role },
  };
}

/**
 * Revoke every active CLI token belonging to a user ("log out all CLI
 * sessions"). Idempotent. Returns the number of tokens revoked.
 */
export async function revokeAllCliTokensForUser(userId: string): Promise<number> {
  const active = await db
    .select({ id: userCliTokens.id })
    .from(userCliTokens)
    .where(and(eq(userCliTokens.userId, userId), isNull(userCliTokens.revokedAt)));
  if (active.length === 0) return 0;
  await db
    .update(userCliTokens)
    .set({ revokedAt: Date.now() })
    .where(and(eq(userCliTokens.userId, userId), isNull(userCliTokens.revokedAt)));
  return active.length;
}
