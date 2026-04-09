"use client";

import React, { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

interface TerminalPaneProps {
  sessionId: string | null;
  wsUrl: string;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  className?: string;
}

const TerminalPaneInner = ({ sessionId, wsUrl, onData, onResize, className = "" }: TerminalPaneProps) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<InstanceType<typeof import("xterm").Terminal> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<InstanceType<typeof import("xterm-addon-fit").FitAddon> | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!terminalRef.current) return;

    let mounted = true;

    const init = async () => {
      const { Terminal } = await import("xterm");
      const { FitAddon } = await import("xterm-addon-fit");
      const { WebLinksAddon } = await import("xterm-addon-web-links");

      if (!mounted || !terminalRef.current) return;

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;

      const term = new Terminal({
        theme: {
          background: "#0a0a0f",
          foreground: "#e4e4e7",
          cursor: "#a855f7",
          cursorAccent: "#0a0a0f",
          selectionBackground: "#a855f740",
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
        },
        fontFamily: "var(--font-jetbrains), 'Fira Code', monospace",
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
      fitAddon.fit();
      xtermRef.current = term;

      term.onData((data) => {
        onData?.(data);
        if (wsRef.current?.readyState === WebSocket.OPEN && sessionId) {
          wsRef.current.send(
            JSON.stringify({ type: "terminal:input", sessionId, data })
          );
        }
      });

      term.onResize(({ cols, rows }) => {
        onResize?.(cols, rows);
        if (wsRef.current?.readyState === WebSocket.OPEN && sessionId) {
          wsRef.current.send(
            JSON.stringify({ type: "terminal:resize", sessionId, cols, rows })
          );
        }
      });

      // Handle window resize
      const handleResize = () => fitAddon.fit();
      window.addEventListener("resize", handleResize);

      // Connect WebSocket
      if (sessionId) {
        connectWs(term);
      }

      return () => {
        window.removeEventListener("resize", handleResize);
      };
    };

    const connectWs = (term: InstanceType<typeof import("xterm").Terminal>) => {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setDisconnected(false);
        setReconnecting(false);
        if (sessionId) {
          ws.send(JSON.stringify({ type: "session:attach", sessionId }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as Record<string, unknown>;
          if (msg.type === "terminal:output" && typeof msg.data === "string") {
            term.write(msg.data);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        setDisconnected(true);
        // Attempt reconnect after 3s
        if (mounted) {
          setReconnecting(true);
          setTimeout(() => {
            if (mounted) connectWs(term);
          }, 3000);
        }
      };

      ws.onerror = () => {
        setDisconnected(true);
      };
    };

    const cleanup = init();

    return () => {
      mounted = false;
      cleanup?.then((fn) => fn?.());
      wsRef.current?.close();
      xtermRef.current?.dispose();
    };
  }, [sessionId, wsUrl, onData, onResize]);

  // Refit on container size changes
  useEffect(() => {
    if (!terminalRef.current) return;
    const observer = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    observer.observe(terminalRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={`relative h-full ${className}`}>
      <div ref={terminalRef} className="h-full w-full" />

      {/* Import xterm CSS */}
      <style>{`@import 'xterm/css/xterm.css';`}</style>

      {/* Reconnect overlay */}
      {disconnected && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-10">
          <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-6 text-center shadow-glow">
            {reconnecting ? (
              <>
                <div className="w-8 h-8 border-2 border-mg-accent border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-sm text-mg-text">Reconnecting...</p>
              </>
            ) : (
              <>
                <p className="text-sm text-red-400 mb-3">Connection lost</p>
                <button
                  onClick={() => {
                    setReconnecting(true);
                    wsRef.current?.close();
                    // Trigger reconnect through effect
                  }}
                  className="bg-mg-accent text-white hover:bg-mg-accent-bright px-4 py-2 rounded-lg text-sm transition-all duration-200"
                >
                  Reconnect
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const TerminalPane = dynamic(() => Promise.resolve(TerminalPaneInner), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full bg-mg-bg flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-mg-accent border-t-transparent rounded-full animate-spin" />
    </div>
  ),
});

export { TerminalPane };
export type { TerminalPaneProps };
