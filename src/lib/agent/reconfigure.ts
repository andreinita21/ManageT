/**
 * Push a partial agent-config update to an installed agent over SSH.
 *
 * Two-step protocol:
 *   1. `managet-agent reconfigure --api-url <…> [--interval-secs <…>]`
 *      mutates the agent's on-disk config.toml in place. Validated by
 *      the agent; rejected configs leave the file untouched.
 *   2. `systemctl restart managet-agent` (or `launchctl kickstart` on
 *      macOS) so the running process picks up the new values.
 *
 * Returns `{ ok: true }` if both steps succeed end-to-end. Otherwise
 * returns `{ ok: false, error: "..." }` with stderr-derived detail.
 *
 * NOTE: this assumes the agent binary on the host already supports the
 * `reconfigure` subcommand (added in agent v0.2.1). Older agents will
 * reject the subcommand with clap's "unknown subcommand" error; the
 * caller surfaces that to the UI so users know to redeploy the agent.
 */
import { executeCommand } from "@/lib/ssh/exec";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { decryptPassword } from "@/lib/crypto";
import { eq } from "drizzle-orm";

export interface ReconfigurePatch {
  apiUrl?: string;
  intervalSecs?: number;
  /** One of the eight bar colours accepted by the agent. */
  barColor?: string;
  /** Comma-separated field list, e.g. `"session,user_host,detach"`. */
  barFields?: string;
}

export interface ReconfigureResult {
  ok: boolean;
  error?: string;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function pushAgentReconfigure(
  serverId: string,
  patch: ReconfigurePatch
): Promise<ReconfigureResult> {
  if (
    patch.apiUrl === undefined &&
    patch.intervalSecs === undefined &&
    patch.barColor === undefined &&
    patch.barFields === undefined
  ) {
    return { ok: true };
  }

  const rows = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (rows.length === 0) {
    return { ok: false, error: "server not found" };
  }
  const server = rows[0];

  // Same sudo handling as the installer: prefer passwordless sudo, fall
  // back to piping the stored password if we have one. Hosts where the
  // agent already runs as root skip sudo entirely.
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

  // Build the reconfigure invocation.
  const flags: string[] = [];
  if (patch.apiUrl !== undefined) flags.push(`--api-url ${shellEscape(patch.apiUrl)}`);
  if (patch.intervalSecs !== undefined) flags.push(`--interval-secs ${patch.intervalSecs}`);
  if (patch.barColor !== undefined) flags.push(`--bar-color ${shellEscape(patch.barColor)}`);
  if (patch.barFields !== undefined) flags.push(`--bar-fields ${shellEscape(patch.barFields)}`);
  const reconfigureCmd = `${sudoPrefix}managet-agent reconfigure ${flags.join(" ")}`;
  const reconfigureRes = await executeCommand(
    serverId,
    reconfigureCmd,
    undefined,
    30_000,
    sudoStdin
  );
  if (reconfigureRes.exitCode !== 0) {
    return {
      ok: false,
      error: `reconfigure failed (exit ${reconfigureRes.exitCode}): ${
        reconfigureRes.stderr || reconfigureRes.stdout
      }`,
    };
  }

  // Bar-only changes don't need a service restart — the bar reloads
  // its config on every attach. Restart only when we touched api_url
  // or interval_secs, which the long-running heartbeat loop only reads
  // at startup.
  const needsRestart = patch.apiUrl !== undefined || patch.intervalSecs !== undefined;
  if (!needsRestart) {
    return { ok: true };
  }

  // Restart the service so the heartbeat loop picks up the new
  // config. Try systemd first; fall back to launchctl on macOS. Both
  // commands are no-ops if the unit/plist isn't present, but at least
  // one will match in practice.
  const restartCmd =
    `${sudoPrefix}systemctl restart managet-agent 2>/dev/null || ` +
    `${sudoPrefix}launchctl kickstart -k system/com.managet.agent 2>/dev/null || ` +
    `(echo "could not find a managet-agent service to restart" >&2; exit 1)`;
  const restartRes = await executeCommand(
    serverId,
    restartCmd,
    undefined,
    30_000,
    sudoStdin
  );
  if (restartRes.exitCode !== 0) {
    return {
      ok: false,
      error: `restart failed (exit ${restartRes.exitCode}): ${
        restartRes.stderr || restartRes.stdout
      }`,
    };
  }

  return { ok: true };
}
