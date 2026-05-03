/**
 * POST /api/agent/uninstalled
 *
 * Final call from an agent that has just removed itself after receiving an
 * `uninstall` directive. We hard-delete the server row at this point —
 * cascades take care of sessions, metric_snapshots, alerts, etc.
 *
 * This is strictly a confirmation: the server row must already have
 * `pending_uninstall = 1`, otherwise we refuse (defence in depth — an
 * exposed token should not be able to delete a server outside of an
 * explicit user-initiated removal flow).
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { authenticateAgent } from "@/lib/agent/auth";

export async function POST(request: Request) {
  const server = await authenticateAgent(request);
  if (!server) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (server.pendingUninstall !== 1) {
    return NextResponse.json(
      { error: "Server is not pending uninstall" },
      { status: 409 }
    );
  }

  await db.delete(servers).where(eq(servers.id, server.id));
  return NextResponse.json({ ok: true });
}
