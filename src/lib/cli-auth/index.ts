import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";

import { verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { userCliTokens, users } from "@/lib/db/schema";
import { CLI_TOKEN_PREFIX, hashCliToken } from "./token";
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
  });

  return {
    token,
    user: { id: user.id, username: user.username, role: user.role },
  };
}
