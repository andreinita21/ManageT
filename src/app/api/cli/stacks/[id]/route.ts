/**
 * GET /api/cli/stacks/[id]
 *
 * Token-authenticated stack detail for the Rust CLI's multipane view
 * (`managet stack open`). Returns the stack with its ordered services, the
 * live runtime (service -> sessionId mapping + active/inactive status), and
 * the minimal server directory for rendering pane labels.
 *
 * This is the workhorse the CLI's 3s runtime poll hits: `runtime.services[]`
 * carries the sessionId (string|null) that drives placeholder-vs-live panes.
 */
import { NextResponse } from "next/server";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { getStack, getStackRuntime } from "@/lib/stacks";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const stack = await getStack(id);
  if (!stack) {
    return NextResponse.json({ error: "Stack not found" }, { status: 404 });
  }

  const [runtime, serverRows] = await Promise.all([
    getStackRuntime(id),
    db
      .select({
        id: servers.id,
        name: servers.name,
        host: servers.host,
        username: servers.username,
      })
      .from(servers),
  ]);

  return NextResponse.json({
    data: { stack, runtime, servers: serverRows },
  });
}
