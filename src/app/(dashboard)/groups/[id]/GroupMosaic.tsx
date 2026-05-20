"use client";

/**
 * GroupMosaic — the resizable, drag-and-drop reorderable mosaic of
 * terminal panes inside a group.
 *
 * Layout rule (3-per-row, max 6 panes):
 *   1  → [ 1 ]
 *   2  → [ 1 | 2 ]
 *   3  → [ 1 | 2 | 3 ]
 *   4  → [ 1 | 2 | 3 ] / [ 4 ]
 *   5  → [ 1 | 2 | 3 ] / [ 4 | 5 ]
 *   6  → [ 1 | 2 | 3 ] / [ 4 | 5 | 6 ]
 *
 * Persistence: row heights, per-row column widths, and per-pane font
 * sizes are persisted per-user via /api/groups/[id]/layout. Member
 * order is persisted on the sessions table itself (groupOrderIndex)
 * via /api/groups/[id]/order. Combined, the next visit restores the
 * mosaic exactly as it was.
 *
 * Important: panel sizes are wired through `defaultSize`, which
 * react-resizable-panels reads only on mount. So we gate rendering on
 * `layoutLoaded` — until the saved layout fetch resolves, we show a
 * tiny placeholder. Without this gate the panels mount with the
 * equal-split default, the saved layout arrives a frame later, and
 * the panels happily ignore it.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { TerminalPane } from "@/components/terminal/TerminalPane";
import {
  getGroupLayout,
  reorderGroup,
  saveGroupLayout,
} from "@/lib/hooks/useApi";
import { useAppearance } from "@/lib/themes/provider";
import type { Group, GroupLayout, Server, Session } from "@/types";

interface GroupMosaicProps {
  group: Group;
  serversById: Map<string, Server>;
  onReorderPersisted: () => void;
  onRemoveMember: (sessionId: string) => void;
  /** Called when the user submits an inline rename in the bar. Should
   *  PATCH the session and trigger a refetch so the new name flows
   *  back through `group.members`. */
  onRenameMember: (sessionId: string, name: string) => void | Promise<void>;
}

/** Imperative handle exposed to the page so its group-level +/- buttons
 *  can drive the layout state that this component owns. */
export interface GroupMosaicHandle {
  /** Bump every member's font size by `delta`, clamped to the limits. */
  bumpAll: (delta: number) => void;
}

const LAYOUT_DEBOUNCE_MS = 350;
const FONT_MIN = 8;
const FONT_MAX = 28;
const FONT_STEP = 1;

/** Mirror of `defaultLayoutForCount` in src/lib/groups. Inlined here so
 *  the client bundle doesn't pull in the drizzle/db side of that module. */
function defaultLayoutForCount(n: number): GroupLayout {
  if (n <= 0) return { rowHeights: [1], colWidthsByRow: [[]] };
  const rows = n <= 3 ? 1 : 2;
  const firstRow = Math.min(n, 3);
  const secondRow = Math.max(0, n - firstRow);
  if (rows === 1) {
    return {
      rowHeights: [1],
      colWidthsByRow: [Array.from({ length: firstRow }, () => 1 / firstRow)],
    };
  }
  return {
    rowHeights: [0.5, 0.5],
    colWidthsByRow: [
      Array.from({ length: firstRow }, () => 1 / firstRow),
      Array.from({ length: secondRow }, () => 1 / secondRow),
    ],
  };
}

/** Slice the ordered member array into two visual rows (max 3-per-row). */
function partitionRows<T>(items: T[]): T[][] {
  if (items.length <= 3) return [items];
  return [items.slice(0, 3), items.slice(3)];
}

/** Membership-shape signature used to gate the panel remount when the
 *  member count changes (e.g. someone added or removed a terminal).
 *  Different signature ⇒ different `key` ⇒ the PanelGroup remounts and
 *  picks up the appropriate defaults. Without this, going from 3→4
 *  members would keep the old single-row layout. */
function shapeKey(members: Session[]): string {
  const ids = members.map((m) => m.id).join("|");
  return `${members.length}::${ids}`;
}

