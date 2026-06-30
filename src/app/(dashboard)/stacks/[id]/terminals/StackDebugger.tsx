"use client";

/**
 * Stack debugger view — a time-aligned table of every service's output.
 *
 * Toggled on from the stack terminals page (the "Debugger" button). Where
 * the mosaic shows each service's live terminal in its own pane, this view
 * merges them onto one wall-clock axis so you can see, second by second,
 * what each service printed — and, crucially, where a service went *silent*
 * while another kept logging. That blank cell is the whole point: it makes
 * "service A crashed at the same instant service B logged the bad request"
 * visible at a glance.
 *
 *   - First column is the server-side timestamp (HH:MM:SS), one row per
 *     wall-clock second. Timestamps come from the agent (see
 *     `LogLine` in agent/src/sessions/protocol.rs) — captured the instant
 *     the line was read off the PTY, before any network hop.
 *   - One column per service; a service's lines for that second stack in
 *     its cell, blank when it was silent. Each line is prefixed with its
 *     millisecond offset so sub-second ordering across columns is legible.
 *
 * Data arrives over the same `/api/ws` relay the terminals use: we send
 * one `session:tail` per running service and accumulate the `session:log`
 * frames the relay forwards. Cross-server stacks rely on each host's
 * clock, so the server name is shown in each column header.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Coalesce incoming lines into one re-render at most this often. A busy
 *  stack can emit hundreds of lines a second; without batching React would
 *  thrash. */
const FLUSH_MS = 150;
/** Keep at most this many distinct seconds of history in the table. ~50
 *  minutes of active output; older rows drop off the top. */
const MAX_BUCKETS = 3000;
/** Cap lines kept per service per second so a single chatty second can't
 *  grow a cell without bound. */
const MAX_LINES_PER_CELL = 500;

export interface DebuggerColumn {
  /** Stable across respawns — keyed on the service, not its session. */
  serviceId: string;
  name: string;
  serverId: string;
  serverName: string;
  /** The currently-running session to tail, or null when the service is
   *  stopped (its column renders but stays blank). */
  sessionId: string | null;
}

interface LogEntry {
  /** ms-within-second (0–999), for the per-line prefix. */
  ms: number;
  text: string;
}

/** second (epoch) → serviceId → that service's lines in that second. */
type Buckets = Map<number, Map<string, LogEntry[]>>;

