"use client";

/**
 * Appearance settings — UI for picking a theme, terminal font family,
 * font size, and (when "Custom" is active) tweaking each colour with
 * a native hex picker. Selection is applied immediately as a *preview*
 * via ThemeProvider so the whole app reflects the change; nothing is
 * persisted until Save is pressed.
 *
 * Cancel reverts to whatever the server last gave us (i.e. the
 * provider's pre-edit prefs, which we snapshot on mount and restore).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useAppearance } from "@/lib/themes/provider";
import {
  PRESETS,
  TERMINAL_FONTS,
  TERMINAL_FONT_SIZES,
  resolveColors,
  type AppearancePreferences,
  type ThemeColors,
  type ThemePreset,
  type TerminalPalette,
  type UiPalette,
} from "@/lib/themes/presets";

interface DraftState {
  themeKey: string;
  terminalFontFamily: string;
  terminalFontSize: number;
  customTheme: ThemeColors;
  /** Held in draft only so save() round-trips the value — the Dashboard
   *  tab owns editing this field. */
  groupViewServerLabel: AppearancePreferences["groupViewServerLabel"];
}

function prefsToDraft(prefs: AppearancePreferences): DraftState {
  // Seed the custom theme from whatever's currently resolved so the
  // user doesn't start with random defaults — gives them a sensible
  // starting palette to tweak.
  const seed = prefs.customTheme ?? resolveColors(prefs);
  return {
    themeKey: prefs.themeKey,
    terminalFontFamily: prefs.terminalFontFamily,
    terminalFontSize: prefs.terminalFontSize,
    customTheme: seed,
    groupViewServerLabel: prefs.groupViewServerLabel,
  };
}

function draftToPrefs(d: DraftState): AppearancePreferences {
  return {
    themeKey: d.themeKey,
    terminalFontFamily: d.terminalFontFamily,
    terminalFontSize: d.terminalFontSize,
    customTheme: d.themeKey === "custom" ? d.customTheme : null,
    groupViewServerLabel: d.groupViewServerLabel,
  };
}

/** Two-tone swatch row + sample text — gives the user a quick read on
 *  whether a preset is dark/light and what its accent looks like. */