export const GroupMosaic = forwardRef<GroupMosaicHandle, GroupMosaicProps>(
  function GroupMosaicImpl(
    {
      group,
      serversById,
      onReorderPersisted,
      onRemoveMember,
      onRenameMember,
    },
    ref
  ) {
  const members = group.members;
  const memberCount = members.length;
  const rows = useMemo(() => partitionRows(members), [members]);
  const appearance = useAppearance();
  const baseFontSize = appearance.active.terminalFontSize;

  // Single state cell holds (groupId, layout) so the placeholder
  // condition `layoutState.groupId !== group.id` works without us
  // having to reset state inside the effect (which lint and React's
  // guidance both flag as a smell). When the user navigates from
  // group A → B, the stale `layoutState.groupId === A` makes the
  // gate render the placeholder until the fetch for B lands.
  const [layoutState, setLayoutState] = useState<{
    groupId: string;
    layout: GroupLayout;
  } | null>(null);

  // Fetch persisted layout when the group changes. If the saved shape
  // doesn't match the current member arrangement (e.g. someone added a
  // terminal since last visit), fall back to the equal-split default —
  // the next drag overwrites the stored copy.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let saved: GroupLayout | null = null;
      try {
        saved = await getGroupLayout(group.id);
      } catch {
        saved = null;
      }
      if (cancelled) return;
      const fresh = defaultLayoutForCount(memberCount);
      const shapeOk =
        saved &&
        saved.rowHeights.length === fresh.rowHeights.length &&
        saved.colWidthsByRow.length === fresh.colWidthsByRow.length &&
        saved.colWidthsByRow.every(
          (r, i) => r.length === fresh.colWidthsByRow[i].length
        );
      // Preserve font-size overrides even when the row/col shape no
      // longer matches — a font choice for session X is still valid
      // regardless of how the panels are split.
      const merged: GroupLayout = shapeOk
        ? (saved as GroupLayout)
        : { ...fresh, fontSizeBySession: saved?.fontSizeBySession };
      setLayoutState({ groupId: group.id, layout: merged });
    })();
    return () => {
      cancelled = true;
    };
  }, [group.id, memberCount]);

  const layout =
    layoutState && layoutState.groupId === group.id
      ? layoutState.layout
      : null;
  const setLayout = useCallback(
    (updater: (prev: GroupLayout) => GroupLayout) => {
      setLayoutState((prev) => {
        if (!prev || prev.groupId !== group.id) return prev;
        return { groupId: group.id, layout: updater(prev.layout) };
      });
    },
    [group.id]
  );

  // Debounced persistence: drags + font bumps fire many writes — only
  // the last one in a 350ms window hits the server.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistLayout = useCallback(
    (next: GroupLayout) => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        saveGroupLayout(group.id, next).catch((err) => {
          console.warn("[groups] save layout failed:", err);
        });
      }, LAYOUT_DEBOUNCE_MS);
    },
    [group.id]
  );
  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, []);

  const handleRowHeightsChange = (sizes: number[]) => {
    // PanelGroup gives percentages 0..100; normalise to 0..1 ratios.
    setLayout((prev) => {
      const base = prev ?? defaultLayoutForCount(memberCount);
      const next: GroupLayout = { ...base, rowHeights: sizes.map((p) => p / 100) };
      persistLayout(next);
      return next;
    });
  };
  const handleRowColsChange = (rowIdx: number) => (sizes: number[]) => {
    setLayout((prev) => {
      const base = prev ?? defaultLayoutForCount(memberCount);
      const next: GroupLayout = {
        ...base,
        colWidthsByRow: base.colWidthsByRow.map((row, i) =>
          i === rowIdx ? sizes.map((p) => p / 100) : row
        ),
      };
      persistLayout(next);
      return next;
    });
  };

  // Per-pane font controls. Clamped to [FONT_MIN, FONT_MAX] so the
  // user can't land on something the layout can't accommodate.
  const bumpFont = (sessionId: string, delta: number) => {
    setLayout((prev) => {
      const current =
        prev.fontSizeBySession?.[sessionId] ?? baseFontSize;
      const nextSize = Math.max(
        FONT_MIN,
        Math.min(FONT_MAX, current + delta)
      );
      if (nextSize === current) return prev;
      const nextMap = {
        ...(prev.fontSizeBySession ?? {}),
        [sessionId]: nextSize,
      };
      const next: GroupLayout = { ...prev, fontSizeBySession: nextMap };
      persistLayout(next);
      return next;
    });
  };

  // Group-wide font bump. Mirrors the per-pane behaviour but writes
  // every member's override in a single state update so the persist
  // debounce fires once for the whole batch.
  const bumpAllFont = useCallback(
    (delta: number) => {
      setLayout((prev) => {
        const base = prev.fontSizeBySession ?? {};
        const nextMap: Record<string, number> = { ...base };
        let changed = false;
        for (const m of members) {
          const current = base[m.id] ?? baseFontSize;
          const nextSize = Math.max(
            FONT_MIN,
            Math.min(FONT_MAX, current + delta)
          );
          nextMap[m.id] = nextSize;
          if (nextSize !== current) changed = true;
        }
        if (!changed) return prev;
        const next: GroupLayout = { ...prev, fontSizeBySession: nextMap };
        persistLayout(next);
        return next;
      });
    },
    [members, baseFontSize, persistLayout, setLayout]
  );

  useImperativeHandle(ref, () => ({ bumpAll: bumpAllFont }), [bumpAllFont]);

  // --- Drag-and-drop reorder ---
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const isDragging = dragId !== null;

  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    setDragId(sessionId);
    e.dataTransfer.effectAllowed = "move";
    // Some browsers refuse to start a drag without data set.
    e.dataTransfer.setData("text/plain", sessionId);
  };
  const handleDragOver = (e: React.DragEvent, sessionId: string) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (hoverId !== sessionId) setHoverId(sessionId);
  };
  const handleDragLeave = (sessionId: string) => {
    if (hoverId === sessionId) setHoverId(null);
  };
  const handleDragEnd = () => {
    setDragId(null);
    setHoverId(null);
  };
  const handleDrop = async (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = dragId;
    setDragId(null);
    setHoverId(null);
    if (!sourceId || sourceId === targetId) return;
    // Swap the two positions and PUT the new order. Optimistic — the
    // parent's refetch reconciles if the server changed anything.
    const ids = members.map((m) => m.id);
    const a = ids.indexOf(sourceId);
    const b = ids.indexOf(targetId);
    if (a < 0 || b < 0) return;
    [ids[a], ids[b]] = [ids[b], ids[a]];
    try {
      await reorderGroup(group.id, ids);
      onReorderPersisted();
    } catch (err) {
      console.warn("[groups] reorder failed:", err);
    }
  };

  if (memberCount === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-mg-text-tertiary">
        This group has no terminals yet.
      </div>
    );
  }

  // Wait for the layout fetch before rendering panels — see the
  // header comment. Brief flash, but avoids the "saved layout ignored"
  // bug from defaultSize-only-on-mount.
  if (!layout) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-mg-text-tertiary">
        Restoring layout…
      </div>
    );
  }

  // PanelGroup needs to remount when the member arrangement changes
  // (so panels pick up new defaults) — see `shapeKey`. Within a single
  // arrangement, panel sizes are controlled live by drag.
  const mosaicKey = shapeKey(members);

  const renderRow = (rowItems: Session[], rowIdx: number) => {
    const startSlot = rowIdx === 0 ? 0 : rows[0].length;
    return (
      <PanelGroup
        direction="horizontal"
        onLayout={handleRowColsChange(rowIdx)}
      >
        {rowItems.map((m, colIdx) => {
          const slotNumber = startSlot + colIdx + 1;
          const isSource = dragId === m.id;
          const isHoverTarget = hoverId === m.id && dragId !== m.id;
          const colSize =
            (layout.colWidthsByRow[rowIdx]?.[colIdx] ?? 1 / rowItems.length) *
            100;
          const fontSize =
            layout.fontSizeBySession?.[m.id] ?? baseFontSize;
          const server = serversById.get(m.serverId);
          return (
            <React.Fragment key={m.id}>
              {colIdx > 0 && (
                <PanelResizeHandle
                  className={`w-1 transition-colors ${
                    isDragging
                      ? "bg-mg-accent shadow-[0_0_8px_var(--color-mg-accent)]"
                      : "bg-mg-border hover:bg-mg-accent data-[resize-handle-state=drag]:bg-mg-accent"
                  }`}
                />
              )}
              <Panel defaultSize={colSize} minSize={10}>
                <MosaicCell
                  member={m}
                  serverHost={server?.host}
                  slotNumber={slotNumber}
                  totalSlots={memberCount}
                  isDragging={isDragging}
                  isSource={isSource}
                  isHoverTarget={isHoverTarget}
                  fontSize={fontSize}
                  canBumpUp={fontSize < FONT_MAX}
                  canBumpDown={fontSize > FONT_MIN}
                  onDragStart={(e) => handleDragStart(e, m.id)}
                  onDragOver={(e) => handleDragOver(e, m.id)}
                  onDragLeave={() => handleDragLeave(m.id)}
                  onDragEnd={handleDragEnd}
                  onDrop={(e) => handleDrop(e, m.id)}
                  onRemove={() => onRemoveMember(m.id)}
                  onRename={(name) => onRenameMember(m.id, name)}
                  onBumpFontUp={() => bumpFont(m.id, FONT_STEP)}
                  onBumpFontDown={() => bumpFont(m.id, -FONT_STEP)}
                />
              </Panel>
            </React.Fragment>
          );
        })}
      </PanelGroup>
    );
  };

  if (rows.length === 1) {
    return (
      <div className="h-full" key={mosaicKey}>
        {renderRow(rows[0], 0)}
      </div>
    );
  }

  const row1Size = (layout.rowHeights[0] ?? 0.5) * 100;
  const row2Size = (layout.rowHeights[1] ?? 0.5) * 100;

  return (
    <PanelGroup
      key={mosaicKey}
      direction="vertical"
      onLayout={handleRowHeightsChange}
    >
      <Panel defaultSize={row1Size} minSize={15}>
        {renderRow(rows[0], 0)}
      </Panel>
      <PanelResizeHandle
        className={`h-1 transition-colors ${
          isDragging
            ? "bg-mg-accent shadow-[0_0_8px_var(--color-mg-accent)]"
            : "bg-mg-border hover:bg-mg-accent data-[resize-handle-state=drag]:bg-mg-accent"
        }`}
      />
      <Panel defaultSize={row2Size} minSize={15}>
        {renderRow(rows[1], 1)}
      </Panel>
    </PanelGroup>
  );
});

