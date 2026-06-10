/**
 * PUT /api/servers/:id/fan
 *
 * Set the desired fan mode for a server. The agent reads this on its
 * next heartbeat (via the response's `fanCommand`), applies it on the
 * host, and reports the outcome back in the following heartbeat's
 * `fanState`. Best-effort: SMC writes can fail (Apple Silicon
 * entitlement gating) and Linux PWM can be locked by firmware.
 *
 * Body:
 *   { mode: "auto" | "manual" | "max", rpm?: number }
 *
 * `rpm` is required when mode is "manual" and ignored otherwise. The
 * agent re-clamps against the hardware's own min/max before applying
 * so we don't need to know those values server-side.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { requireRole } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";

// Bounded reasonably for typed safety — the agent clamps further
// against hardware limits.
const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("max") }),
  z.object({
    mode: z.literal("manual"),
    rpm: z.number().int().min(0).max(20_000),
  }),
]);

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Fan control writes to host hardware (PWM/SMC) — admin only.
  const gate = await requireRole("admin");
  if (gate instanceof NextResponse) return gate;

  const { id } = await params;
  const rows = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const now = Date.now();
  const command = parsed.data;
  await db
    .update(servers)
    .set({
      fanMode: command.mode,
      // Only manual carries a target; clear it for auto/max so the UI
      // doesn't show a stale RPM next to a non-manual mode.
      fanTargetRpm: command.mode === "manual" ? command.rpm : null,
      // Flag the row so the next heartbeat handler embeds the command
      // in its response. Cleared atomically there.
      fanPending: 1,
      updatedAt: now,
    })
    .where(eq(servers.id, id));

  return NextResponse.json({
    data: {
      fanMode: command.mode,
      fanTargetRpm: command.mode === "manual" ? command.rpm : null,
      fanPending: true,
    },
  });
}
