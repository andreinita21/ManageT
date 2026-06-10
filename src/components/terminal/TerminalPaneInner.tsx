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
import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import "xterm/css/xterm.css";
import { useAppearance } from "@/lib/themes/provider";

interface TerminalPaneProps {
  serverId: string;
  /** If provided, the pane attaches to this existing session id instead of creating a new one. */
  sessionId?: string;
  className?: string;
  /** Called once with the backend's session id after `session:create` returns or `session:attach` succeeds. */
  onSessionReady?: (sessionId: string) => void;
  /** Override the global appearance font size for just this pane. Used
   *  by the group mosaic to expose per-pane +/- controls so a single
   *  cramped pane in a 6-up layout can be bumped up without changing
   *  the user's global preference. */
  fontSize?: number;
  /** Called with this pane's "send image" function once the terminal is
   *  mounted (and with null on unmount). The function uploads the image
   *  to the session's host and pastes the resulting remote path into the
   *  PTY — which is how Claude Code & friends pick it up as an attached
   *  image. Parents use it to drive a toolbar/menu-bar button; the pane
   *  itself also accepts Ctrl+V image paste and drag-and-drop directly. */
  onSendImageReady?: (send: ((file: File) => void) | null) => void;
}

export default function TerminalPaneInner({
  serverId,
  sessionId: initialSessionId,
  className = "",
  onSessionReady,
  fontSize,
  onSendImageReady,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Appearance (theme + font) is shared via context so user preference
  // changes in Settings propagate live. Read from `active`, which is
  // the in-effect preview when the Appearance editor is open and the
  // persisted prefs otherwise — that's what lets the picker reskin
  // the running terminals while the user is browsing themes.
  const appearance = useAppearance();
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termThemeRef = useRef(appearance.colors.terminal);
  const fontFamilyRef = useRef(appearance.active.terminalFontFamily);
  // Per-pane font size overrides the global default when present. The
  // refs (read inside the long-lived xterm init effect) get the
  // *effective* value so initial mount uses the override too.
  const effectiveFontSize = fontSize ?? appearance.active.terminalFontSize;
  const fontSizeRef = useRef(effectiveFontSize);
  termThemeRef.current = appearance.colors.terminal;
  fontFamilyRef.current = appearance.active.terminalFontFamily;
  fontSizeRef.current = effectiveFontSize;
  // Container background mirrors the terminal palette so the small
  // padding strip around the canvas matches the active theme instead
  // of staying on the launch purple.
  const containerStyle = useMemo(
    () => ({ backgroundColor: appearance.colors.terminal.background, padding: "4px" }),
    [appearance.colors.terminal.background]
  );

  // Live-apply theme + font changes to the running xterm instance so
  // the user gets immediate feedback without tearing the WS down.
  // After a font change xterm's cell grid no longer matches the
  // container — call `fit` so cols/rows recompute on the same paint.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    try {
      t.options.theme = appearance.colors.terminal;
      t.options.fontFamily = `'${appearance.active.terminalFontFamily}', monospace`;
      t.options.fontSize = effectiveFontSize;
    } catch {
      /* if options aren't writable on this xterm version, ignore */
    }
    // Refit on the next frame — running it immediately can race with
    // xterm's internal renderer re-measure of the new font.
    requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* swallow — see init effect's tryFit */ }
    });
  }, [
    appearance.colors.terminal,
    appearance.active.terminalFontFamily,
    effectiveFontSize,
  ]);
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
  const onSendImageReadyRef = useRef(onSendImageReady);
  useEffect(() => {
    onSendImageReadyRef.current = onSendImageReady;
  }, [onSendImageReady]);

  // Transient feedback for the image-upload flow. Rendered as a pill in
  // the same corner stack as the connection status — never written into
  // the xterm grid.
  const [imageNote, setImageNote] = useState<{
    kind: "uploading" | "error";
    text: string;
  } | null>(null);

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

  // Final line of defense against the xterm 5.x renderer-init race.
  // If the instance/prototype patch misses (e.g. the internal field
  // name changed in a future xterm version), this window listener
  // catches the unhandled error event and prevents it from reaching
  // Next.js's dev overlay. We match on both the message text and a
  // hint of `Viewport` in the stack so unrelated TypeErrors still
  // surface normally. Capture phase + stopImmediatePropagation gives
  // us the best chance of suppressing before the overlay's own
  // listener sees the event.
  useEffect(() => {
    const handler = (e: ErrorEvent) => {
      const msg = e.error?.message ?? e.message ?? "";
      const stack = (e.error?.stack ?? "") + " " + (e.filename ?? "");
      const isDimensions =
        typeof msg === "string" && msg.includes("dimensions");
      const isXterm = stack.includes("Viewport") || stack.includes("xterm");
      if (isDimensions && isXterm) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("error", handler, true);
    return () => window.removeEventListener("error", handler, true);
  }, []);

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
    // True once we've had at least one open socket. On a *reconnect* the
    // server replays the full scrollback again; without clearing first the
    // replay would append to the existing buffer (the duplicated prompt /
    // `logout` lines the user saw). Reset the grid before re-attaching.
    let hasConnected = false;
    let observer: ResizeObserver | null = null;

    try {
      term = new Terminal({
        theme: termThemeRef.current,
        fontFamily: `'${fontFamilyRef.current}', monospace`,
        fontSize: fontSizeRef.current,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 10000,
        allowProposedApi: true,
        // xterm 5.3's escape-sequence parser logs "Parsing error: {…}"
        // via console.error for any byte sequence it doesn't fully
        // recognise. Modern shells emit plenty of those — OSC 8
        // hyperlinks, terminal-integration sequences (iTerm2 / VS
        // Code shells), unknown DCS strings, etc. — and the terminal
        // renders them correctly anyway because xterm gracefully
        // abandons the unknown state. The only effect of the log is
        // to flood Next.js's dev overlay. Disabling the internal log
        // surface keeps real failures (exceptions) visible while
        // silencing this advisory noise.
        logLevel: "off",
      });
      termRef.current = term;
      fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(container);

      // xterm 5.x has a renderer-init race: Viewport schedules an
      // _innerRefresh via an internal setTimeout(0), and if that
      // callback fires before the render-service's `dimensions` are
      // computed (or after the renderer is disposed by StrictMode
      // remount), the `dimensions` getter throws "Cannot read
      // properties of undefined (reading 'dimensions')". Subsequent
      // refreshes succeed, but Next.js's dev overlay still flags the
      // one-off throw as a runtime error.
      //
      // Patch _innerRefresh on the instance AND on its prototype, so
      // any other Viewport instance created during xterm's lifecycle
      // also inherits the safety wrap. Internals aren't a public API,
      // so each access is best-effort behind try/catch — if xterm
      // restructures we lose the suppression but keep working.
      const wrapInnerRefresh = (target: {
        _innerRefresh?: () => unknown;
      }) => {
        if (typeof target._innerRefresh !== "function") return;
        // Don't double-wrap if we (or a prior mount) already patched it.
        const patched = target._innerRefresh as {
          __managetPatched?: boolean;
        };
        if (patched.__managetPatched) return;
        const original = target._innerRefresh;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          try {
            return (original as (...a: unknown[]) => unknown).apply(
              this,
              args
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("dimensions")) return;
            throw err;
          }
        };
        (wrapped as { __managetPatched?: boolean }).__managetPatched = true;
        target._innerRefresh = wrapped;
      };
      try {
        const internal = term as unknown as {
          _core?: Record<string, { _innerRefresh?: () => unknown } | undefined>;
        };
        const candidates = [
          internal._core?.viewport,
          internal._core?._viewport,
          internal._core?.viewportElement,
        ].filter(Boolean) as { _innerRefresh?: () => unknown }[];
        for (const c of candidates) {
          wrapInnerRefresh(c);
          // Patch the prototype too so any future instance inherits.
          const proto = Object.getPrototypeOf(c) as {
            _innerRefresh?: () => unknown;
          } | null;
          if (proto) wrapInnerRefresh(proto);
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

    // ---- Image → terminal ("screenshot paste") ----
    // Upload the image to the session's host via the dashboard, then
    // paste the remote file path into the PTY. term.paste() honours
    // bracketed-paste mode, so Claude Code (and anything else that
    // resolves pasted image paths) treats it exactly like an image
    // dragged onto a local terminal. A literal remote Ctrl+V can't work
    // on headless hosts — there's no clipboard to read — so the path is
    // the transport.
    let noteTimer: ReturnType<typeof setTimeout> | null = null;
    const flashImageError = (text: string) => {
      if (!mounted) return;
      setImageNote({ kind: "error", text });
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(() => {
        if (mounted) setImageNote(null);
      }, 5000);
    };
    const sendImage = async (file: File) => {
      // `sessionId` is the effect-scoped mutable variable — for a tab
      // that's still waiting on session:create it's null and we bail
      // with feedback instead of uploading to nowhere.
      if (!sessionId) {
        flashImageError("Terminal isn't ready yet — try again in a second.");
        return;
      }
      if (mounted) setImageNote({ kind: "uploading", text: "Sending image…" });
      try {
        const fd = new FormData();
        fd.append("file", file, file.name || "image");
        const res = await fetch(`/api/sessions/${sessionId}/image`, {
          method: "POST",
          body: fd,
        });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const apiErr = (json as { error?: string } | null)?.error;
          throw new Error(apiErr ?? `Upload failed (HTTP ${res.status})`);
        }
        const remotePath = (json as { data?: { remotePath?: string } } | null)
          ?.data?.remotePath;
        if (typeof remotePath !== "string") {
          throw new Error("Upload response missing remotePath");
        }
        // The pane may have unmounted while the upload was in flight —
        // pasting into a disposed xterm throws.
        if (!mounted) return;
        // Trailing space matches what terminals append after a
        // drag-dropped path and nudges path-detection in TUIs.
        term?.paste(remotePath + " ");
        term?.focus();
        setImageNote(null);
      } catch (err) {
        flashImageError(err instanceof Error ? err.message : String(err));
      }
    };

    // Ctrl+V with an image on the clipboard: intercept before xterm's
    // own paste handler (capture phase on the container — xterm listens
    // on its inner textarea). Text-only pastes fall through untouched.
    const onImagePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            e.stopPropagation();
            void sendImage(f);
            return;
          }
        }
      }
    };
    // Drag-and-drop an image file onto the terminal. Only claims drags
    // that carry files, so the group mosaic's pane-reorder drag (which
    // carries text/plain) is untouched.
    const onImageDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onImageDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      const img = Array.from(files).find((f) => f.type.startsWith("image/"));
      if (img) {
        e.preventDefault();
        e.stopPropagation();
        void sendImage(img);
      }
    };
    container.addEventListener("paste", onImagePaste, true);
    container.addEventListener("dragover", onImageDragOver);
    container.addEventListener("drop", onImageDrop);
    // Hand the parent a stable trigger for its toolbar button.
    onSendImageReadyRef.current?.((file) => {
      void sendImage(file);
    });

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
          // Reconnect: wipe the grid so the server's scrollback replay
          // repaints cleanly instead of stacking on the old contents.
          if (hasConnected) {
            try { term?.reset(); } catch {}
          }
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
        hasConnected = true;
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

    // Defer the first WS connect by one macrotask. In React StrictMode
    // dev the effect mounts, immediately unmounts, then remounts; if
    // we call connect() synchronously we open + close + reopen a WS,
    // which the server logs as paired "[WS] client connected /
    // disconnected" entries and which the user perceives as a slow
    // initial connect (status pill lingers on "Connecting…" while
    // the first WS aborts and the second one establishes). With a
    // setTimeout(0), the cleanup runs first when StrictMode tears the
    // effect down and `connectTimer` is cleared before any WS is
    // attempted. In production the only effect is a sub-millisecond
    // delay; both modes converge to a single connect.
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      connectTimer = null;
      if (!mounted) return;
      connect();
    }, 0);

    observer = new ResizeObserver(() => {
      if (mounted && fit) {
        try { fit.fit(); } catch {}
      }
    });
    observer.observe(container);

    return () => {
      mounted = false;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (noteTimer) clearTimeout(noteTimer);
      onSendImageReadyRef.current?.(null);
      container.removeEventListener("paste", onImagePaste, true);
      container.removeEventListener("dragover", onImageDragOver);
      container.removeEventListener("drop", onImageDrop);
      observer?.disconnect();
      ws?.close();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
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
        style={containerStyle}
      />

      {/* Corner pill stack — connection status + image-upload feedback.
          All transient terminal-state messaging lives here so we never
          write a line into the xterm grid that would visually displace
          the agent's scrollback replay. */}
      <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-2 pointer-events-none">
        {status !== "connected" && !errorMessage && (
          <div className="flex items-center gap-2 bg-mg-bg-secondary/90 border border-mg-border rounded-md px-3 py-1.5">
            {status === "connecting" || status === "reconnecting" ? (
              <>
                <div className="w-3 h-3 border-2 border-mg-accent border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-mg-text-secondary">
                  {status === "reconnecting" ? "Reconnecting..." : "Connecting..."}
                </span>
              </>
            ) : status === "lost" ? (
              <>
                <div className="w-2 h-2 rounded-full bg-mg-warning" />
                <span className="text-xs text-mg-warning">
                  Session lost{statusDetail ? `: ${statusDetail}` : ""}
                </span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 rounded-full bg-mg-danger" />
                <span className="text-xs text-mg-danger">
                  {status === "error" ? "Error" : "Disconnected"}
                </span>
              </>
            )}
          </div>
        )}
        {imageNote && (
          <div className="flex items-center gap-2 bg-mg-bg-secondary/90 border border-mg-border rounded-md px-3 py-1.5">
            {imageNote.kind === "uploading" ? (
              <>
                <div className="w-3 h-3 border-2 border-mg-accent border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-mg-text-secondary">{imageNote.text}</span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 rounded-full bg-mg-danger" />
                <span className="text-xs text-mg-danger">{imageNote.text}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Fatal-error overlay when the terminal couldn't even initialise. */}
      {errorMessage && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6 bg-mg-bg-secondary/95">
          <div className="max-w-md text-center">
            <div className="text-mg-danger text-sm font-medium mb-2">Terminal failed</div>
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
