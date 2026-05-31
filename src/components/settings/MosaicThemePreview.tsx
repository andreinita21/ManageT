"use client";

/**
 * Static HTML/monospace mock of the CLI group/stack mosaic for a given
 * MosaicTheme — mirrors what `draw_pane` / `draw_*_status_bar` render in
 * agent/src/cli_dashboard.rs. Two panes (focused + unfocused) drawn with the
 * theme's border glyphs and role colors, a status-bar line, a status-dot
 * legend, and a "selected row" chip. Colors via tokenToCss so named tokens
 * approximate and hex renders exactly.
 */
import React from "react";

import {
  resolveBorders,
  tokenToCss,
  type MosaicTheme,
} from "@/lib/mosaic-themes/presets";

interface Seg {
  t: string;
  c: string;
  b?: boolean;
}

function visLen(segs: Seg[]): number {
  return segs.reduce((n, s) => n + s.t.length, 0);
}

/** Wrap inner content segments with left/right border glyphs and pad to width. */
function contentRow(inner: Seg[], innerW: number, borderColor: string, v: string): Seg[] {
  const pad = Math.max(0, innerW - visLen(inner));
  return [
    { t: v, c: borderColor },
    ...inner,
    ...(pad > 0 ? [{ t: " ".repeat(pad), c: borderColor }] : []),
    { t: v, c: borderColor },
  ];
}

function Row({ segs }: { segs: Seg[] }) {
  return (
    <div style={{ whiteSpace: "pre" }}>
      {segs.map((s, i) => (
        <span key={i} style={{ color: s.c, fontWeight: s.b ? 700 : 400 }}>
          {s.t}
        </span>
      ))}
    </div>
  );
}

function pane(theme: MosaicTheme, focused: boolean, innerW: number): Seg[][] {
  const c = theme.colors;
  const g = resolveBorders(theme);
  const border = focused ? c.borderActive : c.borderInactive;
  const title = focused ? c.titleActive : c.titleInactive;
  const bc = tokenToCss(border);
  const tc = tokenToCss(title);
  const top: Seg[] = [{ t: g.tl + g.h.repeat(innerW) + g.tr, c: bc }];
  const bottom: Seg[] = [{ t: g.bl + g.h.repeat(innerW) + g.br, c: bc }];
  const titleRow = contentRow(
    [
      { t: focused ? " ● " : " ○ ", c: bc },
      { t: focused ? "web" : "api", c: tc, b: true },
      { t: " @pi", c: tokenToCss(c.serverLabel) },
    ],
    innerW,
    bc,
    g.v
  );
  const bodyRow = contentRow(
    [{ t: " $ npm run dev", c: tokenToCss(c.name) }],
    innerW,
    bc,
    g.v
  );
  const statusRow = contentRow(
    [
      { t: " ● ", c: tokenToCss(focused ? c.statusRunning : c.statusIdle) },
      { t: focused ? "running" : "idle", c: tokenToCss(c.hint) },
    ],
    innerW,
    bc,
    g.v
  );
  return [top, titleRow, bodyRow, statusRow, bottom];
}

export function MosaicThemePreview({
  theme,
  className = "",
}: {
  theme: MosaicTheme;
  className?: string;
}) {
  const c = theme.colors;
  const innerW = 13;
  const left = pane(theme, true, innerW);
  const right = pane(theme, false, innerW);

  // Status bar (top): heading · name · separator · info · hint.
  const statusBar: Seg[] = [
    { t: "managet group:", c: tokenToCss(c.heading), b: true },
    { t: " demo", c: tokenToCss(c.name), b: true },
    { t: "  │  ", c: tokenToCss(c.separator) },
    { t: "1/2 running", c: tokenToCss(c.info) },
    { t: "  │  ", c: tokenToCss(c.separator) },
    { t: "^A D detach", c: tokenToCss(c.hint) },
  ];

  return (
    <div
      className={`rounded-md border border-mg-border overflow-hidden ${className}`}
      style={{ background: "#0d0d14" }}
    >
      <div className="p-2 font-mono text-[10px] leading-[1.35]">
        <Row segs={statusBar} />
        <div className="h-1" />
        {/* Two independent monospace columns — each pane owns its own rows so
            cross-pane alignment can't drift. */}
        <div className="flex gap-2">
          <div>
            {left.map((segs, i) => (
              <Row key={i} segs={segs} />
            ))}
          </div>
          <div>
            {right.map((segs, i) => (
              <Row key={i} segs={segs} />
            ))}
          </div>
        </div>
        <div className="h-1" />
        {/* Status-dot legend + selected chip exercising the remaining roles. */}
        <div className="flex items-center gap-2" style={{ whiteSpace: "pre" }}>
          {([
            ["running", c.statusRunning],
            ["idle", c.statusIdle],
            ["closed", c.statusClosed],
            ["?", c.statusUnknown],
          ] as [string, string][]).map(([label, col]) => (
            <span key={label} style={{ color: tokenToCss(col) }}>
              ●{label}
            </span>
          ))}
          <span
            className="px-1 rounded-sm"
            style={{
              color: tokenToCss(c.selectedFg),
              background: tokenToCss(c.selectedBg),
            }}
          >
            sel
          </span>
          <span style={{ color: tokenToCss(c.danger) }}>●kill</span>
          <span style={{ color: tokenToCss(c.warning) }}>●warn</span>
        </div>
      </div>
    </div>
  );
}
