/**
 * API route for testing restart policy classification.
 * POST /api/restart-policies/test — test a command against rules (placeholder)
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { restartRules } from "@/lib/db/schema";
import { z } from "zod";
import { classifyCommand } from "@/lib/restart/classify";
import type { RestartRule, TestRestartRuleResponse } from "@/types";

const testRuleSchema = z.object({
  command: z.string().min(1),
  serverId: z.string().optional(),
  sessionId: z.string().optional(),
});

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

  const parsed = testRuleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const input = parsed.data;
  const result = classifyCommand(input.command);

  // Fetch all matching rules for reference
  const allRules = await db.select().from(restartRules);
  const matchedRules: RestartRule[] = allRules.map((r) => ({
    ...r,
    scope: r.scope as RestartRule["scope"],
    scopeId: r.scopeId ?? undefined,
    patternType: r.patternType as RestartRule["patternType"],
    action: r.action as RestartRule["action"],
  }));

  const response: TestRestartRuleResponse = {
    result,
    matchedRules,
  };

  return NextResponse.json({ data: response });
}
