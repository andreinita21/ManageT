"use client";

/**
 * GroupHeaderWidgets — the two pieces of UI that live in the group page
 * header: the per-server resource-monitor tiles (which highlight their
 * matching terminal cells on hover) and the row-arrangement picker
 * (which lets the user pick 2+2, 1+3, etc. for the current member
 * count).
 *
 * Both are kept here, rather than in page.tsx, so the group page reads
 * top-to-bottom as "wire data, render layout" instead of "wire data,
 * inline 200 lines of widgets, render layout".
 */
import React, { useMemo, useRef, useState } from "react";

import { useLatestMetrics } from "@/lib/hooks/useApi";
import { useAppearance } from "@/lib/themes/provider";
import { allowedRowPartitions, type Server } from "@/types";

// -- Server resource tiles -------------------------------------------------

interface ServerResourceStripProps {
  /** Unique servers that have at least one member in this group, in the
   *  order they first appear in the member list. */
  servers: Server[];
  /** Set when the user hovers a tile, cleared when they leave. */
  onHover: (serverId: string | null) => void;
}

export function ServerResourceStrip({
  servers,
  onHover,
}: ServerResourceStripProps) {
  // 4s polling is frequent enough that the readouts feel live without
  // flooding the API — same cadence the dashboard ServerCards use.
  const { data: metrics } = useLatestMetrics(4000);
  const appearance = useAppearance();
  const labelMode = appearance.active.groupViewServerLabel;

  if (servers.length === 0) return null;

  return (
    <div
      className="flex items-center gap-2 overflow-x-auto min-w-0"
      role="list"
    >
      {servers.map((s) => (
        <ServerResourceTile
          key={s.id}
          server={s}
          label={labelMode === "name" ? s.name || s.host : s.host}
          metrics={metrics[s.id]}
          onMouseEnter={() => onHover(s.id)}
          onMouseLeave={() => onHover(null)}
        />
      ))}
    </div>
  );
}

interface ServerResourceTileProps {
  server: Server;
  /** Already resolved per the user's `groupViewServerLabel` preference
   *  (host vs. friendly name). */
  label: string;
  metrics:
    | {
        cpuPercent?: number;
        memoryUsedMb?: number;
        memoryTotalMb?: number;
        cpuTempC?: number;
      }
    | undefined;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function ServerResourceTile({
  server,
  label,
  metrics,
  onMouseEnter,
  onMouseLeave,
}: ServerResourceTileProps) {
  const cpu =
    metrics?.cpuPercent != null ? Math.round(metrics.cpuPercent) : null;
  const temp =
    metrics?.cpuTempC != null ? Math.round(metrics.cpuTempC) : null;
  const ramPct =
    metrics?.memoryUsedMb != null && metrics?.memoryTotalMb
      ? Math.round((metrics.memoryUsedMb / metrics.memoryTotalMb) * 100)
      : null;

  return (
    <div
      role="listitem"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="flex flex-col bg-mg-bg-tertiary border border-mg-border rounded-md px-2 py-1 transition-colors hover:border-mg-accent cursor-default shrink-0"
      title={`Hover to highlight terminals on ${server.host}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-mg-text-secondary leading-tight font-mono truncate max-w-[160px]">
        {label}
      </div>
      <div className="flex items-center gap-2 text-[10px] tabular-nums text-mg-text-tertiary leading-tight">
        <MetricReadout
          label="CPU"
          value={cpu != null ? `${cpu}%` : "—"}
          warn={cpu != null && cpu >= 85}
        />
        <span className="text-mg-border">·</span>
        <MetricReadout
          label="°C"
          value={temp != null ? `${temp}` : "—"}
          warn={temp != null && temp >= 80}
        />
        <span className="text-mg-border">·</span>
        <MetricReadout
          label="RAM"
          value={ramPct != null ? `${ramPct}%` : "—"}
          warn={ramPct != null && ramPct >= 90}
        />
      </div>
    </div>
  );
}

function MetricReadout({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn: boolean;
}) {
  return (
    <span className="flex items-center gap-0.5">
      <span className="text-mg-text-tertiary uppercase tracking-wide">
        {label}
      </span>
      <span className={warn ? "text-mg-warning font-medium" : "text-mg-text"}>
        {value}
      </span>
    </span>
  );
}

// -- Layout arrangement picker --------------------------------------------

interface LayoutPickerProps {
  memberCount: number;
  current: number[] | null;
  onPick: (partition: number[]) => void;
}

export function LayoutPicker({
  memberCount,
  current,
  onPick,
}: LayoutPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const options = useMemo(() => allowedRowPartitions(memberCount), [memberCount]);

  // Dismiss on outside-click — we don't bother with focus-trapping
  // because the menu is tiny and contains only buttons.
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  // 1 member has only one possible arrangement, so the picker is
  // pointless — hide it instead of showing a single-item menu.
  if (options.length <= 1) return null;

  const sameAsCurrent = (p: number[]) =>
    current !== null &&
    current.length === p.length &&
    current.every((v, i) => v === p[i]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 h-7 rounded border border-mg-border bg-mg-bg-tertiary text-mg-text-secondary hover:text-mg-text hover:border-mg-accent transition-colors"
        title="Change row arrangement"
        aria-label="Change row arrangement"
        aria-expanded={open}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <rect x="1.5" y="1.5" width="13" height="6" rx="1" />
          <rect x="1.5" y="8.5" width="6" height="6" rx="1" />
          <rect x="8.5" y="8.5" width="6" height="6" rx="1" />
        </svg>
        <span className="text-[11px] font-mono">
          {current ? current.join("+") : "…"}
        </span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-30 bg-mg-bg-secondary border border-mg-border rounded-md shadow-lg p-1 min-w-[140px]">
          {options.map((p) => {
            const active = sameAsCurrent(p);
            return (
              <button
                key={p.join("+")}
                type="button"
                onClick={() => {
                  onPick(p);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs ${
                  active
                    ? "bg-mg-accent/15 text-mg-text"
                    : "text-mg-text-secondary hover:bg-mg-bg-hover hover:text-mg-text"
                }`}
              >
                <PartitionGlyph partition={p} active={active} />
                <span className="font-mono">{p.join(" + ")}</span>
                {active && (
                  <span className="ml-auto text-[10px] text-mg-accent uppercase tracking-wide">
                    Active
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Tiny SVG showing the row partition as proportional rectangles. */
function PartitionGlyph({
  partition,
  active,
}: {
  partition: number[];
  active: boolean;
}) {
  const W = 22;
  const H = 14;
  const rowH = H / partition.length;
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="shrink-0"
      aria-hidden
    >
      {partition.map((cols, rowIdx) => {
        const cellW = W / cols;
        return Array.from({ length: cols }, (_, colIdx) => (
          <rect
            key={`${rowIdx}-${colIdx}`}
            x={colIdx * cellW + 0.5}
            y={rowIdx * rowH + 0.5}
            width={cellW - 1}
            height={rowH - 1}
            rx={1}
            fill={active ? "var(--color-mg-accent)" : "var(--color-mg-border)"}
            stroke={
              active ? "var(--color-mg-accent-bright)" : "var(--color-mg-border-hover)"
            }
            strokeWidth={0.5}
          />
        ));
      })}
    </svg>
  );
}
