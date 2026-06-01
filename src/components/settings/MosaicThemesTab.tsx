"use client";

/**
 * Settings → Mosaic Themes. Previews the CLI mosaic theme presets, lets the
 * user pick the active one (synced to the Rust CLI via /api/cli/themes), and
 * provides a custom-theme designer (per-role colors + border line style +
 * name). Persists through the shared appearance preferences
 * (useAppearance().save), which the CLI reads back.
 */
import React, { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useAppearance } from "@/lib/themes/provider";
import {
  DEFAULT_MOSAIC_THEME,
  LINE_STYLES,
  LINE_STYLE_LIST,
  MOSAIC_CUSTOM_MAX,
  MOSAIC_CUSTOM_NAME_MAX,
  MOSAIC_PRESETS,
  MOSAIC_PRESETS_BY_NAME,
  MOSAIC_ROLE_GROUPS,
  MOSAIC_ROLE_LABELS,
  sanitizeCustomThemes,
  type MosaicTheme,
  type MosaicThemeColors,
} from "@/lib/mosaic-themes/presets";
import { MosaicThemePreview } from "@/components/settings/MosaicThemePreview";

function lineStyleLabel(key: string): string {
  const s = LINE_STYLES[key] ?? LINE_STYLES.light;
  const base = LINE_STYLE_LIST.find((l) => l.key === key)?.label ?? key;
  return `${base}  ${s.tl}${s.h}${s.tr}`;
}

