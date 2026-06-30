"use client";

/**
 * /stacks/[id]/terminals — multi-pane mosaic of every service's terminal.
 *
 * Opened in a new tab from the per-stack detail row on /stacks. Each
 * service of the stack gets its own xterm pane in a resizable mosaic.
 * Inactive services render a placeholder pane that deep-links back to
 * /stacks for a Launch.
 *
 * Mosaic features (kept in lockstep with the CLI's `managet stack open`,
 * which shares the same persistence):
 *   - arrangement picker (same LayoutPicker as groups) — row partition
 *     persisted per-user via /api/stacks/[id]/layout, the same storage
 *     the CLI's Ctrl-A V writes;
 *   - drag a pane's title bar onto another pane to swap them — persisted
 *     as service order via /api/stacks/[id]/order (CLI: Ctrl-A S);
 *   - divider drags persist row/column sizes (CLI: Ctrl-A R).
 *
 * The page polls the runtime endpoint so the panes refresh from "(not
 * running)" → live-attached automatically when you Launch the stack on
 * the other tab.
 */
import React, { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import {
  getStackLayout,
  reorderStack,
  saveStackLayout,
  useServers,
  useStack,
  useStackRuntimes,
} from "@/lib/hooks/useApi";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { LayoutPicker } from "../../../groups/[id]/GroupHeaderWidgets";
import { StackDebugger, type DebuggerColumn } from "./StackDebugger";
import type {
  GroupLayout,
  Server,
  StackService,
  StackServiceRuntime,
} from "@/types";

const LAYOUT_DEBOUNCE_MS = 350;

/** How often this page refetches stack runtime. Faster than the default so a
 *  stack you stop elsewhere flips its panes to "not running" promptly. */
const RUNTIME_POLL_MS = 4000;
/** How long a service must stay inactive before a pinned (sticky) terminal
 *  pane is dropped. Must exceed one `RUNTIME_POLL_MS` so a single transient
 *  inactive poll (respawn gap / blip) can't close a live pane. */
const PIN_CLEAR_MS = 6000;

/** Stacks default to one row of everything — that's what the page always
 *  rendered before the arrangement picker existed, so saved-layout-less
 *  stacks keep their look. */
function defaultPartitionForCount(n: number): number[] {
  return n <= 0 ? [] : [n];
}

function layoutForPartition(partition: number[]): GroupLayout {
  if (partition.length === 0) {
    return { rowHeights: [1], colWidthsByRow: [[]], rowPartition: [] };
  }
  const rowHeights = Array.from(
    { length: partition.length },
    () => 1 / partition.length
  );
  const colWidthsByRow = partition.map((cols) =>
    Array.from({ length: cols }, () => 1 / cols)
  );
  return { rowHeights, colWidthsByRow, rowPartition: [...partition] };
}

/** Slice the ordered services into visual rows per the partition; fall
 *  back to a single row when the partition doesn't match. */
function partitionRows<T>(items: T[], partition: number[]): T[][] {
  if (
    partition.length > 0 &&
    partition.reduce((a, b) => a + b, 0) === items.length
  ) {
    const rows: T[][] = [];
    let i = 0;
    for (const n of partition) {
      rows.push(items.slice(i, i + n));
      i += n;
    }
    return rows;
  }
  return [items];
}

export default function StackTerminalsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // App Router passes params as a Promise on dynamic routes; `use()`
  // unwraps it on the client without making the whole component async.
  const { id: stackId } = use(params);
  const {
    data: stack,
    loading: loadingStack,
    error: stackError,
    refetch: refetchStack,
  } = useStack(stackId);
  const { data: servers } = useServers();
  const { data: runtimeMap } = useStackRuntimes(RUNTIME_POLL_MS);

  const serversById = useMemo(() => {
    const m = new Map<string, Server>();
    (servers ?? []).forEach((s) => m.set(s.id, s));
    return m;
  }, [servers]);

  const runtime = runtimeMap[stackId];
  const runtimeByService = useMemo(() => {
    const m = new Map<string, StackServiceRuntime>();
    (runtime?.services ?? []).forEach((r) => m.set(r.serviceId, r));
    return m;
  }, [runtime]);

  const services = useMemo(
    () =>
      [...(stack?.services ?? [])].sort((a, b) => a.orderIndex - b.orderIndex),
    [stack?.services]
  );
  const serviceCount = services.length;

  // ---- Debugger view (time-aligned log table) toggle ----
  const [debugMode, setDebugMode] = useState(false);
  const debuggerColumns = useMemo<DebuggerColumn[]>(
    () =>
      services.map((svc) => {
        const rt = runtimeByService.get(svc.id);
        return {
          serviceId: svc.id,
          name: svc.name,
          serverId: svc.serverId,
          serverName:
            serversById.get(svc.serverId)?.name ?? svc.serverId.slice(0, 6),
          sessionId:
            rt?.status === "active" ? rt.sessionId ?? null : null,
        };
      }),
    [services, runtimeByService, serversById]
  );

  // ---- Persisted layout (same storage the CLI's Ctrl-A R/V writes) ----
  const [layoutState, setLayoutState] = useState<{
    stackId: string;
    layout: GroupLayout;
  } | null>(null);

  useEffect(() => {
    if (serviceCount === 0) return;
    let cancelled = false;
    (async () => {
      let saved: GroupLayout | null = null;
      try {
        saved = await getStackLayout(stackId);
      } catch {
        saved = null;
      }
      if (cancelled) return;
      const savedPartition = saved?.rowPartition;
      const shapeOk =
        !!saved &&
        !!savedPartition &&
        savedPartition.length > 0 &&
        savedPartition.length <= 2 &&
        savedPartition.reduce((a, b) => a + b, 0) === serviceCount &&
        saved.rowHeights.length === savedPartition.length &&
        saved.colWidthsByRow.length === savedPartition.length &&
        saved.colWidthsByRow.every((r, i) => r.length === savedPartition[i]);
      const layout = shapeOk
        ? (saved as GroupLayout)
        : layoutForPartition(defaultPartitionForCount(serviceCount));
      setLayoutState({ stackId, layout });
    })();
    return () => {
      cancelled = true;
    };
  }, [stackId, serviceCount]);

  const layout =
    layoutState && layoutState.stackId === stackId ? layoutState.layout : null;

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistLayout = useCallback(
    (next: GroupLayout) => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        saveStackLayout(stackId, next).catch((err) => {
          console.warn("[stacks] save layout failed:", err);
        });
      }, LAYOUT_DEBOUNCE_MS);
    },
    [stackId]
  );
  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, []);

  const setLayout = useCallback(
    (updater: (prev: GroupLayout) => GroupLayout) => {
      setLayoutState((prev) => {
        if (!prev || prev.stackId !== stackId) return prev;
        return { stackId, layout: updater(prev.layout) };
      });
    },
    [stackId]
  );

  const handleRowHeightsChange = (sizes: number[]) => {
    setLayout((prev) => {
      const next: GroupLayout = {
        ...prev,
        rowHeights: sizes.map((p) => p / 100),
      };
      persistLayout(next);
      return next;
    });
  };
  const handleRowColsChange = (rowIdx: number) => (sizes: number[]) => {
    setLayout((prev) => {
      const next: GroupLayout = {
        ...prev,
        colWidthsByRow: prev.colWidthsByRow.map((row, i) =>
          i === rowIdx ? sizes.map((p) => p / 100) : row
        ),
      };
      persistLayout(next);
      return next;
    });
  };

  const activePartition = useMemo<number[] | null>(() => {
    if (!layout) return null;
    if (layout.rowPartition && layout.rowPartition.length > 0) {
      return layout.rowPartition;
    }
    return defaultPartitionForCount(serviceCount);
  }, [layout, serviceCount]);

  const pickPartition = (partition: number[]) => {
    if (
      partition.length === 0 ||
      partition.length > 2 ||
      partition.reduce((a, b) => a + b, 0) !== serviceCount
    ) {
      return;
    }
    setLayout(() => {
      const next = layoutForPartition(partition);
      persistLayout(next);
      return next;
    });
  };

  // ---- Drag-to-swap (mirrors GroupMosaic, keyed by service id) ----
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const isDragging = dragId !== null;

  const handleDrop = async (targetId: string) => {
    const sourceId = dragId;
    setDragId(null);
    setHoverId(null);
    if (!sourceId || sourceId === targetId) return;
    const ids = services.map((s) => s.id);
    const a = ids.indexOf(sourceId);
    const b = ids.indexOf(targetId);
    if (a < 0 || b < 0) return;
    [ids[a], ids[b]] = [ids[b], ids[a]];
    try {
      await reorderStack(stackId, ids);
      refetchStack();
    } catch (err) {
      console.warn("[stacks] reorder failed:", err);
    }
  };

  if (loadingStack) {
    return (
      <div className="flex items-center justify-center h-full text-mg-text-tertiary text-sm">
        Loading stack…
      </div>
    );
  }
  if (stackError || !stack) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-sm">
        <p className="text-mg-text">Couldn&apos;t load stack.</p>
        <p className="text-mg-text-tertiary">{stackError ?? "Not found."}</p>
        <Link href="/stacks" className="text-mg-accent hover:underline">
          ← Back to stacks
        </Link>
      </div>
    );
  }

  const partition =
    activePartition ?? defaultPartitionForCount(serviceCount);
  const rows = partitionRows(services, partition);
  const mosaicKey = `${partition.join(",")}::${services
    .map((s) => s.id)
    .join("|")}`;

  const renderPanel = (svc: StackService) => (
    <TerminalPanel
      svc={svc}
      runtime={runtimeByService.get(svc.id)}
      server={serversById.get(svc.serverId)}
      isDragging={isDragging}
      isSource={dragId === svc.id}
      isHoverTarget={hoverId === svc.id && dragId !== svc.id}
      onDragStart={(e) => {
        setDragId(svc.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", svc.id);
      }}
      onDragOver={(e) => {
        if (!dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (hoverId !== svc.id) setHoverId(svc.id);
      }}
      onDragLeave={() => {
        if (hoverId === svc.id) setHoverId(null);
      }}
      onDragEnd={() => {
        setDragId(null);
        setHoverId(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        void handleDrop(svc.id);
      }}
    />
  );

  const renderRow = (rowItems: StackService[], rowIdx: number) => (
    <PanelGroup direction="horizontal" onLayout={handleRowColsChange(rowIdx)}>
      {rowItems.map((svc, colIdx) => {
        const colSize =
          (layout?.colWidthsByRow[rowIdx]?.[colIdx] ?? 1 / rowItems.length) *
          100;
        return (
          <React.Fragment key={svc.id}>
            {colIdx > 0 && (
              <PanelResizeHandle className="w-1.5 bg-mg-border hover:bg-mg-accent transition-colors data-[resize-handle-state=drag]:bg-mg-accent" />
            )}
            <Panel defaultSize={colSize} minSize={10}>
              {renderPanel(svc)}
            </Panel>
          </React.Fragment>
        );
      })}
    </PanelGroup>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header strip */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-mg-border bg-mg-bg-secondary flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            href="/stacks"
            className="text-mg-text-tertiary hover:text-mg-text text-sm transition-colors"
          >
            ← Stacks
          </Link>
          <span className="text-mg-text-tertiary">/</span>
          <span className="text-sm text-mg-text font-medium truncate">
            {stack.name}
          </span>
          <span className="text-xs text-mg-text-tertiary ml-2">
            {runtime
              ? `${runtime.activeCount}/${runtime.totalCount} running`
              : ""}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {!debugMode && (
            <p className="text-xs text-mg-text-tertiary hidden md:block">
              Drag a title bar onto another pane to swap • dividers resize
            </p>
          )}
          <button
            type="button"
            onClick={() => setDebugMode((v) => !v)}
            title="Toggle the time-aligned log table (server timestamps, one column per service)"
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              debugMode
                ? "border-mg-accent text-mg-accent bg-mg-accent/10"
                : "border-mg-border text-mg-text-tertiary hover:text-mg-text hover:border-mg-text-tertiary"
            }`}
          >
            Debugger
          </button>
          {!debugMode && (
            <LayoutPicker
              memberCount={serviceCount}
              current={activePartition}
              onPick={pickPartition}
            />
          )}
        </div>
      </div>

      {/* Mosaic — or, in debugger mode, the time-aligned log table. */}
      <div className="flex-1 min-h-0">
        {serviceCount === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-mg-text-tertiary">
            This stack has no services.
          </div>
        ) : debugMode ? (
          <StackDebugger columns={debuggerColumns} />
        ) : !layout ? (
          <div className="flex items-center justify-center h-full text-sm text-mg-text-tertiary">
            Restoring layout…
          </div>
        ) : rows.length === 1 ? (
          <div className="h-full" key={mosaicKey}>
            {renderRow(rows[0], 0)}
          </div>
        ) : (
          <PanelGroup
            key={mosaicKey}
            direction="vertical"
            onLayout={handleRowHeightsChange}
          >
            <Panel defaultSize={(layout.rowHeights[0] ?? 0.5) * 100} minSize={15}>
              {renderRow(rows[0], 0)}
            </Panel>
            <PanelResizeHandle className="h-1.5 bg-mg-border hover:bg-mg-accent transition-colors data-[resize-handle-state=drag]:bg-mg-accent" />
            <Panel defaultSize={(layout.rowHeights[1] ?? 0.5) * 100} minSize={15}>
              {renderRow(rows[1], 1)}
            </Panel>
          </PanelGroup>
        )}
      </div>
    </div>
  );
}

function TerminalPanel({
  svc,
  runtime,
  server,
  isDragging,
  isSource,
  isHoverTarget,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onDrop,
}: {
  svc: StackService;
  runtime: StackServiceRuntime | undefined;
  server: Server | undefined;
  isDragging: boolean;
  isSource: boolean;
  isHoverTarget: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDragEnd: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const isActive = runtime?.status === "active" && runtime.sessionId !== null;

  // Sticky session id: once we've seen a live sessionId for this service,
  // keep the TerminalPane mounted on that id even if the next runtime poll
  // briefly shows "inactive" (network blip, agent heartbeat lag, or the
  // short gap while a session respawns). The agent keeps the PTY +
  // scrollback alive across those, so an unnecessary unmount throws away
  // the in-xterm scrollback and forces a re-attach (blink). We swap the
  // pin when runtime hands us a genuinely different sessionId (respawn).
  //
  // BUT a *stopped* stack is a permanent inactive, not a blip — leaving the
  // dead terminal pinned forever is wrong. So when the service stays
  // inactive past a short window (longer than one runtime poll, so a single
  // transient inactive can't trip it), drop the pin and let the pane fall
  // back to the "not running" placeholder. State (not a ref) because the
  // value feeds the render below.
  const [pinnedSessionId, setPinnedSessionId] = useState<string | null>(null);
  const clearPinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (runtime?.sessionId) {
      if (clearPinTimer.current) {
        clearTimeout(clearPinTimer.current);
        clearPinTimer.current = null;
      }
      // setState bails out when the value is unchanged, so this only
      // re-renders on a genuine session swap.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPinnedSessionId(runtime.sessionId);
    } else if (
      runtime?.status === "inactive" &&
      pinnedSessionId &&
      !clearPinTimer.current
    ) {
      clearPinTimer.current = setTimeout(() => {
        clearPinTimer.current = null;
        setPinnedSessionId(null);
      }, PIN_CLEAR_MS);
    }
  }, [runtime?.sessionId, runtime?.status, pinnedSessionId]);
  useEffect(
    () => () => {
      if (clearPinTimer.current) clearTimeout(clearPinTimer.current);
    },
    []
  );
  const effectiveSessionId = runtime?.sessionId ?? pinnedSessionId;
  const showTerminal = effectiveSessionId !== null;

  return (
    <div
      className={`h-full flex flex-col bg-[#0d0d14] relative ${
        isHoverTarget ? "ring-1 ring-inset ring-mg-accent" : ""
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title="Drag onto another pane to swap"
        className="flex items-center justify-between px-3 py-1.5 border-b border-mg-border bg-mg-bg-secondary flex-shrink-0 text-xs cursor-grab active:cursor-grabbing select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
              isActive ? "bg-mg-success" : "bg-mg-text-tertiary/60"
            }`}
          />
          <span className="font-mono text-mg-text truncate">{svc.name}</span>
          <span className="text-mg-text-tertiary truncate">
            ({server?.name ?? svc.serverId.slice(0, 6)})
          </span>
        </div>
        {isActive && runtime?.cpuPercent != null && (
          <div className="flex items-center gap-3 font-mono text-mg-text-tertiary flex-shrink-0">
            <span>{runtime.cpuPercent.toFixed(1)}%</span>
            <span>{runtime.memoryMb ?? "—"} MB</span>
          </div>
        )}
      </div>
      <div
        className={`flex-1 min-h-0 transition-[filter,opacity] duration-150 ${
          isSource ? "blur-[3px] opacity-70" : isDragging ? "blur-[2px]" : ""
        }`}
      >
        {showTerminal && effectiveSessionId ? (
          <TerminalPane
            key={effectiveSessionId}
            serverId={svc.serverId}
            sessionId={effectiveSessionId}
            className="h-full"
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-xs text-mg-text-tertiary p-4 text-center">
            <p>Service not running.</p>
            <Link
              href="/stacks"
              target="_blank"
              rel="noopener noreferrer"
              className="text-mg-accent hover:underline"
            >
              Launch from /stacks
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
