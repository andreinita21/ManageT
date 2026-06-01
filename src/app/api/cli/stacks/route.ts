/**
 * GET /api/cli/stacks
 *
 * Token-authenticated stack list for the Rust CLI (`managet stacks`).
 * Mirrors /api/cli/groups: browser routes keep using NextAuth cookies,
 * this one accepts only CLI bearer tokens.
 *
 * Returns the live (non-trash) stacks with their ordered services, the
 * minimal server directory (so the CLI can render server labels), and the
 * bulk runtime view (active/inactive + sessionId per service) so the CLI
 * can show how many services are running without a second round-trip.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { createStack, getAllStackRuntimes, listStacks } from "@/lib/stacks";

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

export async function GET(request: Request) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [stacks, serverRows, runtimes] = await Promise.all([
    listStacks(),
    db
      .select({
        id: servers.id,
        name: servers.name,
        host: servers.host,
        username: servers.username,
      })
      .from(servers),
    getAllStackRuntimes(),
  ]);

  return NextResponse.json({
    data: { stacks, servers: serverRows, runtimes },
  });
}

/** POST /api/cli/stacks — create a stack from the CLI editor (`managet
 *  stack new`). Mirrors the browser POST, authed by CLI bearer token. */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
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
  const stack = await createStack(userId, parsed.data);
  return NextResponse.json({ data: stack }, { status: 201 });
}
