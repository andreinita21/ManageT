/**
 * GET /api/palette — the current user's command palette (slots 1-9).
 * PUT /api/palette — replace the whole palette (add/edit/delete/reorder
 * all reduce to one replace; see src/lib/palette.ts).
 *
 * Browser counterpart of /api/cli/palette. Personal data, not workspace
 * data — any authenticated user manages their own list.
 */
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/guard";
import { listPalette, palettePutSchema, replacePalette } from "@/lib/palette";

export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ data: { commands: await listPalette(gate.id) } });
}

export async function PUT(request: Request) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = palettePutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const commands = await replacePalette(
    gate.id,
    parsed.data.commands.map((c) => ({
      slot: c.slot,
      label: c.label ?? null,
      command: c.command,
    }))
  );
  return NextResponse.json({ data: { commands } });
}
