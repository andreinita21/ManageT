/**
 * SSH-based uninstall fallback.
 *
 * The happy path for removing an agent is the soft-delete / heartbeat-ack
 * flow: we flip `pendingUninstall=1`, the agent's next heartbeat gets a
 * `uninstall` directive, it self-cleans and then POSTs to
 * `/api/agent/uninstalled` which hard-deletes the server row.
 *
 * This module handles the *un*-happy path — when the agent hasn't checked
 * in recently (crashed, host rebooted, network partition) but the remote
 * box is still reachable over SSH. We log in, run `managet-agent uninstall`
 * directly, and then the DELETE endpoint finishes the row deletion.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { rowToServer } from "@/lib/db/transform";
import { decryptPassword } from "@/lib/crypto";
import { connectionPool } from "@/lib/ssh/connection-pool";
import { executeCommand } from "@/lib/ssh/exec";

export interface UninstallResult {
  ok: boolean;
  error?: string;
}

/**
 * Attempt to SSH into the server and run `managet-agent uninstall`.
 *
 * Tries a few likely binary locations (`/usr/local/bin` for installed paths,
 * and a bare `managet-agent` in case PATH is set). If any location succeeds
 * we consider the uninstall done. Caller is responsible for hard-deleting
 * the DB row afterwards.
 */
export async function sshUninstallAgent(
  serverId: string
): Promise<UninstallResult> {
  try {
    const rows = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: "server not found" };
    const server = rowToServer(row);

    await connectionPool.connect(server);

    // Detect sudo strategy. If the session user isn't root, prefer piping
    // the stored password (if any) into `sudo -S`; otherwise try `sudo -n`
    // and hope it's been configured for passwordless use.
    const whoRes = await executeCommand(serverId, "id -u", undefined, 5_000);
    const isRoot = whoRes.stdout.trim() === "0";

    let sudoPrefix = "";
    let sudoStdin: string | undefined;
    if (!isRoot) {
      if (server.passwordEncrypted) {
        const sudoPassword = decryptPassword(server.passwordEncrypted);
        sudoPrefix = "sudo -S -p '' ";
        sudoStdin = sudoPassword + "\n";
      } else {
        sudoPrefix = "sudo -n ";
      }
    }

    // Try known install locations in order. `command -v` lets us pick up a
    // PATH-resolved copy if someone installed it somewhere unusual.
    const candidates = [
      "/usr/local/bin/managet-agent",
      "/usr/bin/managet-agent",
      "$(command -v managet-agent 2>/dev/null)",
    ];

    const errors: string[] = [];
    for (const path of candidates) {
      // Skip if the file doesn't exist at that literal path.
      if (!path.startsWith("$")) {
        const testRes = await executeCommand(
          serverId,
          `test -x ${path}`,
          undefined,
          5_000
        );
        if (testRes.exitCode !== 0) continue;
      }

      const cmd = `${sudoPrefix}${path} uninstall`;
      const res = await executeCommand(
        serverId,
        cmd,
        undefined,
        60_000,
        sudoStdin
      );
      if (res.exitCode === 0) {
        return { ok: true };
      }
      // Record failure but keep trying other candidates before giving up.
      errors.push(
        `${path}: exit ${res.exitCode} ${(res.stderr || res.stdout).trim()}`
      );
    }

    if (errors.length === 0) {
      return {
        ok: false,
        error:
          "managet-agent binary not found on remote host (checked /usr/local/bin, /usr/bin, PATH)",
      };
    }
    return { ok: false, error: errors.join(" | ") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
