/**
 * Server-side appearance-preference loader.
 *
 * Used by the root layout to resolve the logged-in user's theme during
 * SSR so the first paint already carries their palette (no flash of the
 * default purple before the client ThemeProvider hydrates). Mirrors the
 * row→prefs mapping in /api/preferences so the two never drift.
 */
import "server-only";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { userPreferences } from "@/lib/db/schema";
import {
  DEFAULT_PREFERENCES,
  type AppearancePreferences,
  type GroupViewServerLabel,
  type ThemeColors,
} from "@/lib/themes/presets";

export async function loadAppearancePreferences(): Promise<AppearancePreferences> {
  let userId: string | undefined;
  try {
    const session = await auth();
    userId = session?.user?.id;
  } catch {
    // Unauthenticated (login screen) or auth misconfig — fall back to
    // defaults rather than blocking the render.
    return DEFAULT_PREFERENCES;
  }
  if (!userId) return DEFAULT_PREFERENCES;

  try {
    const rows = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    if (rows.length === 0) return DEFAULT_PREFERENCES;

    const row = rows[0];
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
    return {
      themeKey: row.themeKey,
      terminalFontFamily: row.terminalFontFamily,
      terminalFontSize: row.terminalFontSize,
      customTheme: custom,
      groupViewServerLabel,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}
