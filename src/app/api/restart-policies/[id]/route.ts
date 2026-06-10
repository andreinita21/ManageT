/**
 * API routes for individual restart policy rule operations.
 * PUT /api/restart-policies/[id] — update a rule
 * DELETE /api/restart-policies/[id] — delete a rule
 */
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { restartRules } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { RestartRule } from "@/types";

const updateRuleSchema = z.object({
  scope: z.enum(["global", "server", "session"]).optional(),
  scopeId: z.string().nullable().optional(),
  // Bounded to limit ReDoS exposure for regex patterns (see POST route).
  pattern: z.string().min(1).max(500).optional(),
  patternType: z.enum(["glob", "regex", "exact"]).optional(),
  action: z.enum(["auto", "ask", "never"]).optional(),
  priority: z.number().int().optional(),
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

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateRuleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const existing = await db
    .select()
    .from(restartRules)
    .where(eq(restartRules.id, id))
    .limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  }

  const input = parsed.data;
  const updates: Record<string, unknown> = {};

  if (input.scope !== undefined) updates.scope = input.scope;
  if (input.scopeId !== undefined) updates.scopeId = input.scopeId;
  if (input.pattern !== undefined) updates.pattern = input.pattern;
  if (input.patternType !== undefined) updates.patternType = input.patternType;
  if (input.action !== undefined) updates.action = input.action;
  if (input.priority !== undefined) updates.priority = input.priority;

  if (Object.keys(updates).length > 0) {
    await db.update(restartRules).set(updates).where(eq(restartRules.id, id));
  }

  const updated = await db
    .select()
    .from(restartRules)
    .where(eq(restartRules.id, id))
    .limit(1);
  return NextResponse.json({ data: rowToRule(updated[0]) });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const existing = await db
    .select()
    .from(restartRules)
    .where(eq(restartRules.id, id))
    .limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  }

  await db.delete(restartRules).where(eq(restartRules.id, id));
  return NextResponse.json({ data: { deleted: true } });
}
