/**
 * Small SFTP helper: write an in-memory buffer to a path on a managed
 * host, over the same pooled SSH connection everything else uses.
 *
 * First consumer is the image-paste flow (`POST /api/sessions/[id]/image`):
 * the dashboard drops a screenshot into the host's /tmp so the user can
 * paste its path into a terminal (Claude Code turns a pasted image path
 * into an attachment). Kept generic — any "push these bytes to that
 * server" need can reuse it.
 */
import { eq } from "drizzle-orm";
import type { SFTPWrapper, Client as SshClient } from "ssh2";

import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { rowToServer } from "@/lib/db/transform";
import { connectionPool } from "./connection-pool";

/** Pool-or-connect lookup. Deliberately a local copy of the same logic
 *  in agent-socket.ts (which keeps it private) so this module doesn't
 *  create churn in that file. */
async function getSshClient(serverId: string): Promise<SshClient> {
  const existing = connectionPool.getConnection(serverId);
  if (existing) return existing;
  const rows = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`sftp-write: server ${serverId} not in database`);
  }
  return connectionPool.connect(rowToServer(rows[0]));
}

/**
 * Write `data` to `remotePath` on the server, creating/truncating the
 * file. `mode` defaults to world-readable because the dashboard's SSH
 * user and the session's PTY user aren't necessarily the same account —
 * a 0600 screenshot in /tmp would be unreadable by the process that
 * actually needs it.
 */
export async function writeRemoteFile(
  serverId: string,
  remotePath: string,
  data: Buffer,
  mode = 0o644
): Promise<void> {
  const client = await getSshClient(serverId);
  await new Promise<void>((resolve, reject) => {
    client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
      if (err) {
        reject(new Error(`sftp channel: ${err.message}`));
        return;
      }
      const stream = sftp.createWriteStream(remotePath, { mode });
      stream.on("error", (e: Error) =>
        reject(new Error(`sftp write ${remotePath}: ${e.message}`))
      );
      stream.on("close", () => resolve());
      stream.end(data);
    });
  });
}
