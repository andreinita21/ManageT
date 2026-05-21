/**
 * End-to-end smoke test of the per-server "Dashboard URL" push.
 *
 * Flow:
 *   1. Read the Pi's current api_url from the row (assumes the
 *      backfill UPDATE has been run so the column isn't NULL).
 *   2. Push a TEST URL via pushAgentReconfigure.
 *   3. SSH to the Pi and read /etc/managet-agent/config.toml to
 *      confirm the api_url field now reflects the new value.
 *   4. Push the original URL back so we don't leave the Pi pointed
 *      somewhere it can't reach.
 *
 * Run with `npx tsx scripts/test-reconfigure-pi.ts`.
 *
 * Exits non-zero if any step fails. Prints a tidy summary at the end.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

import { pushAgentReconfigure } from "../src/lib/agent/reconfigure";
import { connectionPool } from "../src/lib/ssh/connection-pool";
import { decryptPassword } from "../src/lib/crypto";
import { rowToServer } from "../src/lib/db/transform";

const PI_NAME = "markI (Pi)";
const TEST_URL = "http://192.168.100.10:3000";

const db = new Database("data/managet.db", { readonly: false });
const row = db
  .prepare("SELECT * FROM servers WHERE name = ?")
  .get(PI_NAME) as Record<string, unknown> | undefined;
db.close();

if (!row) throw new Error(`server '${PI_NAME}' not found`);
// Map the raw column names from the DB onto the camelCase Server type
// so we can hand it to connectionPool.connect(). The raw row uses
// snake_case (sqlite); transform expects the drizzle-shaped object.
const serverForPool = {
  id: row.id as string,
  name: row.name as string,
  host: row.host as string,
  port: row.port as number,
  username: row.username as string,
  authMethod: row.auth_method as "key" | "password",
  privateKeyPath: (row.private_key_path as string | null) ?? null,
  passwordEncrypted: (row.password_encrypted as string | null) ?? null,
  labels: (row.labels as string) ?? "[]",
  groupName: (row.group_name as string | null) ?? null,
  status: row.status as string,
  lastConnectedAt: (row.last_connected_at as number | null) ?? null,
  agentStatus: row.agent_status as string,
  agentTokenHash: null,
  agentVersion: null,
  agentArch: null,
  agentLastHeartbeatAt: null,
  agentInstallError: null,
  agentInstallStage: null,
  pendingUninstall: 0,
  heartbeatIntervalSecs: row.heartbeat_interval_secs as number,
  logLevel: row.log_level as string,
  autoUpdate: row.auto_update as number,
  sessionRetentionDays: row.session_retention_days as number,
  maxSessions: (row.max_sessions as number | null) ?? null,
  apiUrl: (row.api_url as string | null) ?? null,
  createdBy: row.created_by as string,
  createdAt: row.created_at as number,
  updatedAt: row.updated_at as number,
};
const server = rowToServer(serverForPool as unknown as Parameters<typeof rowToServer>[0]);
if (!server.apiUrl) throw new Error(`server '${PI_NAME}' has no api_url backfilled — run the UPDATE first`);
const originalUrl = server.apiUrl;
const password = decryptPassword(server.passwordEncrypted!);

console.log(`[smoke] target: ${PI_NAME} (${server.host})`);
console.log(`[smoke] current api_url: ${originalUrl}`);
console.log(`[smoke] test api_url:    ${TEST_URL}`);

function readRemoteApiUrl(): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => {
      const cmd = `echo ${JSON.stringify(password)} | sudo -S -p '' cat /etc/managet-agent/config.toml`;
      c.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = "";
        stream.on("data", (d: Buffer) => (out += d.toString()));
        stream.on("close", () => {
          c.end();
          const m = out.match(/api_url\s*=\s*"([^"]+)"/);
          if (!m) return reject(new Error(`could not parse api_url from\n${out}`));
          resolve(m[1]);
        });
      });
    });
    c.on("error", reject);
    c.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password,
      readyTimeout: 30_000,
    });
  });
}

async function main() {
  // Open an SSH connection in the pool — pushAgentReconfigure relies
  // on executeCommand, which looks up the already-connected client.
  console.log("[smoke] step 0 — opening SSH connection");
  await connectionPool.connect(server);

  console.log("\n[smoke] step 1 — push TEST_URL via pushAgentReconfigure");
  const push1 = await pushAgentReconfigure(server.id, { apiUrl: TEST_URL });
  if (!push1.ok) throw new Error(`push #1 failed: ${push1.error}`);
  console.log("        push ok");

  // Wait a beat for the restart.
  await new Promise((r) => setTimeout(r, 2_000));

  console.log("[smoke] step 2 — read config.toml back via SSH");
  const seen1 = await readRemoteApiUrl();
  console.log(`        config.toml api_url = ${seen1}`);
  if (seen1 !== TEST_URL) {
    throw new Error(`mismatch — expected ${TEST_URL}, got ${seen1}`);
  }

  console.log("\n[smoke] step 3 — restore original URL");
  const push2 = await pushAgentReconfigure(server.id, { apiUrl: originalUrl });
  if (!push2.ok) throw new Error(`push #2 failed: ${push2.error}`);
  console.log("        push ok");

  await new Promise((r) => setTimeout(r, 2_000));

  const seen2 = await readRemoteApiUrl();
  console.log(`        config.toml api_url = ${seen2}`);
  if (seen2 !== originalUrl) {
    throw new Error(`restore mismatch — expected ${originalUrl}, got ${seen2}`);
  }

  console.log("\n\x1b[1;32m✓ pushAgentReconfigure works end-to-end on Pi.\x1b[0m");
}

main().catch((err) => {
  console.error(`\n\x1b[1;31m✗ smoke test failed: ${err.message ?? err}\x1b[0m`);
  process.exit(1);
});