function ThemeSwatch({ preset }: { preset: ThemePreset }) {
  const t = preset.colors.terminal;
  const ui = preset.colors.ui;
  const ansi: (keyof TerminalPalette)[] = [
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "brightRed",
    "brightGreen",
  ];
  return (
    <div
      className="rounded-md overflow-hidden border"
      style={{ borderColor: ui.border }}
    >
      <div
        className="p-3 flex items-center gap-2"
        style={{ backgroundColor: t.background, color: t.foreground }}
      >
        <span
          className="text-xs font-mono"
          style={{ color: ui.accent }}
        >
          $
        </span>
        <span className="text-xs font-mono truncate flex-1">
          ls -la /home
        </span>
      </div>
      <div
        className="flex h-2"
        style={{ backgroundColor: t.background }}
      >
        {ansi.map((c) => (
          <span
            key={c}
            className="flex-1"
            style={{ backgroundColor: t[c] as string }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Group presets by their `group` field for tidier rendering. Order is
 * preserved from PRESETS (insertion order), which keeps the default
 * theme first.
 */
function groupPresets(presets: ThemePreset[]): { group: string; presets: ThemePreset[] }[] {
  const order: string[] = [];
  const byGroup: Record<string, ThemePreset[]> = {};
  for (const p of presets) {
    if (!byGroup[p.group]) {
      byGroup[p.group] = [];
      order.push(p.group);
    }
    byGroup[p.group].push(p);
  }
  return order.map((g) => ({ group: g, presets: byGroup[g] }));
}

type ColorField = {
  key: keyof TerminalPalette | keyof UiPalette;
  label: string;
  scope: "terminal" | "ui";
};

const TERMINAL_COLOR_FIELDS: ColorField[] = [
  { key: "background", label: "Background", scope: "terminal" },
  { key: "foreground", label: "Foreground", scope: "terminal" },
  { key: "cursor", label: "Cursor", scope: "terminal" },
  { key: "black", label: "Black", scope: "terminal" },
  { key: "red", label: "Red", scope: "terminal" },
  { key: "green", label: "Green", scope: "terminal" },
  { key: "yellow", label: "Yellow", scope: "terminal" },
  { key: "blue", label: "Blue", scope: "terminal" },
  { key: "magenta", label: "Magenta", scope: "terminal" },
  { key: "cyan", label: "Cyan", scope: "terminal" },
  { key: "white", label: "White", scope: "terminal" },
  { key: "brightBlack", label: "Bright Black", scope: "terminal" },
  { key: "brightRed", label: "Bright Red", scope: "terminal" },
  { key: "brightGreen", label: "Bright Green", scope: "terminal" },
  { key: "brightYellow", label: "Bright Yellow", scope: "terminal" },
  { key: "brightBlue", label: "Bright Blue", scope: "terminal" },
  { key: "brightMagenta", label: "Bright Magenta", scope: "terminal" },
  { key: "brightCyan", label: "Bright Cyan", scope: "terminal" },
  { key: "brightWhite", label: "Bright White", scope: "terminal" },
];

const UI_COLOR_FIELDS: ColorField[] = [
  { key: "bg", label: "App background", scope: "ui" },
  { key: "bgSecondary", label: "Panel background", scope: "ui" },
  { key: "bgTertiary", label: "Raised background", scope: "ui" },
  { key: "bgHover", label: "Hover", scope: "ui" },
  { key: "bgActive", label: "Active", scope: "ui" },
  { key: "accent", label: "Accent", scope: "ui" },
  { key: "accentBright", label: "Accent bright", scope: "ui" },
  { key: "accentDim", label: "Accent dim", scope: "ui" },
  { key: "text", label: "Text", scope: "ui" },
  { key: "textSecondary", label: "Text secondary", scope: "ui" },
  { key: "textTertiary", label: "Text tertiary", scope: "ui" },
  { key: "border", label: "Border", scope: "ui" },
  { key: "borderHover", label: "Border hover", scope: "ui" },
  { key: "success", label: "Success (online)", scope: "ui" },
  { key: "warning", label: "Warning", scope: "ui" },
  { key: "danger", label: "Danger / error", scope: "ui" },
  { key: "info", label: "Info / pending", scope: "ui" },
];

/** Normalise any string into a 6-digit hex acceptable to <input type="color">.
 *  Rejects rgba() (used for selection backgrounds) by falling back to
 *  a plain hex from its rgb portion; native picker can't represent
 *  alpha anyway. Returns "#000000" as a last resort. */
function normaliseHex(value: string): string {
  if (!value) return "#000000";
  if (value.startsWith("#")) {
    if (value.length === 7) return value.toLowerCase();
    if (value.length === 4) {
      // expand #abc → #aabbcc
      const r = value[1];
      const g = value[2];
      const b = value[3];
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
  }
  const rgba = value.match(
    /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i
  );
  if (rgba) {
    const r = parseInt(rgba[1], 10);
    const g = parseInt(rgba[2], 10);
    const b = parseInt(rgba[3], 10);
    return (
      "#" +
      [r, g, b]
        .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  return "#000000";
}

function ColorPickerRow({
  field,
  value,
  onChange,
}: {
  field: ColorField;
  value: string;
  onChange: (next: string) => void;
}) {
  const hex = normaliseHex(value);
  return (
    <label className="flex items-center gap-3 text-xs">
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-10 rounded border border-mg-border bg-transparent cursor-pointer"
        aria-label={field.label}
      />
      <span className="flex-1 text-mg-text-secondary">{field.label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 px-2 py-1 rounded border border-mg-border bg-mg-bg-tertiary text-mg-text font-mono text-xs"
      />
    </label>
  );
}

export function AppearanceTab() {
  const appearance = useAppearance();
  const { toast } = useToast();

  // `persisted` is what's on the server (DEFAULT_PREFERENCES while the
  // initial /api/preferences fetch is in flight). The provider only
  // mutates `appearance.prefs` on initial fetch and on successful
  // save() — never from our own preview() calls — so reading it here
  // is loop-safe.
  const persisted = appearance.prefs;
  const [draft, setDraft] = useState<DraftState>(() => prefsToDraft(persisted));
  const [saving, setSaving] = useState(false);

  // One-shot init: when the initial fetch lands (loading false → true
  // becomes loading true → false), pull the just-fetched persisted
  // prefs into the draft. After that we never auto-sync again — the
  // user owns the draft until they Save or Cancel. Tracked via a ref
  // so subsequent loading flips or persisted updates from save() can't
  // re-fire the sync and overwrite in-flight edits. This is what
  // makes the effect loop-proof: a single boolean guards the only
  // setState path inside it.
  const initSyncedRef = useRef(false);
  useEffect(() => {
    if (initSyncedRef.current) return;
    if (appearance.loading) return;
    initSyncedRef.current = true;
    setDraft(prefsToDraft(appearance.prefs));
  }, [appearance.loading, appearance.prefs]);

  const dirty = useMemo(() => {
    return JSON.stringify(draftToPrefs(draft)) !== JSON.stringify(persisted);
  }, [draft, persisted]);

  // Push the current draft into ThemeProvider as a preview every time
  // it changes — that's what makes the whole app re-skin live. The
  // provider's preview() updates only `previewOverride`, not `prefs`,
  // so this doesn't re-trigger the sync effect above.
  useEffect(() => {
    appearance.preview(draftToPrefs(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Drop the preview override when the editor unmounts (user
  // navigates away without saving) so the app falls back to the
  // persisted theme. Without this, leaving the tab mid-edit would
  // strand the preview palette on every other page.
  useEffect(() => {
    return () => appearance.resetPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectTheme = (key: string) => {
    if (key === "custom") {
      // Seed the custom palette from the currently-visible theme so
      // the picker starts somewhere sensible. Keep an existing user
      // palette if they previously authored one.
      const seed = persisted.customTheme ?? resolveColors(draftToPrefs(draft));
      setDraft({ ...draft, themeKey: "custom", customTheme: seed });
    } else {
      setDraft({ ...draft, themeKey: key });
    }
  };

  const setCustomColor = (field: ColorField, hex: string) => {
    setDraft((d) => {
      const next = { ...d };
      if (field.scope === "terminal") {
        next.customTheme = {
          ...next.customTheme,
          terminal: {
            ...next.customTheme.terminal,
            [field.key]: hex,
          },
        };
      } else {
        next.customTheme = {
          ...next.customTheme,
          ui: {
            ...next.customTheme.ui,
            [field.key]: hex,
          },
        };
      }
      return next;
    });
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const saved = await appearance.save(draftToPrefs(draft));
      // `appearance.prefs` is now `saved` — the sync effect will see
      // the change and align lastSyncedSnapRef. We still call setDraft
      // explicitly so the form fields reflect any server-side
      // validation (e.g. font size clamping) instead of waiting a
      // render for the sync effect to do it.
      setDraft(prefsToDraft(saved));
      toast("Appearance saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  const onCancel = () => {
    // Revert form to the currently persisted state and let the
    // provider drop its preview override so the dashboard repaints
    // with the saved theme too.
    setDraft(prefsToDraft(persisted));
    appearance.resetPreview();
  };

  const groups = useMemo(() => groupPresets(PRESETS), []);

  const isCustom = draft.themeKey === "custom";

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-mg-text-secondary">
          Pick a colour scheme — it applies to the dashboard and your
          terminal at the same time. Customise font and individual
          colours below; nothing is saved until you press Save.
        </p>
      </div>

      <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-mg-text">Theme</h3>
          {dirty && (
            <span className="text-xs text-mg-accent-bright">
              Unsaved changes
            </span>
          )}
        </div>
        {groups.map((g) => (
          <div key={g.group}>
            <p className="text-xs text-mg-text-tertiary uppercase tracking-wide mb-2">
              {g.group}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {g.presets.map((p) => {
                const selected = draft.themeKey === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => selectTheme(p.key)}
                    className={`text-left rounded-lg border p-3 transition-all duration-150 ${
                      selected
                        ? "border-mg-accent ring-1 ring-mg-accent bg-mg-bg-tertiary"
                        : "border-mg-border hover:border-mg-accent-dim bg-mg-bg-tertiary/50"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-mg-text font-medium">
                        {p.label}
                      </span>
                      {selected && (
                        <span className="text-[10px] text-mg-accent uppercase tracking-wide">
                          Active
                        </span>
                      )}
                    </div>
                    <ThemeSwatch preset={p} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div>
          <p className="text-xs text-mg-text-tertiary uppercase tracking-wide mb-2">
            Custom
          </p>
          <button
            type="button"
            onClick={() => selectTheme("custom")}
            className={`w-full text-left rounded-lg border p-3 transition-all duration-150 ${
              isCustom
                ? "border-mg-accent ring-1 ring-mg-accent bg-mg-bg-tertiary"
                : "border-mg-border hover:border-mg-accent-dim bg-mg-bg-tertiary/50"
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-mg-text font-medium">
                  Custom theme
                </p>
                <p className="text-xs text-mg-text-tertiary mt-0.5">
                  Tweak every colour by hand — picker + hex below.
                </p>
              </div>
              {isCustom && (
                <span className="text-[10px] text-mg-accent uppercase tracking-wide">
                  Active
                </span>
              )}
            </div>
          </button>
        </div>
      </div>

      <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4 space-y-4">
        <h3 className="text-sm font-semibold text-mg-text">Terminal font</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select
            label="Font family"
            options={TERMINAL_FONTS}
            value={draft.terminalFontFamily}
            onChange={(e) =>
              setDraft({ ...draft, terminalFontFamily: e.target.value })
            }
          />
          <Select
            label="Font size"
            options={TERMINAL_FONT_SIZES.map((s) => ({
              value: String(s),
              label: `${s}px`,
            }))}
            value={String(draft.terminalFontSize)}
            onChange={(e) =>
              setDraft({
                ...draft,
                terminalFontSize: parseInt(e.target.value, 10) || 14,
              })
            }
          />
        </div>
        <p className="text-xs text-mg-text-tertiary">
          Font changes take effect immediately on the next terminal frame.
          The font file must be installed locally; pick a system font
          (Menlo, Consolas) if you haven't installed a programming font.
        </p>
      </div>

      {isCustom && (
        <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4 space-y-4 animate-fade-in">
          <h3 className="text-sm font-semibold text-mg-text">
            Custom colours
          </h3>
          <p className="text-xs text-mg-text-secondary">
            Hex values accept #rgb or #rrggbb. The text input lets you
            paste a value when you can't get a precise shade out of the
            native picker (e.g. an alpha-channel rgba()).
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-mg-text-tertiary">
                Dashboard
              </p>
              {UI_COLOR_FIELDS.map((f) => (
                <ColorPickerRow
                  key={f.key as string}
                  field={f}
                  value={
                    (draft.customTheme.ui as unknown as Record<string, string>)[
                      f.key as string
                    ] ?? "#000000"
                  }
                  onChange={(v) => setCustomColor(f, v)}
                />
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-mg-text-tertiary">
                Terminal
              </p>
              {TERMINAL_COLOR_FIELDS.map((f) => (
                <ColorPickerRow
                  key={f.key as string}
                  field={f}
                  value={
                    (draft.customTheme
                      .terminal as unknown as Record<string, string>)[
                      f.key as string
                    ] ?? "#000000"
                  }
                  onChange={(v) => setCustomColor(f, v)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 sticky bottom-0 bg-mg-bg/90 backdrop-blur py-3 -mx-6 px-6 border-t border-mg-border">
        <Button
          variant="secondary"
          onClick={onCancel}
          disabled={!dirty || saving}
        >
          Cancel
        </Button>
        <Button onClick={onSave} loading={saving} disabled={!dirty}>
          Save appearance
        </Button>
      </div>
    </div>
  );
}
