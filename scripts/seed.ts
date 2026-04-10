/**
 * Seed script for ManageT.
 * Creates a default admin user in the database.
 *
 * Usage: npx tsx scripts/seed.ts
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";

const EMAIL = "admin@managet.local";
const PASSWORD = "admin";
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
    .where(eq(users.email, EMAIL))
    .limit(1);

  if (existing.length > 0) {
    console.log(`[seed] Admin user already exists (${EMAIL}). Skipping.`);
    return;
  }

  const now = Date.now();
  const id = uuidv4();
  const passwordHash = hashPassword(PASSWORD);

  await db.insert(users).values({
    id,
    email: EMAIL,
    passwordHash,
    role: ROLE,
    createdAt: now,
    updatedAt: now,
  });

  console.log("");
  console.log("=== Default Admin User Created ===");
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
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
