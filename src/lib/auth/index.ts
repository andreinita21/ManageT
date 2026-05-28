/**
 * NextAuth v5 configuration for ManageT.
 * Uses credentials provider with scrypt password hashing.
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const SCRYPT_KEYLEN = 64;

/**
 * Hash a plaintext password using scrypt.
 * @returns `salt:hash` as hex strings
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored hash.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export const { auth, signIn, signOut, handlers } = NextAuth({
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username = credentials?.username;
        const password = credentials?.password;

        if (typeof username !== "string" || typeof password !== "string") {
          return null;
        }

        const rows = await db
          .select()
          .from(users)
          .where(eq(users.username, username))
          .limit(1);

        const user = rows[0];
        if (!user) return null;

        if (!verifyPassword(password, user.passwordHash)) {
          return null;
        }

        return {
          id: user.id,
          name: user.username,
          role: user.role,
        };
      },
    }),
  ],
  // Auth.js v5 refuses requests with an unfamiliar Host header in
  // production by default. Our custom server.ts setup doesn't trip the
  // Vercel-style auto-trust path, so login + every protected route
  // crashes with UntrustedHost. Trust whatever host the proxy/server
  // gives us — we're behind our own LAN.
  trustHost: true,
  session: { strategy: "jwt" },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as { role?: string }).role = token.role as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
});
