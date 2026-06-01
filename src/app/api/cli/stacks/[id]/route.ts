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
import { z } from "zod";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import {
  deleteStack,
  getStack,
  getStackRuntime,
  getUserStackLayout,
  updateStack,
} from "@/lib/stacks";

const serviceInputSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1),
  cwd: z.string().optional(),
  command: z.string().optional(),
});

const updateStackSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  services: z.array(serviceInputSchema).min(1).optional(),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const stack = await getStack(id);
  if (!stack) {
    return NextResponse.json({ error: "Stack not found" }, { status: 404 });
  }

  const [runtime, serverRows, layout] = await Promise.all([
    getStackRuntime(id),
    db
      .select({
        id: servers.id,
        name: servers.name,
        host: servers.host,
        username: servers.username,
      })
      .from(servers),
    getUserStackLayout(userId, id),
  ]);

  return NextResponse.json({
    data: { stack, runtime, servers: serverRows, layout },
  });
}

/** PUT /api/cli/stacks/[id] — update name/description and/or replace
 *  services from the CLI editor (`managet stack edit`). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = updateStackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const { id } = await params;
  const refreshed = await updateStack(id, parsed.data);
  if (!refreshed) {
    return NextResponse.json({ error: "Stack not found" }, { status: 404 });
  }
  return NextResponse.json({ data: refreshed });
}

/** DELETE /api/cli/stacks/[id] — soft-delete (Trash), or hard-delete with
 *  ?force=true. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const force = new URL(request.url).searchParams.get("force") === "true";
  await deleteStack(id, force);
  return NextResponse.json({ ok: true, force });
}
