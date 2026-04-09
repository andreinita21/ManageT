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
import { eq } from "drizzle-orm";
import { encryptPassword } from "@/lib/crypto";
import { z } from "zod";
import type { Server } from "@/types";

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
});

function rowToServer(r: typeof servers.$inferSelect): Server {
  return {
    ...r,
    labels: JSON.parse(r.labels) as string[],
    authMethod: r.authMethod as Server["authMethod"],
    status: r.status as Server["status"],
    lastConnectedAt: r.lastConnectedAt ?? undefined,
    privateKeyPath: r.privateKeyPath ?? undefined,
    passwordEncrypted: r.passwordEncrypted ?? undefined,
    groupName: r.groupName ?? undefined,
  };
}

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

  await db.update(servers).set(updates).where(eq(servers.id, id));

  const updated = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  return NextResponse.json({ data: rowToServer(updated[0]) });
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
  const existing = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  await db.delete(servers).where(eq(servers.id, id));
  return NextResponse.json({ data: { deleted: true } });
}
