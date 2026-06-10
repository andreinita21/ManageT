/**
 * GET /api/cli/palette — the user's command palette for the CLI's
 * Ctrl-A P overlay.
 * PUT /api/cli/palette — replace the palette (same replace-all contract
 * as the browser route).
 *
 * Bearer-token twin of /api/palette: browser routes use NextAuth
 * cookies, /api/cli/* accepts only CLI tokens.
 */
import { NextResponse } from "next/server";

import { requireCliUserId } from "@/lib/cli-auth";
import { listPalette, palettePutSchema, replacePalette } from "@/lib/palette";

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ data: { commands: await listPalette(userId) } });
}

export async function PUT(request: Request) {
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
  const parsed = palettePutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const commands = await replacePalette(
    userId,
    parsed.data.commands.map((c) => ({
      slot: c.slot,
      label: c.label ?? null,
      command: c.command,
    }))
  );
  return NextResponse.json({ data: { commands } });
}
