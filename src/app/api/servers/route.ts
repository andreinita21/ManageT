/**
 * API routes for server listing and creation.
 * GET /api/servers — list all servers
 * POST /api/servers — create a new server
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { toPublicServer } from "@/lib/db/transform";
import { encryptPassword } from "@/lib/crypto";
import { installAgent } from "@/lib/agent/installer";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { Server } from "@/types";

const createServerSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional().default(22),
  username: z.string().min(1),
  authMethod: z.enum(["key", "password"]),
  privateKeyPath: z.string().optional(),
  password: z.string().optional(),
  labels: z.array(z.string()).optional().default([]),
  groupName: z.string().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db.select().from(servers);
  const data: Server[] = rows.map(toPublicServer);

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

  const parsed = createServerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const input = parsed.data;
  const now = Date.now();
  const id = uuidv4();

  let passwordEncrypted: string | null = null;
  if (input.authMethod === "password" && input.password) {
    passwordEncrypted = encryptPassword(input.password);
  }

  await db.insert(servers).values({
    id,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    authMethod: input.authMethod,
    privateKeyPath: input.privateKeyPath ?? null,
    passwordEncrypted,
    labels: JSON.stringify(input.labels),
    groupName: input.groupName ?? null,
    status: "unknown",
    lastConnectedAt: null,
    createdBy: session.user.id,
    createdAt: now,
    updatedAt: now,
  });

  // Read the freshly-inserted row so we return the exact shape the client
  // will see on subsequent GETs — including the default agent_status.
  const inserted = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  const server: Server = toPublicServer(inserted[0]);

  // Fire the SSH-push agent install in the background. The client should poll
  // GET /api/servers/:id and watch `agentStatus` / `agentInstallStage` to render
  // a live progress panel. We intentionally don't await this — the installer
  // updates the row itself as it progresses.
  void installAgent(id).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] background install crashed for ${id}:`, message);
  });

  return NextResponse.json({ data: server }, { status: 201 });
}