function fmtSec(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function StackDebugger({ columns }: { columns: DebuggerColumn[] }) {
  const buckets = useRef<Buckets>(new Map());
  // Bumped by the flush timer when new lines have landed, to trigger a
  // re-render. The table reads `buckets.current` directly during render —
  // safe because mutation only happens in the WS handler and we re-render
  // solely off this tick.
  const [tick, setTick] = useState(0);
  const dirty = useRef(false);

  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Latest sessionId→serviceId map, read by the WS handler to route each
  // log line to its column. A ref (not state) so the long-lived handler
  // always sees the current mapping without re-subscribing.
  const sessionToService = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const m = new Map<string, string>();
    for (const c of columns) if (c.sessionId) m.set(c.sessionId, c.serviceId);
    sessionToService.current = m;
  }, [columns]);

  // ---- WebSocket: open once, route session:log into the buckets. ----
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/api/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Flipping `connected` re-runs the tail-sync effect below, which is
      // the single owner of tail/untail. Tailing here too would double-tail
      // every session (the relay replaces the stream and replays the ring a
      // second time → duplicated lines).
      setConnected(true);
    };

    ws.onmessage = (event) => {
      let msg: { type?: string; sessionId?: string; t?: number; line?: string };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.type !== "session:log") return;
      if (typeof msg.t !== "number" || typeof msg.line !== "string") return;
      const serviceId = msg.sessionId
        ? sessionToService.current.get(msg.sessionId)
        : undefined;
      if (!serviceId) return;

      const sec = Math.floor(msg.t / 1000);
      const ms = msg.t % 1000;
      let row = buckets.current.get(sec);
      if (!row) {
        row = new Map();
        buckets.current.set(sec, row);
        // Evict oldest seconds past the cap.
        if (buckets.current.size > MAX_BUCKETS) {
          const oldest = Math.min(...buckets.current.keys());
          buckets.current.delete(oldest);
        }
      }
      let cell = row.get(serviceId);
      if (!cell) {
        cell = [];
        row.set(serviceId, cell);
      }
      cell.push({ ms, text: msg.line });
      if (cell.length > MAX_LINES_PER_CELL) cell.shift();
      dirty.current = true;
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    return () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
    // Mount-once: the WS handlers read live state through refs, and the
    // tail-sync effect below owns reacting to column changes.
  }, []);

  // ---- Keep tails in sync as services start/stop (sessionId changes). ----
  const runningKey = columns
    .filter((c) => c.sessionId)
    .map((c) => `${c.serviceId}:${c.sessionId}`)
    .sort()
    .join("|");
  const tailed = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const want = new Map<string, { sessionId: string; serverId: string }>();
    for (const c of columns) {
      if (c.sessionId) want.set(c.sessionId, { sessionId: c.sessionId, serverId: c.serverId });
    }
    // Tail newcomers.
    for (const [sid, info] of want) {
      if (!tailed.current.has(sid)) {
        ws.send(JSON.stringify({ type: "session:tail", ...info }));
        tailed.current.add(sid);
      }
    }
    // Untail sessions that are gone (respawned / stopped).
    for (const sid of [...tailed.current]) {
      if (!want.has(sid)) {
        ws.send(JSON.stringify({ type: "session:untail", sessionId: sid }));
        tailed.current.delete(sid);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey, connected]);

  // ---- Flush timer: re-render at most every FLUSH_MS when dirty. ----
  useEffect(() => {
    const id = setInterval(() => {
      if (dirty.current) {
        dirty.current = false;
        setTick((t) => t + 1);
      }
    }, FLUSH_MS);
    return () => clearInterval(id);
  }, []);

  // Sorted second-buckets to render. Computed inline rather than memoised:
  // a render only happens when the flush timer bumps `tick` (or props
  // change), and sorting a few thousand keys is cheap. `tick` is read here
  // purely to tie this recompute to the flush.
  void tick;
  const secs = Array.from(buckets.current.keys()).sort((a, b) => a - b);

  // ---- Auto-scroll to bottom when the user is already near it. ----
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [tick]);

  const gridTemplate = `5.5rem repeat(${columns.length}, minmax(12rem, 1fr))`;

  return (
    <div className="h-full flex flex-col bg-[#0d0d14]">
      {/* Column headers */}
      <div
        className="grid border-b border-mg-border bg-mg-bg-secondary text-xs flex-shrink-0 sticky top-0"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div className="px-2 py-1.5 font-mono text-mg-text-tertiary border-r border-mg-border">
          time
        </div>
        {columns.map((c) => (
          <div
            key={c.serviceId}
            className="px-2 py-1.5 border-r border-mg-border last:border-r-0 min-w-0"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                  c.sessionId ? "bg-mg-success" : "bg-mg-text-tertiary/60"
                }`}
              />
              <span className="font-mono text-mg-text truncate">{c.name}</span>
              <span className="text-mg-text-tertiary truncate">
                ({c.serverName})
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Rows */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto font-mono text-xs"
      >
        {secs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-mg-text-tertiary p-4 text-center">
            {connected
              ? "Waiting for output… lines appear here as services log."
              : "Connecting…"}
          </div>
        ) : (
          secs.map((sec) => {
            const row = buckets.current.get(sec);
            return (
              <div
                key={sec}
                className="grid border-b border-mg-border/40 hover:bg-white/[0.02]"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <div className="px-2 py-1 text-mg-text-tertiary border-r border-mg-border/40 tabular-nums select-none">
                  {fmtSec(sec)}
                </div>
                {columns.map((c) => {
                  const entries = row?.get(c.serviceId);
                  return (
                    <div
                      key={c.serviceId}
                      className="px-2 py-1 border-r border-mg-border/40 last:border-r-0 min-w-0 whitespace-pre-wrap break-words text-mg-text"
                    >
                      {entries?.map((e, i) => (
                        <div key={i} className="leading-tight">
                          <span className="text-mg-text-tertiary/70 mr-1.5 select-none">
                            .{String(e.ms).padStart(3, "0")}
                          </span>
                          {e.text}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
