"use client";

/**
 * ThemeProvider — owns the appearance preferences for a logged-in user
 * and applies them in two places:
 *
 *  - **UI**: writes the resolved ThemeColors.ui palette as CSS custom
 *    properties on documentElement (`--color-mg-bg`, `--color-mg-text`,
 *    etc.). These are the same names Tailwind's @theme inline block in
 *    globals.css uses, so setting them at runtime overrides the
 *    compile-time defaults without touching any component code.
 *
 *  - **Terminal**: exposes the resolved terminal palette + font choices
 *    via `useAppearance()` so `<TerminalPane>` instances can read them
 *    at mount time and configure xterm accordingly. Live preset
 *    switches re-render the consumers; xterm itself only picks them up
 *    on its next instance creation (or via term.options.theme), which
 *    `TerminalPaneInner` handles.
 *
 * Initial fetch is non-blocking — children render immediately with
 * DEFAULT_PREFERENCES so the first paint never blocks on /api/preferences.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_PREFERENCES,
  resolveColors,
  type AppearancePreferences,
  type ThemeColors,
  type UiPalette,
} from "./presets";

interface AppearanceContextValue {
  prefs: AppearancePreferences;
  colors: ThemeColors;
  /** Save the new preferences to the server and apply locally. Returns
   *  the persisted prefs (which may differ slightly from input if the
   *  server validated/clamped any field). */
  save: (next: AppearancePreferences) => Promise<AppearancePreferences>;
  /** Apply prefs locally without persisting — used by the Appearance
   *  settings page for live preview before the user hits Save. */
  preview: (next: AppearancePreferences) => void;
  /** True until the first /api/preferences fetch has returned. UI can
   *  use this to avoid flashing the default palette over a stored one. */
  loading: boolean;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

const UI_VAR_MAP: Record<keyof UiPalette, string> = {
  bg: "--color-mg-bg",
  bgSecondary: "--color-mg-bg-secondary",
  bgTertiary: "--color-mg-bg-tertiary",
  bgHover: "--color-mg-bg-hover",
  bgActive: "--color-mg-bg-active",
  accent: "--color-mg-accent",
  accentBright: "--color-mg-accent-bright",
  accentDim: "--color-mg-accent-dim",
  text: "--color-mg-text",
  textSecondary: "--color-mg-text-secondary",
  textTertiary: "--color-mg-text-tertiary",
  border: "--color-mg-border",
  borderHover: "--color-mg-border-hover",
};

function applyUiPalette(palette: UiPalette): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const k of Object.keys(UI_VAR_MAP) as (keyof UiPalette)[]) {
    root.style.setProperty(UI_VAR_MAP[k], palette[k]);
  }
  // Also update the hard-coded fallbacks on `html`/`body` from
  // globals.css so the first frame after a preset change repaints
  // instead of keeping the launch background.
  root.style.backgroundColor = palette.bg;
  root.style.color = palette.text;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<AppearancePreferences>(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState<boolean>(true);

  const colors = useMemo(() => resolveColors(prefs), [prefs]);

  // Push UI vars to the document whenever the resolved palette changes.
  useEffect(() => {
    applyUiPalette(colors.ui);
  }, [colors.ui]);

  // Initial fetch — best-effort. A 401 means the user isn't logged in
  // (login screen, etc.) and the defaults are fine.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<{ data: AppearancePreferences }>;
      })
      .then((body) => {
        if (cancelled) return;
        if (body?.data) setPrefs(body.data);
      })
      .catch(() => {
        /* swallow — we'll just keep DEFAULT_PREFERENCES */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = useCallback((next: AppearancePreferences) => {
    setPrefs(next);
  }, []);

  const save = useCallback(
    async (next: AppearancePreferences): Promise<AppearancePreferences> => {
      const resp = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(next),
      });
      if (!resp.ok) {
        let detail = `status ${resp.status}`;
        try {
          const j = (await resp.json()) as { error?: string };
          if (j?.error) detail = j.error;
        } catch {
          /* ignore */
        }
        throw new Error(`Failed to save preferences: ${detail}`);
      }
      const body = (await resp.json()) as { data: AppearancePreferences };
      setPrefs(body.data);
      return body.data;
    },
    []
  );

  const value: AppearanceContextValue = useMemo(
    () => ({ prefs, colors, save, preview, loading }),
    [prefs, colors, save, preview, loading]
  );

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) {
    throw new Error(
      "useAppearance must be called inside <ThemeProvider>"
    );
  }
  return ctx;
}

/**
 * Hook variant that's safe to call from components rendered above the
 * ThemeProvider (e.g. server-side, or in test contexts). Returns the
 * default palette + a no-op save when no provider is present. Useful
 * for one-off previews so callers don't have to manually guard.
 */
export function useAppearanceOptional(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (ctx) return ctx;
  return {
    prefs: DEFAULT_PREFERENCES,
    colors: resolveColors(DEFAULT_PREFERENCES),
    save: async (next) => next,
    preview: () => {},
    loading: false,
  };
}
