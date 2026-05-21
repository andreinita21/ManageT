/**
 * API routes for individual server operations.
 * GET /api/servers/[id] — get server details
 * PUT /api/servers/[id] — update server
 * DELETE /api/servers/[id] — delete server
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { rowToServer } from "@/lib/db/transform";
import { eq } from "drizzle-orm";
import { encryptPassword } from "@/lib/crypto";
import { sshUninstallAgent } from "@/lib/agent/uninstaller";
import { pushAgentReconfigure } from "@/lib/agent/reconfigure";
import { z } from "zod";

const updateServerSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1).optional(),
  authMethod: z.enum(["key", "password"]).optional(),
  privateKeyPath: z.string().optional(),
  password: z.string().optional(),
  labels: z.array(z.string()).optional(),
  groupName: z.string().nullable().optional(),
  status: z
    .enum(["connected", "disconnected", "reconnecting", "unreachable", "unknown"])
    .optional(),
  // Per-server agent settings. All optional so the same endpoint can
  // handle partial updates from the connection-edit form *and* the
  // agent-config form.
  heartbeatIntervalSecs: z.number().int().min(5).max(600).optional(),
  logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
  autoUpdate: z.boolean().optional(),
  sessionRetentionDays: z.number().int().min(0).max(3650).optional(),
  // null clears the cap, integer ≥1 sets one.
  maxSessions: z.number().int().min(1).max(1000).nullable().optional(),
  // Dashboard URL the agent should heartbeat to. When this changes,
  // the PUT handler SSH-pushes a `managet-agent reconfigure` to the
  // agent and only persists on success.
  apiUrl: z
    .string()
    .url()
    .refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
      message: "must start with http:// or https://",
    })
    .optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const rows = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  return NextResponse.json({ data: rowToServer(rows[0]) });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateServerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const existing = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const input = parsed.data;
  const updates: Record<string, unknown> = { updatedAt: Date.now() };

  if (input.name !== undefined) updates.name = input.name;
  if (input.host !== undefined) updates.host = input.host;
  if (input.port !== undefined) updates.port = input.port;
  if (input.username !== undefined) updates.username = input.username;
  if (input.authMethod !== undefined) updates.authMethod = input.authMethod;
  if (input.privateKeyPath !== undefined) updates.privateKeyPath = input.privateKeyPath;
  if (input.password !== undefined) {
    updates.passwordEncrypted = encryptPassword(input.password);
  }
  if (input.labels !== undefined) updates.labels = JSON.stringify(input.labels);
  if (input.groupName !== undefined) updates.groupName = input.groupName;
  if (input.status !== undefined) updates.status = input.status;
  if (input.heartbeatIntervalSecs !== undefined)
    updates.heartbeatIntervalSecs = input.heartbeatIntervalSecs;
  if (input.logLevel !== undefined) updates.logLevel = input.logLevel;
  if (input.autoUpdate !== undefined) updates.autoUpdate = input.autoUpdate ? 1 : 0;
  if (input.sessionRetentionDays !== undefined)
    updates.sessionRetentionDays = input.sessionRetentionDays;
  if (input.maxSessions !== undefined) updates.maxSessions = input.maxSessions;

  // Push live-applicable changes to the agent before we persist them.
  // `apiUrl` is the headline use-case (repoint LAN install at a Cloudflare
  // tunnel), but pushing `interval_secs` here as well means the heartbeat
  // cadence changes immediately rather than waiting for the next install.
  // If the push fails (agent offline, old binary without reconfigure
  // subcommand, etc.), refuse the whole update so the dashboard's row
  // doesn't drift away from what's actually running on the host.
  const row = existing[0];
  const urlChanging = input.apiUrl !== undefined && input.apiUrl !== row.apiUrl;
  const intervalChanging =
    input.heartbeatIntervalSecs !== undefined &&
    input.heartbeatIntervalSecs !== row.heartbeatIntervalSecs;
  if (urlChanging || intervalChanging) {
    const result = await pushAgentReconfigure(id, {
      apiUrl: urlChanging ? input.apiUrl : undefined,
      intervalSecs: intervalChanging ? input.heartbeatIntervalSecs : undefined,
    });
    if (!result.ok) {
      return NextResponse.json(
        {
          error: `Could not push config to the agent: ${
            result.error ?? "unknown error"
          }. The server row was not updated.`,
        },
        { status: 502 }
      );
    }
    if (urlChanging) updates.apiUrl = input.apiUrl;
  } else if (input.apiUrl !== undefined) {
    // URL field was sent but is unchanged — write it through to cover
    // the unlikely case where the DB column was NULL and the user just
    // re-typed the same value as a "lock it in" affordance.
    updates.apiUrl = input.apiUrl;
  }

  await db.update(servers).set(updates).where(eq(servers.id, id));

  const updated = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  return NextResponse.json({ data: rowToServer(updated[0]) });
}

/**
 * Heartbeats older than this are considered stale enough to skip the
 * soft-delete round-trip and go straight to SSH-uninstall fallback.
 */
