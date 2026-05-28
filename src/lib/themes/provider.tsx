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
  UI_CSS_VAR_MAP,
  type AppearancePreferences,
  type ThemeColors,
  type UiPalette,
} from "./presets";

interface AppearanceContextValue {
  /** The currently *persisted* preferences. Only changes on the
   *  initial /api/preferences fetch and on a successful save(). The
   *  Appearance settings page reads this to decide whether the user
   *  has unsaved changes. */
  prefs: AppearancePreferences;
  /** What's currently applied to the document (terminal palette,
   *  fonts, CSS vars). Equals `prefs` unless a `preview()` override is
   *  in effect. Consumers like TerminalPaneInner read this, not
   *  `prefs`, so they reflect the user's in-progress selection. */
  active: AppearancePreferences;
  /** Resolved colours from `active`. */
  colors: ThemeColors;
  /** Save to the server and apply. Clears any preview override. */
  save: (next: AppearancePreferences) => Promise<AppearancePreferences>;
  /** Apply locally without persisting — used by the Appearance
   *  settings page for live preview before Save. Keeps `prefs`
   *  untouched, so consumers tracking "has the persisted theme
   *  changed?" don't loop. */
  preview: (next: AppearancePreferences) => void;
  /** Drop any preview override; `active` reverts to `prefs`. Call on
   *  Cancel or when the editor unmounts so a half-finished preview
   *  doesn't keep showing after the user navigates away. */
  resetPreview: () => void;
  /** True until the first /api/preferences fetch has returned. UI can
   *  use this to avoid flashing the default palette over a stored one. */
  loading: boolean;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function applyUiPalette(palette: UiPalette): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const k of Object.keys(UI_CSS_VAR_MAP) as (keyof UiPalette)[]) {
    root.style.setProperty(UI_CSS_VAR_MAP[k], palette[k]);
  }
  // Also update the hard-coded fallbacks on `html`/`body` from
  // globals.css so the first frame after a preset change repaints
  // instead of keeping the launch background.
  root.style.backgroundColor = palette.bg;
  root.style.color = palette.text;
}

export function ThemeProvider({
  children,
  initialPrefs,
}: {
  children: ReactNode;
  /** Preferences resolved server-side and seeded into the first render
   *  so the client never paints the default purple palette before the
   *  user's theme loads. When present we skip the loading state and the
   *  mount effect applies *these* vars (matching the SSR-injected
   *  <style>) instead of the defaults. */
  initialPrefs?: AppearancePreferences;
}) {
  // Persisted prefs (server source of truth) and an optional preview
  // override applied locally while the user is mid-edit. Keeping them
  // separate is what prevents the AppearanceTab's "live preview" from
  // looking like an external prefs update and triggering its own
  // sync-effect — that's the loop that produced the
  // "Maximum update depth exceeded" error.
  const [prefs, setPrefs] = useState<AppearancePreferences>(
    initialPrefs ?? DEFAULT_PREFERENCES
  );
  const [previewOverride, setPreviewOverride] = useState<AppearancePreferences | null>(null);
  // When the layout already handed us the user's prefs there's nothing
  // to wait for — start un-loading so consumers don't flash a spinner.
  const [loading, setLoading] = useState<boolean>(!initialPrefs);

  const active = previewOverride ?? prefs;
  const colors = useMemo(() => resolveColors(active), [active]);

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
        if (body?.data) {
          setPrefs(body.data);
          // Any stale preview belongs to a previous session; reset so
          // the fresh persisted theme takes over.
          setPreviewOverride(null);
        }
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
    // Skip the state update when the value is unchanged. Both protects
    // against React schedulers re-running effects with the same input
    // and avoids unnecessary re-renders across every consumer.
    setPreviewOverride((curr) => {
      if (curr && shallowSamePrefs(curr, next)) return curr;
      return next;
    });
  }, []);

  const resetPreview = useCallback(() => {
    setPreviewOverride(null);
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
      // Save wins; any in-flight preview is now stale.
      setPreviewOverride(null);
      return body.data;
    },
    []
  );

  const value: AppearanceContextValue = useMemo(
    () => ({ prefs, active, colors, save, preview, resetPreview, loading }),
    [prefs, active, colors, save, preview, resetPreview, loading]
  );

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
}

/** Cheap structural equality for AppearancePreferences. customTheme
 *  is compared via JSON.stringify because it's a deeply nested
 *  ThemeColors object and would otherwise need a hand-written walker
 *  for every preset addition. */
function shallowSamePrefs(
  a: AppearancePreferences,
  b: AppearancePreferences
): boolean {
  if (a.themeKey !== b.themeKey) return false;
  if (a.terminalFontFamily !== b.terminalFontFamily) return false;
  if (a.terminalFontSize !== b.terminalFontSize) return false;
  if (a.groupViewServerLabel !== b.groupViewServerLabel) return false;
  return JSON.stringify(a.customTheme) === JSON.stringify(b.customTheme);
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
    active: DEFAULT_PREFERENCES,
    colors: resolveColors(DEFAULT_PREFERENCES),
    save: async (next) => next,
    preview: () => {},
    resetPreview: () => {},
    loading: false,
  };
}