function normaliseHex(value: string): string {
  if (value.startsWith("#") && value.length === 7) return value.toLowerCase();
  if (value.startsWith("#") && value.length === 4) {
    const [, r, g, b] = value;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return "#000000";
}

export function MosaicThemesTab() {
  const appearance = useAppearance();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ draft: MosaicTheme; originalName: string | null } | null>(
    null
  );

  const active = appearance.prefs.mosaicThemeActive ?? DEFAULT_MOSAIC_THEME;
  const customs = appearance.prefs.mosaicCustomThemes ?? [];

  const commit = async (next: { active?: string; customs?: MosaicTheme[] }) => {
    setBusy(true);
    try {
      await appearance.save({
        ...appearance.prefs,
        mosaicThemeActive: next.active ?? active,
        mosaicCustomThemes: next.customs ?? customs,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const setActive = (name: string) => {
    if (name === active || busy) return;
    void commit({ active: name });
  };

  const deleteCustom = (name: string) => {
    const nextCustoms = customs.filter((c) => c.name !== name);
    void commit({
      customs: nextCustoms,
      active: active === name ? DEFAULT_MOSAIC_THEME : active,
    });
  };

  const openNew = () => {
    const base = MOSAIC_PRESETS_BY_NAME[DEFAULT_MOSAIC_THEME];
    setEditor({
      draft: { name: "", builtin: false, lineStyle: base.lineStyle, colors: { ...base.colors } },
      originalName: null,
    });
  };

  const openEdit = (theme: MosaicTheme) => {
    setEditor({
      draft: { ...theme, colors: { ...theme.colors } },
      originalName: theme.name,
    });
  };

  const saveEditor = async (setActiveToo: boolean) => {
    if (!editor) return;
    const name = editor.draft.name.trim();
    if (!name) return toast("Give the theme a name", "error");
    if (name.length > MOSAIC_CUSTOM_NAME_MAX)
      return toast(`Name must be ≤ ${MOSAIC_CUSTOM_NAME_MAX} chars`, "error");
    if (name in MOSAIC_PRESETS_BY_NAME)
      return toast(`"${name}" is a built-in name`, "error");
    if (customs.some((c) => c.name === name && c.name !== editor.originalName))
      return toast(`A theme named "${name}" already exists`, "error");

    const theme: MosaicTheme = { ...editor.draft, name, builtin: false };
    const nextCustoms = editor.originalName
      ? customs.map((c) => (c.name === editor.originalName ? theme : c))
      : [...customs, theme];
    // If we renamed the currently-active custom, follow the rename.
    let nextActive = active;
    if (setActiveToo) nextActive = name;
    else if (editor.originalName && active === editor.originalName) nextActive = name;

    await commit({ customs: nextCustoms, active: nextActive });
    setEditor(null);
  };

  const allThemes = useMemo(() => [...MOSAIC_PRESETS, ...customs], [customs]);

  // --- Import / export ---
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const copyTheme = async (theme: MosaicTheme) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify([theme], null, 2));
      toast(`Copied "${theme.name}" JSON`, "success");
    } catch {
      toast("Clipboard unavailable", "error");
    }
  };

  const exportAll = () => {
    if (customs.length === 0) return toast("No custom themes to export", "error");
    const json = JSON.stringify(customs, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mosaic-themes.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const runImport = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      return toast("Invalid JSON", "error");
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const incoming = sanitizeCustomThemes(arr); // drops built-in collisions + bad entries
    if (incoming.length === 0) return toast("No valid custom themes in that JSON", "error");

    const taken = new Set<string>([
      ...Object.keys(MOSAIC_PRESETS_BY_NAME),
      ...customs.map((c) => c.name),
    ]);
    const merged = [...customs];
    let added = 0;
    for (const t of incoming) {
      if (merged.length >= MOSAIC_CUSTOM_MAX) break;
      let name = t.name;
      if (taken.has(name)) {
        let n = 2;
        while (taken.has(`${t.name} (${n})`)) n++;
        name = `${t.name} (${n})`.slice(0, MOSAIC_CUSTOM_NAME_MAX);
      }
      taken.add(name);
      merged.push({ ...t, name });
      added += 1;
    }
    await commit({ customs: merged });
    toast(`Imported ${added} theme(s)`, "success");
    setImportOpen(false);
    setImportText("");
  };

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => setImportText(t));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-mg-text-secondary">
          Themes for the <span className="font-mono">managet group open</span> /{" "}
          <span className="font-mono">stack open</span> terminal mosaic — colors and
          border line style. The active theme and your custom themes sync to the CLI;
          run <span className="font-mono">managet theme list</span> to see them there.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="ghost" onClick={() => setImportOpen(true)} disabled={busy}>
            Import
          </Button>
          <Button size="sm" variant="ghost" onClick={exportAll} disabled={busy}>
            Export
          </Button>
          <Button size="sm" onClick={openNew} disabled={busy}>
            + New theme
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {allThemes.map((theme) => {
          const isActive = theme.name === active;
          return (
            <div
              key={theme.name}
              className={`rounded-lg border p-3 space-y-2 transition-all ${
                isActive
                  ? "border-mg-accent ring-1 ring-mg-accent bg-mg-bg-tertiary"
                  : "border-mg-border bg-mg-bg-secondary hover:border-mg-accent-dim"
              }`}
            >
              <MosaicThemePreview theme={theme} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-mg-text font-medium truncate">
                  {theme.name}
                  {theme.builtin && (
                    <span className="ml-2 text-[10px] text-mg-text-tertiary uppercase">
                      built-in
                    </span>
                  )}
                </span>
                {isActive && (
                  <span className="text-[10px] text-mg-accent uppercase tracking-wide">
                    Active
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={isActive ? "secondary" : "primary"}
                  onClick={() => setActive(theme.name)}
                  disabled={busy || isActive}
                >
                  {isActive ? "Active" : "Use"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void copyTheme(theme)} disabled={busy}>
                  Copy
                </Button>
                {!theme.builtin && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(theme)} disabled={busy}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => deleteCustom(theme.name)}
                      disabled={busy}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editor && (
        <DesignerModal
          editor={editor}
          onChange={(draft) => setEditor({ ...editor, draft })}
          onClose={() => setEditor(null)}
          onSave={saveEditor}
          busy={busy}
        />
      )}

      {importOpen && (
        <Modal
          open
          onClose={() => setImportOpen(false)}
          title="Import mosaic themes"
          size="lg"
          footer={
            <>
              <Button variant="secondary" onClick={() => setImportOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void runImport()} disabled={busy || !importText.trim()}>
                Import
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-xs text-mg-text-tertiary">
              Paste a theme JSON (a single theme or an array, e.g. from another
              user&apos;s Export / Copy), or load a <span className="font-mono">.json</span> file.
              Names that collide with a built-in or an existing custom are renamed.
            </p>
            <label className="text-xs text-mg-text-secondary inline-flex items-center gap-2">
              <span>Load file:</span>
              <input
                type="file"
                accept=".json,application/json"
                onChange={onImportFile}
                className="text-xs text-mg-text-secondary file:mr-2 file:rounded file:border file:border-mg-border file:bg-mg-bg-tertiary file:px-2 file:py-1 file:text-mg-text"
              />
            </label>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='[{"name":"my-theme","lineStyle":"rounded","colors":{ ... }}]'
              spellCheck={false}
              className="w-full h-48 rounded-lg bg-mg-bg-tertiary border border-mg-border px-3 py-2 text-xs font-mono text-mg-text focus:border-mg-accent focus:outline-none resize-y"
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

function DesignerModal({
  editor,
  onChange,
  onClose,
  onSave,
  busy,
}: {
  editor: { draft: MosaicTheme; originalName: string | null };
  onChange: (draft: MosaicTheme) => void;
  onClose: () => void;
  onSave: (setActiveToo: boolean) => void;
  busy: boolean;
}) {
  const { draft } = editor;

  const setColor = (role: keyof MosaicThemeColors, value: string) =>
    onChange({ ...draft, colors: { ...draft.colors, [role]: value } });

  const startFrom = (name: string) => {
    const base = MOSAIC_PRESETS_BY_NAME[name];
    if (!base) return;
    onChange({ ...draft, lineStyle: base.lineStyle, colors: { ...base.colors } });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editor.originalName ? `Edit "${editor.originalName}"` : "New mosaic theme"}
      size="3xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="ghost" onClick={() => onSave(false)} disabled={busy}>
            Save
          </Button>
          <Button onClick={() => onSave(true)} disabled={busy}>
            Save & use
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Left: controls */}
        <div className="space-y-4">
          <Input
            label="Name"
            value={draft.name}
            maxLength={MOSAIC_CUSTOM_NAME_MAX}
            placeholder="my-theme"
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Start from"
              value=""
              options={[
                { value: "", label: "(pick a base…)" },
                ...MOSAIC_PRESETS.map((p) => ({ value: p.name, label: p.name })),
              ]}
              onChange={(e) => startFrom(e.target.value)}
            />
            <Select
              label="Line style"
              value={draft.lineStyle}
              options={LINE_STYLE_LIST.map((l) => ({
                value: l.key,
                label: lineStyleLabel(l.key),
              }))}
              onChange={(e) => onChange({ ...draft, lineStyle: e.target.value })}
            />
          </div>

          <div className="space-y-4 max-h-[46vh] overflow-y-auto pr-1">
            {MOSAIC_ROLE_GROUPS.map((group) => (
              <div key={group.label} className="space-y-2">
                <h4 className="text-xs font-semibold text-mg-text-secondary uppercase tracking-wide">
                  {group.label}
                </h4>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {group.keys.map((role) => (
                    <ColorRow
                      key={role}
                      label={MOSAIC_ROLE_LABELS[role]}
                      value={draft.colors[role]}
                      onChange={(v) => setColor(role, v)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: live preview */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-mg-text-secondary uppercase tracking-wide">
            Live preview
          </h4>
          <MosaicThemePreview theme={draft} />
          <p className="text-xs text-mg-text-tertiary">
            Named built-in colors (e.g. the default theme&apos;s cyan) adapt to the
            terminal palette on the CLI; custom colors are exact.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const hex = normaliseHex(value);
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-9 rounded border border-mg-border bg-transparent cursor-pointer shrink-0"
        aria-label={label}
      />
      <span className="flex-1 text-mg-text-secondary truncate">{label}</span>
    </label>
  );
}
