/**
 * POST /api/agent/heartbeat
 *
 * Called by the Rust agent every ~10s. The request carries a metric snapshot
 * and a bearer token. We:
 *   1. Authenticate the token against `servers.agent_token_hash`.
 *   2. Insert the snapshot into `metric_snapshots`.
 *   3. Bump `servers.agent_last_heartbeat_at` and flip agent_status to
 *      "healthy"/status to "connected" if they weren't already.
 *   4. Return a directive — `uninstall` if `pending_uninstall` is set,
 *      otherwise `continue`.
 */
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { metricSnapshots, servers, sessions } from "@/lib/db/schema";
import { authenticateAgent } from "@/lib/agent/auth";
import { snapshotEvents } from "@/lib/monitor/snapshot-events";
import type { MetricSnapshot } from "@/types";

// Matches the JSON the Rust agent emits (src/collector.rs).
const sessionStatsSchema = z.object({
  sessionId: z.string().min(1),
  cpuPercent: z.number().nonnegative(),
  memoryMb: z.number().int().nonnegative(),
  pidCount: z.number().int().nonnegative().optional(),
});

// Hardware sensor reading from the agent's hwmon module — `name` is
// driver-supplied ("fan1", "cpu_fan", "Fan 0"...), `rpm` is the raw value
// `fan*_input` exposes. Both bounded to keep a misbehaving agent from
// blowing up the row.
const fanReadingSchema = z.object({
  name: z.string().min(1).max(64),
  rpm: z.number().int().min(0).max(100_000),
});

const heartbeatSchema = z.object({
  cpuPercent: z.number().nullable().optional(),
  memoryUsedMb: z.number().int().nonnegative().nullable().optional(),
  memoryTotalMb: z.number().int().nonnegative().nullable().optional(),
  diskUsedPercent: z.number().nullable().optional(),
  load1m: z.number().nullable().optional(),
  load5m: z.number().nullable().optional(),
  load15m: z.number().nullable().optional(),
  uptimeSecs: z.number().int().nonnegative().optional(),
  agentVersion: z.string().optional(),
  hostname: z.string().optional(),
  // Thermal + fan telemetry — agents on v0.4.0+. Older agents omit
  // these and the columns stay NULL, which the dashboard renders as
  // "no sensor data".
  cpuTempC: z.number().nullable().optional(),
  gpuTempC: z.number().nullable().optional(),
  fans: z.array(fanReadingSchema).max(16).optional(),
  // Reported by agents v0.5.0+: outcome of the most recent fan command
  // the agent applied. We log it for diagnostics but don't currently
  // persist it — the UI reads servers.fan_mode / fan_target_rpm for
  // intent and the live `fans[]` array for actual RPM.
  fanState: z
    .object({
      applied: z.enum(["auto", "manual", "max"]),
      appliedRpm: z.number().int().nullable().optional(),
      error: z.string().nullable().optional(),
    })
    .optional(),
  // Per-session resource stats — agents on v0.2.0+. Older agents omit it.
  sessions: z.array(sessionStatsSchema).optional(),
});

