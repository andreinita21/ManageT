/**
 * POST /api/agent/lifecycle
 *
 * Called by the agent when its lifecycle state changes in a way the
 * dashboard needs to know about *before* the next heartbeat would
 * surface it. Today that's exactly one event: `manually_stopped` —
 * the operator typed `managet stop` on the host and the agent is
 * about to ask systemd / launchd to bring it down.
 *
 * Distinct from `unreachable`, which the status sweeper sets when the
 * heartbeat just goes quiet. The dashboard renders the two
 * differently and disables session attach/create only on
 * `manually_stopped`, because we know the agent will come back via
 * `managet start` and a fresh heartbeat will clear it.
 *
 * Auth: bearer token, same as /api/agent/heartbeat. Only the agent
 * holding the server's token can transition its own row, so a
 * browser session cannot fake a state change.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { authenticateAgent } from "@/lib/agent/auth";

const lifecycleSchema = z.object({
  /** New state. Restricted to states the agent is allowed to announce
   *  about itself. `unreachable` / `healthy` / install-related states
   *  are driven by the dashboard from observed signals, not pushed by
   *  the agent. */
  state: z.enum(["manually_stopped"]),
  /** Optional human-readable detail surfaced in the UI tooltip. */
  reason: z.string().max(200).optional(),
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

  const parsed = lifecycleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const now = Date.now();

  // Refuse the transition mid-uninstall — the row is on its way out
  // and switching it to manually_stopped would just confuse the UI
  // about which terminal state it's in. The agent shouldn't fire
  // lifecycle while it's also being uninstalled, but defend anyway.
  if (server.pendingUninstall === 1 || server.agentStatus === "uninstalling") {
    return NextResponse.json(
      { error: "Server is being uninstalled; lifecycle transition refused." },
      { status: 409 }
    );
  }

  await db
    .update(servers)
    .set({
      agentStatus: parsed.data.state,
      // Mirror onto the legacy connection-status column so older UI
      // surfaces that only read `status` don't keep showing a green
      // "connected" pill while the agent is down.
      status: "disconnected",
      // Record the explicit reason so the UI can show it as a
      // subtitle. Reuses the existing install_error column rather
      // than adding a new one — it's already shown for status detail
      // and cleared the moment a healthy heartbeat lands again.
      agentInstallError: parsed.data.reason ?? "Stopped via `managet stop`.",
      agentInstallStage: null,
      updatedAt: now,
    })
    .where(eq(servers.id, server.id));

  return NextResponse.json({ ok: true });
}
