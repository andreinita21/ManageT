"use client";

/**
 * /stacks/[id]/terminals — multi-pane mosaic of every service's terminal.
 *
 * Opened in a new tab from the per-stack detail row on /stacks. Each
 * service of the stack gets its own xterm pane laid out horizontally
 * (resizable mosaic). Inactive services render a placeholder pane that
 * deep-links back to /stacks for a Launch.
 *
 * The page polls the runtime endpoint so the panes refresh from "(not
 * running)" → live-attached automatically when you Launch the stack on
 * the other tab.
 */
import React, { use, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { useServers, useStack, useStackRuntimes } from "@/lib/hooks/useApi";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import type { Server, StackService, StackServiceRuntime } from "@/types";

export default function StackTerminalsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // App Router passes params as a Promise on dynamic routes; `use()`
  // unwraps it on the client without making the whole component async.
  const { id: stackId } = use(params);
  const { data: stack, loading: loadingStack, error: stackError } = useStack(stackId);
  const { data: servers } = useServers();
  const { data: runtimeMap } = useStackRuntimes();

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

  const services = [...stack.services].sort(
    (a, b) => a.orderIndex - b.orderIndex
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
        <p className="text-xs text-mg-text-tertiary">
          Drag the dividers to resize • detached terminals keep running on the
          agent
        </p>
      </div>

      {/* Mosaic */}
      <div className="flex-1 min-h-0">
        {services.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-mg-text-tertiary">
            This stack has no services.
          </div>
        ) : (
          <PanelGroup
            direction="horizontal"
            autoSaveId={`stack-terminals-${stackId}`}
          >
            {services.map((svc, idx) => (
              <React.Fragment key={svc.id}>
                {idx > 0 && (
                  <PanelResizeHandle className="w-1.5 bg-mg-border hover:bg-mg-accent transition-colors data-[resize-handle-state=drag]:bg-mg-accent" />
                )}
                <Panel defaultSize={100 / services.length} minSize={10}>
                  <TerminalPanel
                    svc={svc}
                    runtime={runtimeByService.get(svc.id)}
                    server={serversById.get(svc.serverId)}
                  />
                </Panel>
              </React.Fragment>
            ))}
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
}: {
  svc: StackService;
  runtime: StackServiceRuntime | undefined;
  server: Server | undefined;
}) {
  const isActive = runtime?.status === "active" && runtime.sessionId !== null;

  // Sticky session id: once we've seen a live sessionId for this service,
  // keep the TerminalPane mounted on that id even if the next runtime poll
  // briefly shows "inactive" (network blip, agent heartbeat lag). The
  // agent keeps the PTY + scrollback alive regardless of our DB row's
  // current status, so an unnecessary unmount throws away the in-xterm
  // scrollback buffer and forces a re-attach (with another scrollback
  // replay) which the user perceives as the terminal "blinking" and
  // forgetting state. We only swap the pinned id when runtime hands us a
  // genuinely different sessionId — that's the "session was respawned"
  // case where a fresh xterm is correct.
  const pinnedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (runtime?.sessionId && runtime.sessionId !== pinnedSessionIdRef.current) {
      pinnedSessionIdRef.current = runtime.sessionId;
    }
  }, [runtime?.sessionId]);
  const effectiveSessionId =
    runtime?.sessionId ?? pinnedSessionIdRef.current ?? null;
  const showTerminal = effectiveSessionId !== null;

  return (
    <div className="h-full flex flex-col bg-[#0d0d14]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-mg-border bg-mg-bg-secondary flex-shrink-0 text-xs">
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
      <div className="flex-1 min-h-0">
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
