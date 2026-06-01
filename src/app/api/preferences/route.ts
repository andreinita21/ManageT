/**
 * GET /api/preferences  — fetch the current user's appearance prefs.
 *                         Returns DEFAULT_PREFERENCES if no row exists
 *                         yet (lazy creation on first PUT).
 * PUT /api/preferences  — save the current user's prefs. The body
 *                         is validated against the AppearancePreferences
 *                         shape; unknown themeKeys (other than "custom")
 *                         fall back to the default to keep the UI safe.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { userPreferences } from "@/lib/db/schema";
import {
  DEFAULT_PREFERENCES,
  PRESETS_BY_KEY,
  type AppearancePreferences,
  type GroupViewServerLabel,
  type ThemeColors,
} from "@/lib/themes/presets";
import {
  resolveActiveName,
  sanitizeCustomThemes,
  type MosaicTheme,
} from "@/lib/mosaic-themes/presets";

function rowToPrefs(
  row: typeof userPreferences.$inferSelect
): AppearancePreferences {
  let custom: ThemeColors | null = null;
  if (row.customTheme) {
    try {
      custom = JSON.parse(row.customTheme) as ThemeColors;
    } catch {
      custom = null;
    }
  }
  const groupViewServerLabel: GroupViewServerLabel =
    row.groupViewServerLabel === "name" ? "name" : "host";
  let mosaicCustomThemes: MosaicTheme[] = [];
  if (row.mosaicCustomThemes) {
    try {
      mosaicCustomThemes = sanitizeCustomThemes(JSON.parse(row.mosaicCustomThemes));
    } catch {
      mosaicCustomThemes = [];
    }
  }
  return {
    themeKey: row.themeKey,
    terminalFontFamily: row.terminalFontFamily,
    terminalFontSize: row.terminalFontSize,
    customTheme: custom,
    groupViewServerLabel,
    mosaicThemeActive: resolveActiveName(row.mosaicThemeActive, mosaicCustomThemes),
    mosaicCustomThemes,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const rows = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ data: DEFAULT_PREFERENCES });
  }
  return NextResponse.json({ data: rowToPrefs(rows[0]) });
}

interface IncomingBody {
  themeKey?: unknown;
  terminalFontFamily?: unknown;
  terminalFontSize?: unknown;
  customTheme?: unknown;
  groupViewServerLabel?: unknown;
  mosaicThemeActive?: unknown;
  mosaicCustomThemes?: unknown;
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: IncomingBody;
  try {
    body = (await request.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate themeKey: must be either a known preset or "custom".
  const rawKey =
    typeof body.themeKey === "string" ? body.themeKey : DEFAULT_PREFERENCES.themeKey;
  const themeKey =
    rawKey === "custom" || PRESETS_BY_KEY[rawKey]
      ? rawKey
      : DEFAULT_PREFERENCES.themeKey;

  const terminalFontFamily =
    typeof body.terminalFontFamily === "string" && body.terminalFontFamily.length > 0
      ? body.terminalFontFamily.slice(0, 100)
      : DEFAULT_PREFERENCES.terminalFontFamily;

  const fontSizeNum =
    typeof body.terminalFontSize === "number"
      ? body.terminalFontSize
      : Number(body.terminalFontSize);
  const terminalFontSize =
    Number.isFinite(fontSizeNum) && fontSizeNum >= 8 && fontSizeNum <= 48
      ? Math.round(fontSizeNum)
      : DEFAULT_PREFERENCES.terminalFontSize;

  const groupViewServerLabel: GroupViewServerLabel =
    body.groupViewServerLabel === "name" ? "name" : "host";

  // Mosaic themes: sanitize the custom set, then resolve the active name
  // against built-ins ∪ that set (falls back to "default").
  const mosaicCustomThemes = sanitizeCustomThemes(body.mosaicCustomThemes);
  const mosaicCustomThemesJson =
    mosaicCustomThemes.length > 0 ? JSON.stringify(mosaicCustomThemes) : null;
  if (mosaicCustomThemesJson && mosaicCustomThemesJson.length > 32_000) {
    return NextResponse.json(
      { error: "mosaicCustomThemes too large" },
      { status: 400 }
    );
  }
  const mosaicThemeActive = resolveActiveName(
    body.mosaicThemeActive,
    mosaicCustomThemes
  );

  // Custom theme only stored when actually using "custom"; for preset
  // themeKeys we clear it to avoid stale colors hanging around.
  let customThemeJson: string | null = null;
  if (themeKey === "custom" && body.customTheme && typeof body.customTheme === "object") {
    try {
      customThemeJson = JSON.stringify(body.customTheme);
      // Soft cap so a runaway client can't fill the row with megabytes.
      if (customThemeJson.length > 16_000) {
        return NextResponse.json(
          { error: "customTheme too large" },
          { status: 400 }
        );
      }
    } catch {
      customThemeJson = null;
    }
  }

  const now = Date.now();
  // sqlite upsert via insert(...).onConflictDoUpdate(...) on the PK.
  await db
    .insert(userPreferences)
    .values({
      userId,
      themeKey,
      terminalFontFamily,
      terminalFontSize,
      customTheme: customThemeJson,
      groupViewServerLabel,
      mosaicThemeActive,
      mosaicCustomThemes: mosaicCustomThemesJson,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        themeKey,
        terminalFontFamily,
        terminalFontSize,
        customTheme: customThemeJson,
        groupViewServerLabel,
        mosaicThemeActive,
        mosaicCustomThemes: mosaicCustomThemesJson,
        updatedAt: now,
      },
    });

  const saved: AppearancePreferences = {
    themeKey,
    terminalFontFamily,
    terminalFontSize,
    customTheme:
      themeKey === "custom" && customThemeJson
        ? (JSON.parse(customThemeJson) as ThemeColors)
        : null,
    groupViewServerLabel,
    mosaicThemeActive,
    mosaicCustomThemes,
  };
  return NextResponse.json({ data: saved });
}
