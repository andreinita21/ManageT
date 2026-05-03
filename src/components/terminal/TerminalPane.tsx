"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";

interface TerminalPaneProps {
  serverId: string;
  sessionId?: string;
  className?: string;
  /**
   * Called once the backend assigns a session id to this pane (either via
   * `session:create` returning `session:state`, or via a successful
   * `session:attach`). The parent uses this to associate the tab with a
   * persistent session id so it can be restored after a browser reload and
   * killed via `DELETE /api/sessions/:id` when the tab is closed.
   */
  onSessionReady?: (sessionId: string) => void;
}

const XTERM_THEME = {
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

const TerminalPaneInner = ({
  serverId,
  sessionId: initialSessionId,
  className = "",
  onSessionReady,
}: TerminalPaneProps) => {
  // Stable ref to the latest callback so the WS effect doesn't depend on it.
  const onSessionReadyRef = useRef(onSessionReady);
  useEffect(() => {
    onSessionReadyRef.current = onSessionReady;
  }, [onSessionReady]);

  const terminalRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xtermRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<InstanceType<typeof import("xterm-addon-fit").FitAddon> | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [fatalError, setFatalError] = useState<string | null>(null);
  // We keep the session id ONLY in a ref (no state). Storing it in state and
  // referencing it from the main WS effect would either stale-close or cause
  // an infinite teardown/reconnect loop. The xterm input/resize handlers read
  // this ref at call time, so they always see the latest value.
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const mountedRef = useRef(true);

  const getWsUrl = useCallback(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/api/ws`;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!terminalRef.current) return;

    let term: InstanceType<typeof import("xterm").Terminal> | null = null;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const init = async () => {
      // Import xterm modules
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");
      const { WebLinksAddon } = await import("xterm-addon-web-links");

      // Import CSS
      await import("xterm/css/xterm.css");

      if (!mountedRef.current || !terminalRef.current) return;

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;

      term = new Terminal({
        theme: XTERM_THEME,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 14,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 10000,
        allowProposedApi: true,
      });

      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(terminalRef.current);
      xtermRef.current = term;

      // Register input/resize handlers RIGHT HERE, synchronously with term
      // creation. Doing this in a secondary useEffect (keyed on state) created
      // a race where keystrokes could land before the handler was attached.
      term.onData((data: string) => {
        const sessionId = sessionIdRef.current;
        if (wsRef.current?.readyState === WebSocket.OPEN && sessionId) {
          wsRef.current.send(
            JSON.stringify({ type: "terminal:input", sessionId, data })
          );
        }
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        const sessionId = sessionIdRef.current;
        if (wsRef.current?.readyState === WebSocket.OPEN && sessionId) {
          wsRef.current.send(
            JSON.stringify({ type: "terminal:resize", sessionId, cols, rows })
          );
        }
      });

      // Delay fit to ensure container has dimensions
      requestAnimationFrame(() => {
        if (mountedRef.current) {
          fitAddon.fit();
          term?.focus();
        }
      });

      term.writeln("\x1b[1;35m● Connecting to server...\x1b[0m");

      // Connect WebSocket
      connectWs(term);
    };

    const connectWs = (terminal: InstanceType<typeof import("xterm").Terminal>) => {
      const url = getWsUrl();
      ws = new WebSocket(url);
      wsRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setStatus("connected");
        terminal.writeln("\x1b[1;32m● Connected to WebSocket\x1b[0m");

        if (initialSessionId) {
          // Attach to existing session
          ws!.send(JSON.stringify({ type: "session:attach", sessionId: initialSessionId }));
        } else {
          // Create new session
          ws!.send(JSON.stringify({ type: "session:create", serverId }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === "terminal:output" && typeof msg.data === "string") {
            terminal.write(msg.data);
          } else if (msg.type === "session:state" && msg.session) {
            // Only accept the first session:state for this pane. Subsequent
            // ones would mean something's wrong (server is double-sending,
            // or this pane is receiving another pane's event).
            if (sessionIdRef.current) return;
            sessionIdRef.current = msg.session.sessionId;
            terminal.writeln(`\x1b[1;35m● Session ready: ${msg.session.sessionName}\x1b[0m`);
            // Re-fit after session is established
            fitAddonRef.current?.fit();
            terminal.focus();
            onSessionReadyRef.current?.(msg.session.sessionId);
          } else if (msg.type === "session:lost") {
            terminal.writeln(`\x1b[1;31m● Session lost: ${msg.reason}\x1b[0m`);
            setStatus("disconnected");
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setStatus("disconnected");
        // Attempt reconnect after 3s
        reconnectTimer = setTimeout(() => {
          if (mountedRef.current && terminal) {
            terminal.writeln("\x1b[1;33m● Reconnecting...\x1b[0m");
            connectWs(terminal);
          }
        }, 3000);
      };

      ws.onerror = (e) => {
        console.error("[TerminalPane] WebSocket error", e);
        setStatus("disconnected");
      };
    };

    init().catch((err: unknown) => {
      // Without this catch, a failure in any of the dynamic xterm imports
      // becomes a silent unhandled rejection — the user sees a blank pane
      // and no clue what went wrong. Surface it inline so they have
      // something concrete to copy/paste.
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[TerminalPane] init failed:", err);
      setFatalError(`Terminal failed to initialise: ${msg}`);
      setStatus("disconnected");
    });

    // Handle container resize
    const observer = new ResizeObserver(() => {
      if (fitAddonRef.current && mountedRef.current) {
        fitAddonRef.current.fit();
      }
    });
    if (terminalRef.current) {
      observer.observe(terminalRef.current);
    }

    return () => {
      mountedRef.current = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      observer.disconnect();
      ws?.close();
      term?.dispose();
    };
  }, [serverId, getWsUrl, initialSessionId]);

  return (
    <div className={`relative ${className}`} style={{ minHeight: 0 }}>
      <div
        ref={terminalRef}
        className="absolute inset-0"
        style={{ backgroundColor: "#0d0d14", padding: "4px" }}
      />

      {/* Status indicator */}
      {status !== "connected" && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2 bg-mg-bg-secondary/90 border border-mg-border rounded-md px-3 py-1.5">
          {status === "connecting" ? (
            <>
              <div className="w-3 h-3 border-2 border-mg-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-mg-text-secondary">Connecting...</span>
            </>
          ) : (
            <>
              <div className="w-2 h-2 rounded-full bg-red-400" />
              <span className="text-xs text-red-400">Disconnected</span>
            </>
          )}
        </div>
      )}

      {/* Fatal init error overlay — shown when the terminal couldn't even
          set itself up (e.g. dynamic xterm import 404'd in production).
          The xterm output area can't render anything in that state, so put
          the error in a visible div instead. */}
      {fatalError && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6 bg-mg-bg-secondary/95">
          <div className="max-w-md text-center">
            <div className="text-red-400 text-sm font-medium mb-2">Terminal failed to start</div>
            <div className="text-xs text-mg-text-secondary font-mono break-all">{fatalError}</div>
          </div>
        </div>
      )}
    </div>
  );
};

const TerminalPane = dynamic(() => Promise.resolve(TerminalPaneInner), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full flex items-center justify-center" style={{ backgroundColor: "#0d0d14" }}>
      <div className="w-8 h-8 border-2 border-mg-accent border-t-transparent rounded-full animate-spin" />
    </div>
  ),
});

export { TerminalPane };
export type { TerminalPaneProps };
