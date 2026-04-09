/**
 * API routes for restart policy rules.
 * GET /api/restart-policies — list all rules
 * POST /api/restart-policies — create a new rule
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { restartRules } from "@/lib/db/schema";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { RestartRule } from "@/types";

const createRuleSchema = z.object({
  scope: z.enum(["global", "server", "session"]),
  scopeId: z.string().optional(),
  pattern: z.string().min(1),
  patternType: z.enum(["glob", "regex", "exact"]),
  action: z.enum(["auto", "ask", "never"]),
  priority: z.number().int().optional().default(0),
});

function rowToRule(r: typeof restartRules.$inferSelect): RestartRule {
  return {
    ...r,
    scope: r.scope as RestartRule["scope"],
    scopeId: r.scopeId ?? undefined,
    patternType: r.patternType as RestartRule["patternType"],
    action: r.action as RestartRule["action"],
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db.select().from(restartRules);
  const data: RestartRule[] = rows.map(rowToRule);

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

  const parsed = createRuleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const input = parsed.data;
  const now = Date.now();
  const id = uuidv4();

  await db.insert(restartRules).values({
    id,
    scope: input.scope,
    scopeId: input.scopeId ?? null,
    pattern: input.pattern,
    patternType: input.patternType,
    action: input.action,
    priority: input.priority,
    createdBy: session.user.id,
    createdAt: now,
  });

  const rule: RestartRule = {
    id,
    scope: input.scope,
    scopeId: input.scopeId,
    pattern: input.pattern,
    patternType: input.patternType,
    action: input.action,
    priority: input.priority,
    createdBy: session.user.id,
    createdAt: now,
  };

  return NextResponse.json({ data: rule }, { status: 201 });
}
