/**
 * POST /api/servers/:id/agent/install-retry
 *
 * Re-runs the SSH-push agent installer for a server that previously failed
 * to install (or that the admin just wants to reinstall). Returns 202 so
 * the caller can poll the server row for progress.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { retryInstall } from "@/lib/agent/installer";

export async function POST(
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

  // Fire the retry in the background. The client should poll GET
  // /api/servers/:id and watch `agentStatus` / `agentInstallStage`.
  void retryInstall(id).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] background retry crashed for ${id}:`, message);
  });

  return NextResponse.json({ data: { retrying: true } }, { status: 202 });
}
