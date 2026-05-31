/**
 * PUT /api/cli/themes/active  — set the active mosaic theme from the CLI
 * (`managet theme set <name>`). The CLI's counterpart to choosing a theme in
 * the web Settings tab; both write user_preferences.mosaic_theme_active.
 *
 * Body: { name: string } — must be a built-in preset or one of the caller's
 * custom themes, else 400.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { userPreferences } from "@/lib/db/schema";
import {
  MOSAIC_PRESETS_BY_NAME,
  sanitizeCustomThemes,
  type MosaicTheme,
} from "@/lib/mosaic-themes/presets";

export async function PUT(request: Request) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // Validate against built-ins ∪ this user's customs.
  const rows = await db
    .select({ mosaicCustomThemes: userPreferences.mosaicCustomThemes })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  let customs: MosaicTheme[] = [];
  if (rows[0]?.mosaicCustomThemes) {
    try {
      customs = sanitizeCustomThemes(JSON.parse(rows[0].mosaicCustomThemes));
    } catch {
      customs = [];
    }
  }
  const known = name in MOSAIC_PRESETS_BY_NAME || customs.some((c) => c.name === name);
  if (!known) {
    return NextResponse.json(
      { error: `unknown theme '${name}'` },
      { status: 400 }
    );
  }

  const now = Date.now();
  // Upsert only the active column; rely on column defaults for a brand-new
  // row so we never clobber the user's other preferences.
  await db
    .insert(userPreferences)
    .values({ userId, mosaicThemeActive: name, updatedAt: now })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { mosaicThemeActive: name, updatedAt: now },
    });

  return NextResponse.json({ data: { active: name } });
}