interface MosaicCellProps {
  member: Session;
  serverHost: string | undefined;
  slotNumber: number;
  totalSlots: number;
  isDragging: boolean;
  isSource: boolean;
  isHoverTarget: boolean;
  fontSize: number;
  canBumpUp: boolean;
  canBumpDown: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent) => void;
  onRemove: () => void;
  onRename: (name: string) => void | Promise<void>;
  onBumpFontUp: () => void;
  onBumpFontDown: () => void;
}

function MosaicCell({
  member,
  serverHost,
  slotNumber,
  totalSlots,
  isDragging,
  isSource,
  isHoverTarget,
  fontSize,
  canBumpUp,
  canBumpDown,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onDrop,
  onRemove,
  onRename,
  onBumpFontUp,
  onBumpFontDown,
}: MosaicCellProps) {
  // Inline-edit state for the session name. We only show the input
  // when the user clicks the pen — the rest of the time the rendered
  // name is the raw `member.sessionName`, so external renames flow
  // through without any sync effect. Draft is only meaningful while
  // editing; it's initialized at edit-start, not from a prop sync.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const beginRename = () => {
    setDraft(member.sessionName);
    setEditing(true);
  };

  const commitRename = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === member.sessionName) return;
    try {
      await onRename(next);
    } catch {
      // Parent handles the toast; nothing else to clean up since the
      // rendered name comes from `member.sessionName`, not `draft`.
    }
  };

  const cancelRename = () => {
    setEditing(false);
  };
  // Flex column layout: the drag/info bar takes its natural height at
  // the top, the terminal fills the remaining space. The decoration
  // border and the big-number drag overlay sit on top as absolute
  // siblings so they don't push the terminal around.
  return (
    <div
      className="relative h-full w-full flex flex-col"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={`absolute inset-0 border transition-all pointer-events-none ${
          isDragging
            ? isHoverTarget
              ? "border-mg-accent-bright shadow-[inset_0_0_18px_rgba(168,85,247,0.45)]"
              : "border-mg-accent/70"
            : "border-transparent"
        }`}
      />

      {/* Bar — flex-shrink-0 so it always takes its natural height. */}
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="flex items-center justify-between gap-2 px-2 h-7 flex-shrink-0 bg-mg-bg-secondary border-b border-mg-border cursor-grab active:cursor-grabbing select-none z-10"
        title="Drag to reorder"
      >
        <div className="flex items-center gap-2 text-xs text-mg-text-secondary min-w-0">
          <span className="font-bold text-mg-accent shrink-0">
            #{slotNumber}
          </span>
          <span className="text-mg-text-tertiary shrink-0">|</span>
          <span className="font-mono text-mg-text truncate" title={serverHost ?? ""}>
            {serverHost ?? "?"}
          </span>
          <span className="text-mg-text-tertiary shrink-0">|</span>
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={cancelRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              maxLength={80}
              className="min-w-0 flex-1 bg-mg-bg-tertiary border border-mg-accent rounded px-1.5 py-0.5 text-xs font-mono text-mg-text focus:outline-none"
            />
          ) : (
            <>
              <span className="font-mono text-mg-text-secondary truncate">
                {member.sessionName}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  beginRename();
                }}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-mg-text-tertiary hover:text-mg-text hover:bg-mg-bg-hover"
                title="Rename this session"
                aria-label="Rename session"
              >
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
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onBumpFontDown();
            }}
            disabled={!canBumpDown}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            className="w-5 h-5 flex items-center justify-center rounded text-mg-text-secondary hover:text-mg-text hover:bg-mg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed text-sm leading-none"
            title={`Decrease font size (${fontSize}pt)`}
          >
            −
          </button>
          <span
            className="text-[10px] text-mg-text-tertiary tabular-nums w-5 text-center"
            title="Current font size"
          >
            {fontSize}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onBumpFontUp();
            }}
            disabled={!canBumpUp}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            className="w-5 h-5 flex items-center justify-center rounded text-mg-text-secondary hover:text-mg-text hover:bg-mg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed text-sm leading-none"
            title={`Increase font size (${fontSize}pt)`}
          >
            +
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            className="w-5 h-5 flex items-center justify-center rounded text-mg-text-tertiary hover:text-mg-danger hover:bg-mg-bg-hover text-xs leading-none ml-1"
            title="Remove from group (shell keeps running)"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Terminal fills the remaining space. The wrapper is the one
          that blurs during a drag (not the bar — the bar needs to stay
          legible so the user can see which slot they're grabbing). */}
      <div
        className={`flex-1 min-h-0 transition-[filter,opacity] duration-150 ${
          isSource ? "blur-[3px] opacity-70" : isDragging ? "blur-[2px]" : ""
        }`}
      >
        <TerminalPane
          key={member.id}
          serverId={member.serverId}
          sessionId={member.id}
          className="h-full"
          fontSize={fontSize}
        />
      </div>

      {/* Big centered slot number — only visible while a drag is active. */}
      {isDragging && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <span
            className={`text-[7rem] font-bold leading-none tabular-nums transition-colors ${
              isHoverTarget
                ? "text-mg-accent-bright drop-shadow-[0_0_18px_var(--color-mg-accent)]"
                : isSource
                  ? "text-mg-accent/40"
                  : "text-mg-accent/70 drop-shadow-[0_0_12px_var(--color-mg-accent)]"
            }`}
            aria-hidden
          >
            {slotNumber}
          </span>
          <span className="sr-only">
            Slot {slotNumber} of {totalSlots}
          </span>
        </div>
      )}
    </div>
  );
}
