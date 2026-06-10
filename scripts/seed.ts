/**
 * Seed script for ManageT.
 * Creates a default admin user in the database.
 *
 * Usage:
 *   MANAGET_ADMIN_PASSWORD='…' npx tsx scripts/seed.ts
 *   (optionally MANAGET_ADMIN_USERNAME, defaults to "admin")
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { requireEnv } from "./_creds.js";

const USERNAME = process.env.MANAGET_ADMIN_USERNAME || "admin";
const PASSWORD = requireEnv(
  "MANAGET_ADMIN_PASSWORD",
  "Choose a strong password for the seeded admin user."
);
const ROLE = "admin" as const;

async function seed() {
  // Ensure data/ directory exists
  const projectRoot = resolve(__dirname, "..");
  const dataDir = resolve(projectRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  console.log(`[seed] data/ directory ready at ${dataDir}`);

  // Run drizzle migrations to ensure tables exist
  console.log("[seed] Running drizzle migrations...");
  execSync("npx drizzle-kit migrate", {
    cwd: projectRoot,
    stdio: "inherit",
  });
  console.log("[seed] Migrations complete.");

  // Dynamic imports after migrations
  const { hashPassword } = await import("../src/lib/auth/index.js");
  const { db } = await import("../src/lib/db/index.js");
  const { users } = await import("../src/lib/db/schema.js");
  // Check if user already exists
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.username, USERNAME))
    .limit(1);

  if (existing.length > 0) {
    console.log(`[seed] Admin user already exists (${USERNAME}). Skipping.`);
    return;
  }

  const now = Date.now();
  const id = uuidv4();
  const passwordHash = hashPassword(PASSWORD);

  await db.insert(users).values({
    id,
    username: USERNAME,
    passwordHash,
    role: ROLE,
    createdAt: now,
    updatedAt: now,
  });

  console.log("");
  console.log("=== Default Admin User Created ===");
  console.log(`  Username: ${USERNAME}`);
  console.log(`  Password: (set via MANAGET_ADMIN_PASSWORD)`);
  console.log(`  Role:     ${ROLE}`);
  console.log("==================================");
  console.log("");
}

seed()
  .then(() => {
    console.log("[seed] Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[seed] Error:", err);
    process.exit(1);
  });
