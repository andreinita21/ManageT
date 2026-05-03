"use client";

/**
 * TerminalPane — xterm.js view bound to a single PTY session over /api/ws.
 *
 * Why static imports (not `await import("xterm")` like the previous version):
 * xterm 5.3.0 is a CommonJS-only package (its package.json has no "module"
 * or "exports" field). In Next.js production builds, dynamic `await import()`
 * of a CJS package resolves to `{ default: { Terminal, ... } }` and the
 * destructure `const { Terminal } = await import("xterm")` makes Terminal
 * undefined. `new Terminal(...)` then throws "Terminal is not a constructor"
 * — the throw becomes an unhandled rejection from the async init function,
 * the React component never mounts, and the user sees nothing happen. Dev
 * mode's CJS↔ESM interop hides this, which is why the bug was invisible
 * during local development. Static imports go through the bundler's regular
 * import-of-CJS path which always exposes the named exports correctly.
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import "xterm/css/xterm.css";

interface TerminalPaneProps {
  serverId: string;
  /** If provided, the pane attaches to this existing session id instead of creating a new one. */
  sessionId?: string;
  className?: string;
  /** Called once with the backend's session id after `session:create` returns or `session:attach` succeeds. */
  onSessionReady?: (sessionId: string) => void;
}

const THEME = {
  background: "#0d0d14",
  foreground: "#e4e4e7",
  cursor: "#a855f7",
  cursorAccent: "#0d0d14",
  selectionBackground: "rgba(168, 85, 247, 0.3)",
  black: "#27272a",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#ffffff",
};

export default function TerminalPaneInner({
  serverId,
  sessionId: initialSessionId,
  className = "",
  onSessionReady,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">(
    "connecting"
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Keep a ref to the latest callback so the main effect doesn't re-run when
  // the parent passes a new lambda.
  const onSessionReadyRef = useRef(onSessionReady);
  useEffect(() => {
    onSessionReadyRef.current = onSessionReady;
  }, [onSessionReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let mounted = true;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let ws: WebSocket | null = null;
    // Mutable session id: starts as `initialSessionId` if attaching, otherwise
    // null until the server replies with `session:state` to our `session:create`.
    let sessionId: string | null = initialSessionId ?? null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;

    try {
      term = new Terminal({
        theme: THEME,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 14,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 10000,
        allowProposedApi: true,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(container);
      term.writeln("\x1b[1;35m● Connecting to server...\x1b[0m");

      // Forward keystrokes + resizes once we have a session id.
      term.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN && sessionId) {
          ws.send(JSON.stringify({ type: "terminal:input", sessionId, data }));
        }
      });
      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN && sessionId) {
          ws.send(JSON.stringify({ type: "terminal:resize", sessionId, cols, rows }));
        }
      });

      // Fit after the next paint so the container has real dimensions.
      requestAnimationFrame(() => {
        if (mounted) {
          fit?.fit();
          term?.focus();
        }
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error("[TerminalPane] xterm init failed:", err);
      setErrorMessage(`xterm init failed: ${m}`);
      setStatus("error");
      return;
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/api/ws`;

    const connect = () => {
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error("[TerminalPane] WebSocket constructor threw:", err);
        setErrorMessage(`WebSocket failed: ${m}`);
        setStatus("error");
        return;
      }

      ws.onopen = () => {
        if (!mounted) return;
        setStatus("connected");
        term?.writeln("\x1b[1;32m● Connected\x1b[0m");
        if (initialSessionId) {
          ws?.send(JSON.stringify({ type: "session:attach", sessionId: initialSessionId }));
        } else {
          ws?.send(JSON.stringify({ type: "session:create", serverId }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.type === "terminal:output" && typeof msg.data === "string") {
            term?.write(msg.data);
          } else if (msg.type === "session:state" && msg.session) {
            // Only accept the first session:state — repeats indicate a
            // double-subscribe that would cross-route input to the wrong PTY.
            if (sessionId) return;
            sessionId = msg.session.sessionId as string;
            term?.writeln(`\x1b[1;35m● Session ready: ${msg.session.sessionName}\x1b[0m`);
            fit?.fit();
            term?.focus();
            onSessionReadyRef.current?.(sessionId);
          } else if (msg.type === "session:lost") {
            term?.writeln(`\x1b[1;31m● Session lost: ${msg.reason ?? "unknown"}\x1b[0m`);
            if (mounted) setStatus("disconnected");
          }
        } catch (err) {
          console.error("[TerminalPane] message parse error:", err);
        }
      };

      ws.onerror = (e) => {
        console.error("[TerminalPane] WebSocket error", e);
        if (mounted) setStatus("error");
      };

      ws.onclose = () => {
        if (!mounted) return;
        setStatus("disconnected");
        // Try to reconnect once after 3s. We don't loop forever — if the
        // server is genuinely gone the user should see "Disconnected" and
        // close the tab. The session manager keeps the PTY alive across the
        // brief reconnect, so re-attaching by sessionId picks up where we
        // left off.
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (mounted) {
            term?.writeln("\x1b[1;33m● Reconnecting...\x1b[0m");
            connect();
          }
        }, 3000);
      };
    };

    connect();

    observer = new ResizeObserver(() => {
      if (mounted && fit) fit.fit();
    });
    observer.observe(container);

    return () => {
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      observer?.disconnect();
      ws?.close();
      term?.dispose();
    };
    // We intentionally only depend on serverId + initialSessionId. The
    // onSessionReady callback is read through a ref so the parent can pass
    // a fresh lambda each render without tearing the WS down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, initialSessionId]);

  return (
    <div className={`relative ${className}`} style={{ minHeight: 0 }}>
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ backgroundColor: "#0d0d14", padding: "4px" }}
      />

      {/* Status pill — only shown when not connected. */}
      {status !== "connected" && !errorMessage && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2 bg-mg-bg-secondary/90 border border-mg-border rounded-md px-3 py-1.5">
          {status === "connecting" ? (
            <>
              <div className="w-3 h-3 border-2 border-mg-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-mg-text-secondary">Connecting...</span>
            </>
          ) : (
            <>
              <div className="w-2 h-2 rounded-full bg-red-400" />
              <span className="text-xs text-red-400">
                {status === "error" ? "Error" : "Disconnected"}
              </span>
            </>
          )}
        </div>
      )}

      {/* Fatal-error overlay when the terminal couldn't even initialise. */}
      {errorMessage && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6 bg-mg-bg-secondary/95">
          <div className="max-w-md text-center">
            <div className="text-red-400 text-sm font-medium mb-2">Terminal failed</div>
            <div className="text-xs text-mg-text-secondary font-mono break-all">
              {errorMessage}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export type { TerminalPaneProps };
