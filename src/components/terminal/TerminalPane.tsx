"use client";

/**
 * Public wrapper around the xterm-using TerminalPaneInner.
 *
 * The wrapper exists for one reason: xterm 5 references `self` (a browser
 * global) when its module is evaluated. Importing it during Next.js's
 * server prerender pass would crash the build with `ReferenceError: self
 * is not defined`. `dynamic(() => import("./TerminalPaneInner"), { ssr: false })`
 * splits the inner component into its own client-only chunk so xterm is
 * only ever evaluated in a browser context.
 */
import dynamic from "next/dynamic";
import type { TerminalPaneHandle, TerminalPaneProps } from "./TerminalPaneInner";

export const TerminalPane = dynamic(() => import("./TerminalPaneInner"), {
  ssr: false,
  loading: () => (
    <div
      className="h-full w-full flex items-center justify-center"
      style={{ backgroundColor: "#0d0d14" }}
    >
      <div className="w-8 h-8 border-2 border-mg-accent border-t-transparent rounded-full animate-spin" />
    </div>
  ),
});

export type { TerminalPaneHandle, TerminalPaneProps };
