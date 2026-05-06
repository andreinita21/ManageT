/**
 * GET  /api/stacks         — list stacks (with their services).
 * POST /api/stacks         — create a stack with one or more services.
 *
 * Stacks group related commands across servers so a single click can
 * launch a "dev environment" (e.g. backend on box A, web on box B,
 * worker on box C). Each service in a stack becomes a separate agent
 * session at launch time, with `sessions.stackId` pointing back here.
 */
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { stacks, stackServices } from "@/lib/db/schema";
import type { Stack, StackService } from "@/types";

const serviceInputSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1),
  cwd: z.string().optional(),
  command: z.string().optional(),
});

const createStackSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  services: z.array(serviceInputSchema).min(1),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stackRows = await db.select().from(stacks);
  const serviceRows = await db.select().from(stackServices);
  const byStack = new Map<string, StackService[]>();
  for (const row of serviceRows) {
    const list = byStack.get(row.stackId) ?? [];
    list.push({
      id: row.id,
      stackId: row.stackId,
      name: row.name,
      serverId: row.serverId,
      cwd: row.cwd ?? undefined,
      command: row.command ?? undefined,
      orderIndex: row.orderIndex,
    });
    byStack.set(row.stackId, list);
  }
  const data: Stack[] = stackRows.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? undefined,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    services: (byStack.get(s.id) ?? []).sort(
      (a, b) => a.orderIndex - b.orderIndex
    ),
  }));
  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createStackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }
  const input = parsed.data;
  const now = Date.now();
  const stackId = uuidv4();

  await db.insert(stacks).values({
    id: stackId,
    name: input.name,
    description: input.description ?? null,
    createdBy: session.user.id,
    createdAt: now,
    updatedAt: now,
  });

  const services: StackService[] = [];
  for (let i = 0; i < input.services.length; i += 1) {
    const svc = input.services[i];
    const id = uuidv4();
    await db.insert(stackServices).values({
      id,
      stackId,
      name: svc.name,
      serverId: svc.serverId,
      cwd: svc.cwd ?? null,
      command: svc.command ?? null,
      orderIndex: i,
    });
    services.push({
      id,
      stackId,
      name: svc.name,
      serverId: svc.serverId,
      cwd: svc.cwd,
      command: svc.command,
      orderIndex: i,
    });
  }

  const stack: Stack = {
    id: stackId,
    name: input.name,
    description: input.description,
    createdBy: session.user.id,
    createdAt: now,
    updatedAt: now,
    services,
  };
  return NextResponse.json({ data: stack }, { status: 201 });
}

