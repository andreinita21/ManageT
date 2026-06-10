/**
 * One-off: rename the existing admin user and reset their password.
 *
 *   MANAGET_ADMIN_PASSWORD='…' npx tsx scripts/update-admin-creds.ts
 *   (optionally MANAGET_ADMIN_USERNAME, defaults to "admin")
 *
 * Credentials come from the environment — never hardcode them. Idempotent;
 * re-running just rewrites the row.
 */
import { eq } from "drizzle-orm";
import { hashPassword } from "../src/lib/auth/index.js";
import { db } from "../src/lib/db/index.js";
import { users } from "../src/lib/db/schema.js";
import { requireEnv } from "./_creds.js";

const NEW_USERNAME = process.env.MANAGET_ADMIN_USERNAME || "admin";
const NEW_PASSWORD = requireEnv(
  "MANAGET_ADMIN_PASSWORD",
  "Choose a strong new admin password."
);

async function main() {
  // Find the existing admin row (by role first, falling back to the seed
  // username so this script keeps working even after a fresh seed).
  const adminRows = await db
    .select()
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  const seedRows =
    adminRows.length === 0
      ? await db
          .select()
          .from(users)
          .where(eq(users.username, NEW_USERNAME))
          .limit(1)
      : [];
  const target = adminRows[0] ?? seedRows[0];
  if (!target) {
    throw new Error(
      "no admin user found in the database. Run `npx tsx scripts/seed.ts` first."
    );
  }

  await db
    .update(users)
    .set({
      username: NEW_USERNAME,
      passwordHash: hashPassword(NEW_PASSWORD),
      updatedAt: Date.now(),
    })
    .where(eq(users.id, target.id));

  console.log(
    `Updated admin user ${target.id.slice(0, 8)}: username=${NEW_USERNAME}, password=(set via MANAGET_ADMIN_PASSWORD)`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
