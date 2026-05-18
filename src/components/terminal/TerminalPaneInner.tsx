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
  const [status, setStatus] = useState<
    "connecting" | "connected" | "reconnecting" | "disconnected" | "error" | "lost"
  >("connecting");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Keep a ref to the latest callback so the main effect doesn't re-run when
  // the parent passes a new lambda.
  const onSessionReadyRef = useRef(onSessionReady);
  useEffect(() => {
    onSessionReadyRef.current = onSessionReady;
  }, [onSessionReady]);

  // Freeze `initialSessionId` at mount. Without this, the create flow
  // tears itself down: we send `session:create`, the server replies with
  // `session:state {sessionId: U}`, we call `onSessionReady(U)`, the
  // parent updates `tab.sessionId = U`, we re-render with `initialSessionId
  // = U`, and the effect's `[serverId, initialSessionId]` dep changes
  // (`undefined → U`) — so React tears down the freshly-working xterm +
  // WebSocket and rebuilds them. The teardown emits a stray
  // `ws.onerror {}` and the rebuilt WS attaches a stream that, for
  // brand-new sessions with empty scrollback, used to leave the user
  // typing into a void. Capturing the prop into state pins the effect
  // to the mount-time value; the parent can keep its own bookkeeping
  // through `onSessionReady` without yanking us around.
  const [mountInitialSessionId] = useState(initialSessionId);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let mounted = true;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let ws: WebSocket | null = null;
    // Mutable session id: starts as the mount-time `initialSessionId` if
    // we're attaching, otherwise null until the server replies with
    // `session:state` to our `session:create`. Reconnect logic reads
    // this same variable, so a session we created earlier in this
    // mount's lifetime is re-attached (not re-created) when the WS
    // drops and we try again.
    let sessionId: string | null = mountInitialSessionId ?? null;
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

      // xterm 5.x has a renderer-init race: Viewport schedules an
      // _innerRefresh via an internal setTimeout(0), and if that
      // callback fires before the render-service's `dimensions` are
      // computed, the `dimensions` getter throws "Cannot read
      // properties of undefined (reading 'dimensions')". Subsequent
      // refreshes succeed once the renderer initializes, but Next.js's
      // dev overlay treats that single throw as a runtime error.
      // Wrap _innerRefresh on the instance to swallow only that
      // specific error type. Internals aren't a public API, so the
      // whole block is best-effort behind a try/catch — if xterm
      // restructures, we just lose the suppression but keep working.
      try {
        const internal = term as unknown as {
          _core?: {
            viewport?: { _innerRefresh?: () => unknown };
            _viewport?: { _innerRefresh?: () => unknown };
          };
        };
        const viewport =
          internal._core?.viewport ?? internal._core?._viewport;
        if (viewport && typeof viewport._innerRefresh === "function") {
          const original = viewport._innerRefresh.bind(viewport);
          viewport._innerRefresh = function patchedInnerRefresh() {
            try {
              return original();
            } catch (err) {
              const msg =
                err instanceof Error ? err.message : String(err);
              if (msg.includes("dimensions")) return;
              throw err;
            }
          };
        }
      } catch {
        /* best-effort patch — silently skip if internals moved */
      }

      // Forward keystrokes + resizes once we have a session id.
      term.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN && sessionId) {
          ws.send(JSON.stringify({ type: "terminal:input", sessionId, data }));
        }
      });
      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN && sessionId) {
          ws.send(
            JSON.stringify({
              type: "terminal:resize",
              sessionId,
              cols,
              rows,
              serverId,
            })
          );
        }
      });

      // Fit after the next paint so the container has real dimensions.
      // Wrapped in try/retry because xterm's Viewport can throw
      // "dimensions undefined" if the renderer hasn't fully initialized
      // — common under Turbopack dev mode with the legacy xterm@5
      // package. Each retry waits one frame before trying again.
      const tryFit = (attemptsLeft: number) => {
        if (!mounted) return;
        try {
          fit?.fit();
          term?.focus();
        } catch (err) {
          if (attemptsLeft > 0) {
            requestAnimationFrame(() => tryFit(attemptsLeft - 1));
          } else {
            console.warn("[TerminalPane] fit gave up after retries:", err);
          }
        }
      };
      requestAnimationFrame(() => tryFit(10));
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
        setStatusDetail(null);
        // No "Connected" line written into the xterm grid — see comment
        // at term.open(). The corner pill handles user-visible state.
        //
        // Use the mutable local `sessionId`, not `mountInitialSessionId`:
        // on a reconnect after a successful `session:create`, sessionId
        // is set to the id the server returned, and we want to attach
        // to that — re-sending `session:create` would orphan the live
        // PTY and spawn a new one on every reconnect.
        if (sessionId) {
          ws?.send(
            JSON.stringify({
              type: "session:attach",
              sessionId,
              serverId,
            })
          );
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
            // Deliberately NOT writing "Session ready" into the xterm
            // grid — it would push the agent's scrollback replay (or a
            // fresh shell's first prompt) down by one line and confuse
            // users who think their history vanished.
            try { fit?.fit(); } catch {}
            term?.focus();
            onSessionReadyRef.current?.(sessionId);
          } else if (msg.type === "session:lost") {
            if (mounted) {
              setStatus("lost");
              setStatusDetail(msg.reason ?? "unknown");
            }
          }
        } catch (err) {
          console.error("[TerminalPane] message parse error:", err);
        }
      };

      ws.onerror = () => {
        // No-op by design. The browser's WebSocket 'error' event carries
        // no diagnostic payload — it stringifies as `{}`, which makes
        // it useless to log and noisy in the Next.js dev overlay. The
        // close event that follows has the real close code/reason and
        // is handled by ws.onclose, which already sets status and
        // schedules a reconnect. The most common source of this event
        // is React StrictMode's mount/unmount/mount cycle in dev: the
        // first mount opens a WebSocket, cleanup immediately aborts it
        // while still CONNECTING, and the browser raises this empty
        // error event. None of it is actionable.
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
            setStatus("reconnecting");
            connect();
          }
        }, 3000);
      };
    };

    connect();

    observer = new ResizeObserver(() => {
      if (mounted && fit) {
        try { fit.fit(); } catch {}
      }
    });
    observer.observe(container);

    return () => {
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      observer?.disconnect();
      ws?.close();
      term?.dispose();
    };
    // We intentionally depend on serverId + the *frozen-at-mount*
    // session id (via useState above). The prop `initialSessionId` is
    // deliberately not in the dep list — the parent updates it after we
    // tell it our newly-created session id via onSessionReady, and we
    // don't want that update to rebuild the WS + xterm we just got
    // working. Reconnects within the same mount reuse the live
    // `sessionId` closure variable; a genuine session swap is handled
    // by the parent giving us a different React key (which remounts us
    // cleanly).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, mountInitialSessionId]);

  return (
    <div className={`relative ${className}`} style={{ minHeight: 0 }}>
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ backgroundColor: "#0d0d14", padding: "4px" }}
      />

      {/* Status pill — only shown when not connected. All transient
          terminal-state messaging lives here so we never write a line
          into the xterm grid that would visually displace the agent's
          scrollback replay. */}
      {status !== "connected" && !errorMessage && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-2 bg-mg-bg-secondary/90 border border-mg-border rounded-md px-3 py-1.5">
          {status === "connecting" || status === "reconnecting" ? (
            <>
              <div className="w-3 h-3 border-2 border-mg-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-mg-text-secondary">
                {status === "reconnecting" ? "Reconnecting..." : "Connecting..."}
              </span>
            </>
          ) : status === "lost" ? (
            <>
              <div className="w-2 h-2 rounded-full bg-yellow-400" />
              <span className="text-xs text-yellow-400">
                Session lost{statusDetail ? `: ${statusDetail}` : ""}
              </span>
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
