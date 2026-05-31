/**
 * GET /api/cli/themes
 *
 * Token-authenticated mosaic-theme catalog for the Rust CLI. Returns every
 * built-in preset plus the user's custom themes, each with its 6 border
 * glyphs ALREADY RESOLVED server-side, and the active theme name. The CLI
 * (`managet theme list`, `group/stack open`) renders straight from this — it
 * needs no knowledge of line-style keys, so new line types are a server-only
 * change.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { userPreferences } from "@/lib/db/schema";
import {
  buildThemeCatalog,
  resolveActiveName,
  sanitizeCustomThemes,
  type MosaicTheme,
} from "@/lib/mosaic-themes/presets";

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({
      mosaicThemeActive: userPreferences.mosaicThemeActive,
      mosaicCustomThemes: userPreferences.mosaicCustomThemes,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  let customs: MosaicTheme[] = [];
  let activeRaw: string | null = null;
  if (rows.length > 0) {
    activeRaw = rows[0].mosaicThemeActive;
    if (rows[0].mosaicCustomThemes) {
      try {
        customs = sanitizeCustomThemes(JSON.parse(rows[0].mosaicCustomThemes));
      } catch {
        customs = [];
      }
    }
  }

  return NextResponse.json({
    data: {
      active: resolveActiveName(activeRaw, customs),
      themes: buildThemeCatalog(customs),
    },
  });
}