const STALE_HEARTBEAT_MS = 60_000;

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "true";

  const existing = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
  const row = existing[0];

  // --- Path 1: force-delete. The admin wants the row gone regardless of
  // whether the remote agent is still alive. Do not attempt to contact the
  // remote host.
  if (force) {
    await db.delete(servers).where(eq(servers.id, id));
    return NextResponse.json({ data: { deleted: true, forced: true } });
  }

  // --- Path 2: nothing was ever installed, or the install blew up before
  // the agent ever started. Safe to hard-delete immediately — there is no
  // remote process to signal.
  const agentStatus = row.agentStatus;
  if (agentStatus === "not_installed" || agentStatus === "install_failed") {
    await db.delete(servers).where(eq(servers.id, id));
    return NextResponse.json({ data: { deleted: true } });
  }

  // --- Path 3: the agent is (or should be) alive. Normal soft-delete: set
  // pendingUninstall so the next heartbeat gets a "uninstall" directive, and
  // the server row is removed by POST /api/agent/uninstalled when the agent
  // confirms it cleaned up.
  const lastHb = row.agentLastHeartbeatAt ?? 0;
  const hbAge = Date.now() - lastHb;
  const hbFresh = lastHb > 0 && hbAge < STALE_HEARTBEAT_MS;

  if (hbFresh) {
    await db
      .update(servers)
      .set({
        pendingUninstall: 1,
        agentStatus: "uninstalling",
        agentInstallStage: "waiting for agent to self-uninstall",
        updatedAt: Date.now(),
      })
      .where(eq(servers.id, id));
    return NextResponse.json({ data: { pendingUninstall: true } });
  }

  // --- Path 4: the agent hasn't phoned home recently. Try to reach the
  // remote box over SSH and run `managet-agent uninstall` directly. If that
  // works, hard-delete the row. If SSH also fails, surface a 502 and let the
  // user retry with ?force=true.
  try {
    await db
      .update(servers)
      .set({
        agentStatus: "uninstalling",
        agentInstallStage: "agent unreachable — trying SSH fallback",
        updatedAt: Date.now(),
      })
      .where(eq(servers.id, id));

    const result = await sshUninstallAgent(id);
    if (!result.ok) {
      await db
        .update(servers)
        .set({
          agentStatus: "uninstall_failed",
          agentInstallError: result.error ?? "ssh uninstall failed",
          agentInstallStage: null,
          updatedAt: Date.now(),
        })
        .where(eq(servers.id, id));
      return NextResponse.json(
        {
          error:
            "Agent is unreachable and SSH fallback failed. Retry, or use ?force=true to skip the agent signal.",
          detail: result.error,
        },
        { status: 502 }
      );
    }

    await db.delete(servers).where(eq(servers.id, id));
    return NextResponse.json({ data: { deleted: true, via: "ssh-fallback" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(servers)
      .set({
        agentStatus: "uninstall_failed",
        agentInstallError: message,
        agentInstallStage: null,
        updatedAt: Date.now(),
      })
      .where(eq(servers.id, id));
    return NextResponse.json(
      {
        error:
          "Agent uninstall failed. Retry, or use ?force=true to skip the agent signal.",
        detail: message,
      },
      { status: 502 }
    );
  }
}
