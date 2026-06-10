"use client";

/**
 * CommandPalette — per-user saved commands (slots 1-9), pasteable into
 * a specific terminal pane.
 *
 * `CommandPaletteButton` bundles the trigger button and the overlay so
 * call sites (the /terminal tab bar and each group-mosaic cell bar)
 * only need to hand it a `onPaste(command)` bound to their pane.
 *
 * Inside the overlay:
 *   - 1-9        paste that slot's command and close
 *   - ↑/↓ +Enter navigate filled slots and paste
 *   - per row    edit / delete / move up / move down
 *   - empty rows offer "+ add"
 *
 * The list is personal and global across servers, persisted via
 * /api/palette (the CLI's Ctrl-A P overlay reads the same data through
 * /api/cli/palette). Every mutation PUTs the full list — at ≤9 entries
 * a replace-all is simpler and makes reorder atomic.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Modal } from "@/components/ui/Modal";

export interface PaletteCommand {
  slot: number;
  label: string | null;
  command: string;
}

const MAX_SLOTS = 9;

async function fetchPalette(): Promise<PaletteCommand[]> {
  const res = await fetch("/api/palette");
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    );
  }
  return (json as { data: { commands: PaletteCommand[] } }).data.commands;
}

async function savePalette(
  commands: PaletteCommand[]
): Promise<PaletteCommand[]> {
  const res = await fetch("/api/palette", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    );
  }
  return (json as { data: { commands: PaletteCommand[] } }).data.commands;
}

interface EditorState {
  slot: number;
  label: string;
  command: string;
  isNew: boolean;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onPaste: (command: string) => void;
}

export function CommandPalette({ open, onClose, onPaste }: CommandPaletteProps) {
  const [commands, setCommands] = useState<PaletteCommand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [selected, setSelected] = useState(0);
  const [saving, setSaving] = useState(false);

  // (Re)load on every open so edits made elsewhere (other tab, CLI) show up.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCommands(null);
    setError(null);
    setEditor(null);
    setSelected(0);
    fetchPalette()
      .then((c) => {
        if (!cancelled) setCommands(c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const persist = useCallback(async (next: PaletteCommand[]) => {
    setSaving(true);
    setError(null);
    try {
      setCommands(await savePalette(next));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Re-fetch so the view reflects what's actually stored.
      try {
        setCommands(await fetchPalette());
      } catch {
        /* keep the error visible */
      }
    } finally {
      setSaving(false);
    }
  }, []);

  const pasteEntry = useCallback(
    (entry: PaletteCommand) => {
      onPaste(entry.command);
      onClose();
    },
    [onPaste, onClose]
  );

  // Number keys + arrow navigation. Disabled while the editor is open
  // (typing "3" into a command must not paste slot 3).
  useEffect(() => {
    if (!open || editor) return;
    const handler = (e: KeyboardEvent) => {
      if (!commands) return;
      if (e.key >= "1" && e.key <= "9") {
        const entry = commands.find((c) => c.slot === Number(e.key));
        if (entry) {
          e.preventDefault();
          pasteEntry(entry);
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (commands.length === 0) return;
        setSelected((prev) => {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          return (prev + delta + commands.length) % commands.length;
        });
        return;
      }
      if (e.key === "Enter") {
        const entry = commands[selected];
        if (entry) {
          e.preventDefault();
          pasteEntry(entry);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, editor, commands, selected, pasteEntry]);

  const beginAdd = (slot: number) =>
    setEditor({ slot, label: "", command: "", isNew: true });
  const beginEdit = (entry: PaletteCommand) =>
    setEditor({
      slot: entry.slot,
      label: entry.label ?? "",
      command: entry.command,
      isNew: false,
    });

  const commitEditor = () => {
    if (!editor || !commands) return;
    const command = editor.command.trim();
    if (!command) {
      setError("Command can't be empty");
      return;
    }
    const next = [
      ...commands.filter((c) => c.slot !== editor.slot),
      {
        slot: editor.slot,
        label: editor.label.trim() || null,
        command,
      },
    ].sort((a, b) => a.slot - b.slot);
    setEditor(null);
    void persist(next);
  };

  const removeEntry = (slot: number) => {
    if (!commands) return;
    void persist(commands.filter((c) => c.slot !== slot));
  };

  /** Move an entry to the adjacent slot; if that slot is occupied the
   *  two entries swap places. */
  const moveEntry = (slot: number, delta: -1 | 1) => {
    if (!commands) return;
    const target = slot + delta;
    if (target < 1 || target > MAX_SLOTS) return;
    const next = commands
      .map((c) => {
        if (c.slot === slot) return { ...c, slot: target };
        if (c.slot === target) return { ...c, slot };
        return c;
      })
      .sort((a, b) => a.slot - b.slot);
    void persist(next);
  };

  const filledBySlot = new Map(
    (commands ?? []).map((c) => [c.slot, c] as const)
  );

  return (
    <Modal open={open} onClose={onClose} title="Command Palette" size="2xl">
      <div className="space-y-1.5">
        {error && (
          <div className="text-xs text-mg-danger bg-mg-bg-tertiary border border-mg-danger/40 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        {commands === null && !error ? (
          <div className="text-sm text-mg-text-secondary py-6 text-center">
            Loading…
          </div>
        ) : (
          Array.from({ length: MAX_SLOTS }, (_, i) => i + 1).map((slot) => {
            const entry = filledBySlot.get(slot);
            const selectedEntry = commands?.[selected];
            const isSelected = entry && selectedEntry?.slot === entry.slot;

            if (editor?.slot === slot) {
              return (
                <div
                  key={slot}
                  className="bg-mg-bg-tertiary border border-mg-accent rounded-lg px-3 py-2.5 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <SlotChip slot={slot} active />
                    <input
                      autoFocus
                      value={editor.label}
                      onChange={(e) =>
                        setEditor({ ...editor, label: e.target.value })
                      }
                      placeholder="Label (optional)"
                      maxLength={60}
                      className="flex-1 bg-mg-bg border border-mg-border rounded px-2 py-1 text-sm text-mg-text focus:outline-none focus:border-mg-accent"
                    />
                  </div>
                  <textarea
                    value={editor.command}
                    onChange={(e) =>
                      setEditor({ ...editor, command: e.target.value })
                    }
                    placeholder="Command — pasted verbatim into the terminal (no Enter appended)"
                    rows={3}
                    className="w-full bg-mg-bg border border-mg-border rounded px-2 py-1.5 text-sm font-mono text-mg-text focus:outline-none focus:border-mg-accent resize-y"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditor(null)}
                      className="px-3 py-1 text-xs rounded text-mg-text-secondary hover:text-mg-text hover:bg-mg-bg-hover"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={commitEditor}
                      disabled={saving || !editor.command.trim()}
                      className="px-3 py-1 text-xs rounded bg-mg-accent text-white hover:opacity-90 disabled:opacity-40"
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              );
            }

            if (!entry) {
              return (
                <button
                  key={slot}
                  type="button"
                  onClick={() => beginAdd(slot)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg border border-dashed border-mg-border text-left hover:border-mg-accent hover:bg-mg-bg-hover transition-all duration-150 group"
                >
                  <SlotChip slot={slot} />
                  <span className="text-xs text-mg-text-tertiary group-hover:text-mg-text-secondary">
                    Empty — click to add
                  </span>
                </button>
              );
            }

            return (
              <div
                key={slot}
                role="button"
                tabIndex={0}
                onClick={() => pasteEntry(entry)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") pasteEntry(entry);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left cursor-pointer transition-all duration-150 group ${
                  isSelected
                    ? "border-mg-accent bg-mg-bg-active"
                    : "border-mg-border bg-mg-bg-tertiary hover:border-mg-accent hover:bg-mg-bg-hover"
                }`}
              >
                <SlotChip slot={slot} active={!!isSelected} />
                <div className="flex-1 min-w-0">
                  {entry.label && (
                    <div className="text-sm text-mg-text truncate">
                      {entry.label}
                    </div>
                  )}
                  <div className="text-xs font-mono text-mg-text-secondary truncate">
                    {entry.command}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <RowAction
                    title="Move up"
                    disabled={slot === 1 || saving}
                    onClick={() => moveEntry(slot, -1)}
                  >
                    ↑
                  </RowAction>
                  <RowAction
                    title="Move down"
                    disabled={slot === MAX_SLOTS || saving}
                    onClick={() => moveEntry(slot, 1)}
                  >
                    ↓
                  </RowAction>
                  <RowAction title="Edit" disabled={saving} onClick={() => beginEdit(entry)}>
                    <svg
                      className="w-3 h-3"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                    </svg>
                  </RowAction>
                  <RowAction
                    title="Delete"
                    danger
                    disabled={saving}
                    onClick={() => removeEntry(slot)}
                  >
                    ✕
                  </RowAction>
                </div>
              </div>
            );
          })
        )}
        <p className="text-[11px] text-mg-text-tertiary pt-2 text-center">
          Press <kbd className="font-mono">1–9</kbd> to paste into this
          terminal · <kbd className="font-mono">↑↓</kbd> +{" "}
          <kbd className="font-mono">Enter</kbd> · also available in the CLI
          via <kbd className="font-mono">Ctrl-A P</kbd>
        </p>
      </div>
    </Modal>
  );
}

function SlotChip({ slot, active = false }: { slot: number; active?: boolean }) {
  return (
    <span
      className={`w-6 h-6 flex items-center justify-center rounded font-mono text-xs font-bold shrink-0 ${
        active
          ? "bg-mg-accent text-white"
          : "bg-mg-bg border border-mg-border text-mg-accent"
      }`}
    >
      {slot}
    </span>
  );
}

function RowAction({
  title,
  onClick,
  disabled = false,
  danger = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`w-6 h-6 flex items-center justify-center rounded text-xs leading-none disabled:opacity-30 disabled:cursor-not-allowed ${
        danger
          ? "text-mg-text-tertiary hover:text-mg-danger hover:bg-mg-bg-hover"
          : "text-mg-text-secondary hover:text-mg-text hover:bg-mg-bg-hover"
      }`}
    >
      {children}
    </button>
  );
}

interface CommandPaletteButtonProps {
  /** Paste a command into the pane this button belongs to. Null while
   *  the pane isn't ready — the button renders disabled. */
  onPaste: ((command: string) => void) | null;
  className?: string;
  iconClassName?: string;
}

export function CommandPaletteButton({
  onPaste,
  className = "",
  iconClassName = "w-4 h-4",
}: CommandPaletteButtonProps) {
  const [open, setOpen] = useState(false);
  // Track the latest paste fn in a ref so the overlay keeps working even
  // if the parent re-renders while it's up.
  const pasteRef = useRef<((command: string) => void) | null>(null);
  useEffect(() => {
    pasteRef.current = onPaste;
  }, [onPaste]);

  return (
    <>
      <button
        type="button"
        disabled={!onPaste}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        className={className}
        title="Command palette — saved commands, 1-9 pastes into this terminal"
        aria-label="Open command palette"
      >
        <svg
          className={iconClassName}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </button>
      <CommandPalette
        open={open}
        onClose={() => setOpen(false)}
        onPaste={(cmd) => pasteRef.current?.(cmd)}
      />
    </>
  );
}
