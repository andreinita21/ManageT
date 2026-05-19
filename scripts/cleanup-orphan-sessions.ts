/**
 * Cleanup orphaned agent sessions.
 *
 * "Orphaned" = a session that exists in the agent's in-memory map but
 * has no corresponding row in the dashboard's `sessions` table. They
 * accumulate when a kill request makes it to the agent but the
 * dashboard's DB write follows a different path (e.g. dashboard crash
 * between agent ACK and DB delete), or when the dashboard's DB has
 * been wiped while the agent kept running.
 *
 *   npx tsx scripts/cleanup-orphan-sessions.ts          # dry run, just report
 *   npx tsx scripts/cleanup-orphan-sessions.ts --apply  # actually send Kill
 *
 * The script touches the agent over the same SSH-forwarded socket the
 * dashboard uses (see src/lib/ssh/agent-socket.ts) so it works for
 * every managed host, not just localhost. SQLite is opened in the
 * dashboard process's normal way; concurrent runs alongside a live
 * dashboard are safe (we only DELETE rows that have already been
 * marked as orphans, and SQLite handles concurrent writes).
 */
import { existsSync, readFileSync } from "node:fs";

// Manually source .env.local so MANAGET_ENCRYPTION_KEY is in process.env
// before any module that decrypts SSH credentials gets imported. Next.js
// loads it automatically at runtime; a one-off tsx script doesn't.
const envPath = ".env.local";
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

import { db } from "@/lib/db";
import { servers, sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

import {
  agentRequest,
  openAgentAttach,
  type AgentSessionInfo,
} from "@/lib/ssh/agent-socket";
import { rowToServer } from "@/lib/db/transform";

interface ServerOrphans {
  serverId: string;
  serverLabel: string;
  serverHost: string;
  agentSessions: AgentSessionInfo[];
  dbSessionIds: Set<string>;
  orphans: AgentSessionInfo[];
}

async function collectOrphansForServer(
  serverId: string,
  serverLabel: string,
  serverHost: string
): Promise<ServerOrphans | null> {
  let agentSessions: AgentSessionInfo[];
  try {
    const resp = await agentRequest(serverId, { op: "list" });
    if (resp.result !== "session_list") {
      console.error(
        `[${serverLabel}] unexpected list response: ${JSON.stringify(resp)}`
      );
      return null;
    }
    agentSessions = resp.sessions;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[${serverLabel}] cannot reach agent: ${m}`);
    return null;
  }

  const dbRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.serverId, serverId));
  const dbSessionIds = new Set(dbRows.map((r) => r.id));

  const orphans = agentSessions.filter((s) => !dbSessionIds.has(s.id));

  return {
    serverId,
    serverLabel,
    serverHost,
    agentSessions,
    dbSessionIds,
    orphans,
  };
}

/**
 * Send the equivalent of the user typing "exit" + Enter at the shell
 * prompt. This succeeds where `op: "kill"` quietly fails because:
 *
 *   1. The agent's Session::request_kill is one-shot — it `take()`s
 *      the kill_handle from a `Mutex<Option<ChildKiller>>`. A failed
 *      previous kill (e.g. from the dashboard during the bug that
 *      created these orphans) consumed the handle, so any subsequent
 *      `op: "kill"` is a silent no-op.
 *   2. portable-pty 0.8's UnixChildKiller sends SIGHUP, not SIGKILL.
 *      The agent spawns shells via `su -l andrei`; `su` doesn't always
 *      propagate SIGHUP to its bash child, so the wrapping `su`
 *      survives.
 *
 * Writing "exit\n" through the attach stream sidesteps both because
 * the shell processes it as a normal user command: bash exits cleanly,
 * `su`'s child dies, `su` exits, the agent's waiter task observes
 * exit, `running` flips false, and `cleanup_dead` reaps the row on the
 * next `list`.
 */
async function exitOrphans(report: ServerOrphans): Promise<{
  killed: AgentSessionInfo[];
  failed: { session: AgentSessionInfo; error: string }[];
}> {
  const killed: AgentSessionInfo[] = [];
  const failed: { session: AgentSessionInfo; error: string }[] = [];
  for (const s of report.orphans) {
    try {
      const handle = await openAgentAttach(report.serverId, s.id, 24, 80);
      // Belt-and-braces: drain the initial scrollback bytes so we don't
      // leave a half-read socket on disconnect.
      void handle.initialBytes;
      // Send Ctrl-C first (interrupts any half-typed command at the
      // prompt without executing it), then "exit\n". The leading
      // newline is so that if anything was at the prompt buffer it
      // gets discarded; the trailing newline is the actual Enter.
      handle.stream.write("\x03\nexit\n");
      // Give the shell a moment to process before we tear down the
      // attach. 300ms is comfortably more than the round-trip from
      // bash → su → portable-pty → agent's waiter, while still snappy.
      await new Promise((r) => setTimeout(r, 300));
      try {
        handle.stream.destroy();
      } catch {
        /* ignore */
      }
      killed.push(s);
    } catch (err) {
      // Fall back to the (probably no-op) Kill op rather than skipping
      // the orphan entirely — costs nothing.
      try {
        await agentRequest(report.serverId, { op: "kill", id: s.id });
        killed.push(s);
      } catch {
        failed.push({
          session: s,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { killed, failed };
}

function fmtAge(createdMs: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h${remMin}m` : `${hr}h`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    console.log("DRY RUN — pass --apply to actually send Kill\n");
  }

  const allServers = await db.select().from(servers);
  if (allServers.length === 0) {
    console.log("No servers in the dashboard DB.");
    return;
  }

  let totalOrphans = 0;
  let totalKilled = 0;
  let totalFailed = 0;

  for (const row of allServers) {
    const server = rowToServer(row);
    const label = `${server.name} (${server.host})`;
    console.log(`\n=== ${label} ===`);

    const report = await collectOrphansForServer(
      server.id,
      server.name,
      server.host
    );
    if (!report) {
      console.log(`  (skipped — agent unreachable)`);
      continue;
    }

    console.log(
      `  agent has ${report.agentSessions.length} session(s); DB has ${report.dbSessionIds.size}`
    );

    if (report.orphans.length === 0) {
      console.log(`  no orphans ✓`);
      continue;
    }

    console.log(`  orphans (${report.orphans.length}):`);
    for (const s of report.orphans) {
      const tag = s.running ? "running" : "exited";
      console.log(
        `    ${s.id.slice(0, 8)}  ${s.name.padEnd(24)}  age ${fmtAge(s.created_at_ms)}  ${tag}`
      );
    }
    totalOrphans += report.orphans.length;

    if (apply) {
      const { killed, failed } = await exitOrphans(report);
      totalKilled += killed.length;
      totalFailed += failed.length;
      console.log(
        `  → killed ${killed.length}, failed ${failed.length}`
      );
      for (const { session, error } of failed) {
        console.log(`    ! ${session.id.slice(0, 8)} (${session.name}): ${error}`);
      }
    }
  }

  console.log(
    `\nSummary: ${totalOrphans} orphan(s) across all servers` +
      (apply ? `, killed ${totalKilled}, failed ${totalFailed}` : "")
  );

  // better-sqlite3 keeps the file handle open; force a clean exit.
  process.exit(0);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
