/**
 * GET    /api/stacks/[id] — fetch one stack with services.
 * PUT    /api/stacks/[id] — update name/description and/or replace services.
 * DELETE /api/stacks/[id] — drop the stack (associated `sessions` rows
 *                           keep their `stackId` set to NULL via the
 *                           ON DELETE SET NULL FK).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { stacks } from "@/lib/db/schema";
import { getStack, replaceServicesForStack } from "@/lib/stacks";

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
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const stack = await getStack(id);
  if (!stack) {
    return NextResponse.json({ error: "Stack not found" }, { status: 404 });
  }
  return NextResponse.json({ data: stack });
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
  const parsed = updateStackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }
  const existing = await db
    .select()
    .from(stacks)
    .where(eq(stacks.id, id))
    .limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Stack not found" }, { status: 404 });
  }

  const now = Date.now();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined)
    updates.description = parsed.data.description;
  await db.update(stacks).set(updates).where(eq(stacks.id, id));

  if (parsed.data.services) {
    await replaceServicesForStack(id, parsed.data.services);
  }

  const refreshed = await getStack(id);
  return NextResponse.json({ data: refreshed });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  await db.delete(stacks).where(eq(stacks.id, id));
  return NextResponse.json({ ok: true });
}
