/**
 * API route for executing commands on a server.
 * POST /api/servers/[id]/exec — execute a command (placeholder)
 */
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { executeCommand } from "@/lib/ssh/exec";

const execCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeout: z.number().int().positive().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Running an arbitrary command on a managed host is the most privileged
  // operation in the app — restrict it to admins.
  const gate = await requireRole("admin");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;

  const serverRows = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  if (serverRows.length === 0) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = execCommandSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  try {
    const result = await executeCommand(id, parsed.data);
    return NextResponse.json({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Command execution failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