export async function POST(request: Request) {
  const server = await authenticateAgent(request);
  if (!server) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = heartbeatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const snap = parsed.data;
  const now = Date.now();
  const snapshotId = uuidv4();

  // Derive fan_max_rpm at insert time so the bucket-aggregation query
  // can use a normal SQL AVG/MAX and never has to parse the JSON blob.
  const fans = snap.fans ?? [];
  const fanMaxRpm =
    fans.length > 0 ? fans.reduce((m, f) => (f.rpm > m ? f.rpm : m), 0) : null;
  const fansJson = fans.length > 0 ? JSON.stringify(fans) : null;

  // Persist the snapshot — reuses the existing metric_snapshots table.
  await db.insert(metricSnapshots).values({
    id: snapshotId,
    serverId: server.id,
    cpuPercent: snap.cpuPercent ?? null,
    memoryUsedMb: snap.memoryUsedMb ?? null,
    memoryTotalMb: snap.memoryTotalMb ?? null,
    diskUsedPercent: snap.diskUsedPercent ?? null,
    load1m: snap.load1m ?? null,
    load5m: snap.load5m ?? null,
    load15m: snap.load15m ?? null,
    activeConnections: null,
    cpuTempC: snap.cpuTempC ?? null,
    gpuTempC: snap.gpuTempC ?? null,
    fansJson,
    fanMaxRpm,
    capturedAt: now,
  });

  // Republish on the in-process snapshot bus so AlertEngine (and any future
  // WebSocket broadcaster) can react without having to poll the DB.
  const publishedSnapshot: MetricSnapshot = {
    id: snapshotId,
    serverId: server.id,
    cpuPercent: snap.cpuPercent ?? undefined,
    memoryUsedMb: snap.memoryUsedMb ?? undefined,
    memoryTotalMb: snap.memoryTotalMb ?? undefined,
    diskUsedPercent: snap.diskUsedPercent ?? undefined,
    load1m: snap.load1m ?? undefined,
    load5m: snap.load5m ?? undefined,
    load15m: snap.load15m ?? undefined,
    activeConnections: undefined,
    cpuTempC: snap.cpuTempC ?? undefined,
    gpuTempC: snap.gpuTempC ?? undefined,
    fans: fans.length > 0 ? fans : undefined,
    capturedAt: now,
  };
  snapshotEvents.emit("metrics:collected", publishedSnapshot);

  // Update the server row. If the server is already marked pending
  // uninstall, we still accept one more heartbeat so we can return the
  // directive — but we do NOT flip agent_status to "healthy" in that case.
  //
  // A heartbeat from a server currently in `manually_stopped` state is
  // also legitimate: the operator ran `managet start` and the agent
  // came back. We treat it the same as any other healthy heartbeat
  // below (the install_error subtitle from the stop signal is cleared
  // alongside the regular install_error reset).
  const wasPendingUninstall = server.pendingUninstall === 1;
  if (!wasPendingUninstall) {
    // Healthy heartbeat — also wipe any leftover install_error /
    // install_stage from a prior failed attempt. Without this, the detail
    // view keeps surfacing a stale red banner forever (e.g. an old
    // launchctl bootstrap error from a previous install) even though the
    // agent is currently fine.
    await db
      .update(servers)
      .set({
        agentStatus: "healthy",
        status: "connected",
        agentLastHeartbeatAt: now,
        agentVersion: snap.agentVersion ?? server.agentVersion ?? null,
        agentInstallError: null,
        agentInstallStage: null,
        lastConnectedAt: now,
        updatedAt: now,
      })
      .where(eq(servers.id, server.id));
  } else {
    // Touch heartbeat timestamp so we know the agent heard us, but keep
    // status "uninstalling".
    await db
      .update(servers)
      .set({ agentLastHeartbeatAt: now, updatedAt: now })
      .where(eq(servers.id, server.id));
  }

  // Upsert per-session stats. We only update existing rows — the agent
  // only knows about its own running PIDs, and dashboard-side rows for
  // closed sessions should not be revived. Each row update is bounded
  // by the number of *live* sessions on this server, which is small.
  if (snap.sessions && snap.sessions.length > 0) {
    for (const s of snap.sessions) {
      await db
        .update(sessions)
        .set({
          cpuPercent: s.cpuPercent,
          memoryMb: s.memoryMb,
          statsUpdatedAt: now,
        })
        .where(eq(sessions.id, s.sessionId));
    }
  }

  // Pending fan command? Embed it in the response and atomically clear
  // the flag. We do this after the metric insert so a single round-trip
  // delivers both directions (snapshot in, command out). The agent
  // applies on receipt and reports back via fanState in the next
  // heartbeat. The server row was loaded once via authenticateAgent —
  // re-read here so we see the latest pending state (in case the
  // dashboard set it between the auth check and now).
  const [latest] = await db
    .select({
      fanPending: servers.fanPending,
      fanMode: servers.fanMode,
      fanTargetRpm: servers.fanTargetRpm,
    })
    .from(servers)
    .where(eq(servers.id, server.id))
    .limit(1);

  let fanCommand: { mode: "auto" | "manual" | "max"; rpm?: number } | undefined;
  if (latest?.fanPending === 1) {
    if (latest.fanMode === "manual" && latest.fanTargetRpm != null) {
      fanCommand = { mode: "manual", rpm: latest.fanTargetRpm };
    } else if (latest.fanMode === "max") {
      fanCommand = { mode: "max" };
    } else {
      fanCommand = { mode: "auto" };
    }
    await db
      .update(servers)
      .set({ fanPending: 0, updatedAt: now })
      .where(eq(servers.id, server.id));
  }

  // Reflect the agent's apply outcome in the DB so the UI can show the
  // real state (e.g. Apple Silicon M4 can't service `FS! ` writes, so
  // a "manual 3000" request lands as `applied: auto` with an error).
  // We treat "applied auto with error" as a revert: the user's
  // requested mode failed, the OS still controls fans, and we surface
  // the message so they understand why the slider didn't take effect.
  if (snap.fanState) {
    if (snap.fanState.error) {
      console.warn(
        `[fan-control] server ${server.id} reported error: ${snap.fanState.error}`
      );
      await db
        .update(servers)
        .set({
          fanMode: "auto",
          fanTargetRpm: null,
          fanError: snap.fanState.error,
          updatedAt: now,
        })
        .where(eq(servers.id, server.id));
    } else {
      // Successful apply — clear any stale error from a prior attempt.
      await db
        .update(servers)
        .set({ fanError: null, updatedAt: now })
        .where(eq(servers.id, server.id));
    }
  }

  return NextResponse.json({
    directive: wasPendingUninstall ? "uninstall" : "continue",
    ...(fanCommand ? { fanCommand } : {}),
  });
}
