"use client";

import React, { Suspense, useState, useCallback, useMemo, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { RecoveryBanner } from "@/components/terminal/RecoveryBanner";
import { CommandRunner } from "@/components/terminal/CommandRunner";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { useServers, useSessions } from "@/lib/hooks/useApi";
import { useToast } from "@/components/ui/Toast";
import type { ServerMessage } from "@/types";

interface TerminalTab {
  id: string;
  sessionId: string | null;
  serverId: string;
  label: string;
}

interface RecoveryInfo {
  sessionId: string;
  method: "reattach" | "recreate";
  command?: string;
  cwd?: string;
}

export default function TerminalPageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full bg-mg-bg text-mg-text-secondary">Loading terminal...</div>}>
      <TerminalPage />
    </Suspense>
  );
}

function TerminalPage() {
  const searchParams = useSearchParams();
  const initialServer = searchParams.get("server") ?? "";
  const initialSession = searchParams.get("session") ?? "";
  const { data: servers } = useServers();
  const { data: sessions } = useSessions();
  const { toast } = useToast();

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [splitView, setSplitView] = useState(false);
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  const [newSessionModal, setNewSessionModal] = useState(false);
  const [newSessionServer, setNewSessionServer] = useState(initialServer);
  const [recoveries, setRecoveries] = useState<RecoveryInfo[]>([]);
  // Track whether we've already attempted the one-shot session restore on
  // mount, so that subsequent re-fetches of `sessions` don't keep re-creating
  // tabs the user explicitly closed.
  const restoredRef = React.useRef(false);

  // Auto-restore tabs for sessions that are still alive on the backend.
  // The session manager keeps PTY streams resident in process memory across
  // browser tab closures, and `server.ts` marks anything stale as
  // "disconnected" on Node startup. So any session that lands here in
  // "active" state has a real PTY ready to reattach to.
  useEffect(() => {
    if (restoredRef.current) return;
    if (!sessions || !servers) return;
    restoredRef.current = true;

    const alive = sessions.filter((s) => s.status === "active");
    if (alive.length === 0) return;

    const restored: TerminalTab[] = alive.map((s) => {
      const server = servers.find((srv) => srv.id === s.serverId);
      return {
        id: crypto.randomUUID(),
        sessionId: s.id,
        serverId: s.serverId,
        label: server?.name ?? s.sessionName,
      };
    });

    setTabs(restored);
    setActiveTabId(restored[0]?.id ?? null);
  }, [sessions, servers]);

  // Auto-open new session modal if server param is provided and no tabs exist
  useEffect(() => {
    if (initialServer && servers && servers.length > 0 && tabs.length === 0 && restoredRef.current) {
      setNewSessionServer(initialServer);
      setNewSessionModal(true);
    }
  }, [initialServer, servers, tabs.length]);

  // If the URL carries `?session=<id>`, ensure that session has a tab and is
  // focused. Runs after auto-restore so we can reuse an existing tab if
  // restoration already created one for it.
  useEffect(() => {
    if (!initialSession || !restoredRef.current) return;
    if (!sessions || !servers) return;

    const existing = tabs.find((t) => t.sessionId === initialSession);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    const session = sessions.find((s) => s.id === initialSession);
    if (!session) return;
    const server = servers.find((srv) => srv.id === session.serverId);

    const tabId = crypto.randomUUID();
    setTabs((prev) => [
      ...prev,
      {
        id: tabId,
        sessionId: session.id,
        serverId: session.serverId,
        label: server?.name ?? session.sessionName,
      },
    ]);
    setActiveTabId(tabId);
    // We intentionally only respond to changes in `initialSession` —
    // re-runs from `tabs` mutating would either no-op (existing branch)
    // or create duplicates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSession, sessions, servers]);

  const createTab = useCallback(
    (serverId: string) => {
      // Surface every failure mode rather than swallowing it. The Connect
      // button used to silently noop if `servers` was still loading or if
      // the dropdown's value didn't match anything in the list — both
      // present to the user as "the button did nothing."
      console.error("[terminal] createTab called with serverId=", serverId);
      if (!serverId) {
        toast("Pick a server before connecting.", "error");
        return;
      }
      if (!servers) {
        toast("Server list is still loading. Try again in a second.", "error");
        return;
      }
      const server = servers.find((s) => s.id === serverId);
      if (!server) {
        console.error("[terminal] server not found in list", { serverId, servers });
        toast(`Server ${serverId} not found in your server list.`, "error");
        return;
      }

      const tabId = crypto.randomUUID();

      const newTab: TerminalTab = {
        id: tabId,
        sessionId: null, // No session yet — TerminalPane will send session:create.
        serverId,
        label: server.name,
      };

      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
      setNewSessionModal(false);
      console.error("[terminal] tab created, modal closing", { tabId, serverId });
    },
    [servers, toast]
  );

  const closeTab = useCallback(
    (tabId: string) => {
      // Snapshot the closing tab so we can kill its server-side session.
      // Closing a tab is an explicit "kill" — only browser-window close
      // (which never runs this code path) preserves sessions.
      const closing = tabs.find((t) => t.id === tabId);

      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId) {
          setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
        }
        if (splitTabId === tabId) {
          setSplitTabId(null);
          setSplitView(false);
        }
        return next;
      });

      if (closing?.sessionId) {
        fetch(`/api/sessions/${closing.sessionId}`, { method: "DELETE" }).catch(
          (err) => {
            console.error("[terminal] Failed to delete session:", err);
          }
        );
      }
    },
    [tabs, activeTabId, splitTabId]
  );

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 3.5rem)" }}>
      {/* Recovery banners */}
      {recoveries.length > 0 && (
        <div className="px-4 pt-3 space-y-2">
          {recoveries.map((r) => (
            <RecoveryBanner
              key={r.sessionId}
              sessionId={r.sessionId}
              method={r.method}
              command={r.command}
              cwd={r.cwd}
              onDismiss={() => setRecoveries((prev) => prev.filter((x) => x.sessionId !== r.sessionId))}
            />
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center border-b border-mg-border bg-mg-bg-secondary px-2 flex-shrink-0">
        <div className="flex items-center flex-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex items-center gap-2 px-4 py-2.5 text-sm cursor-pointer border-b-2 -mb-px transition-all duration-200 ${
                activeTabId === tab.id
                  ? "text-mg-accent border-mg-accent bg-mg-bg-active"
                  : "text-mg-text-secondary border-transparent hover:text-mg-text hover:bg-mg-bg-hover"
              }`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="truncate max-w-[120px]">{tab.label}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-mg-text-tertiary hover:text-red-400 transition-all duration-200"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 px-2">
          <Button variant="ghost" size="sm" onClick={() => setNewSessionModal(true)} title="New terminal">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (splitView) {
                setSplitView(false);
                setSplitTabId(null);
              } else if (tabs.length >= 2) {
                setSplitView(true);
                const other = tabs.find((t) => t.id !== activeTabId);
                if (other) setSplitTabId(other.id);
              }
            }}
            title={splitView ? "Single view" : "Split view"}
            disabled={tabs.length < 2}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
            </svg>
          </Button>
        </div>
      </div>

      {/* Terminal area */}
      <div className="flex-1 flex overflow-hidden min-h-0 relative">
        {tabs.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <svg className="w-16 h-16 text-mg-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-mg-text-secondary text-sm">No terminal sessions open</p>
            <Button onClick={() => setNewSessionModal(true)}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Session
            </Button>

            {servers && servers.length > 0 && (
              <div className="w-full max-w-2xl mt-6">
                <CommandRunner servers={servers} />
              </div>
            )}
          </div>
        ) : (
          // Render EVERY tab's TerminalPane at once, layered absolutely. We
          // only toggle visibility/positioning instead of mounting/unmounting
          // so that each tab's SSH session and WebSocket stay alive when the
          // user switches tabs.
          tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isSplit = splitView && tab.id === splitTabId;
            const visible = isActive || isSplit;

            let positionClass: string;
            if (!visible) {
              positionClass = "absolute inset-0 invisible pointer-events-none";
            } else if (splitView && isActive) {
              positionClass = "absolute top-0 bottom-0 left-0 w-1/2 border-r border-mg-border";
            } else if (splitView && isSplit) {
              positionClass = "absolute top-0 bottom-0 right-0 w-1/2";
            } else {
              positionClass = "absolute inset-0";
            }

            return (
              <div key={tab.id} className={positionClass}>
                <TerminalPane
                  serverId={tab.serverId}
                  sessionId={tab.sessionId ?? undefined}
                  className="h-full"
                  onSessionReady={(sid) => {
                    setTabs((prev) =>
                      prev.map((t) => (t.id === tab.id ? { ...t, sessionId: sid } : t))
                    );
                  }}
                />
              </div>
            );
          })
        )}
      </div>

      {/* New session modal */}
      <Modal
        open={newSessionModal}
        onClose={() => setNewSessionModal(false)}
        title="New Terminal Session"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNewSessionModal(false)}>
              Cancel
            </Button>
            <Button onClick={() => createTab(newSessionServer)} disabled={!newSessionServer}>
              Connect
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Select
            label="Server"
            placeholder="Select a server..."
            options={(servers ?? []).map((s) => ({
              value: s.id,
              label: `${s.name} (${s.host})`,
            }))}
            value={newSessionServer}
            onChange={(e) => setNewSessionServer(e.target.value)}
          />

          {sessions && sessions.length > 0 && (
            <div>
              <p className="text-xs text-mg-text-tertiary mb-2">Or attach to an existing session:</p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {sessions
                  .filter((s) => s.status === "active" || s.status === "disconnected")
                  .map((session) => (
                    <button
                      key={session.id}
                      className="w-full text-left bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2 hover:border-mg-border-hover hover:bg-mg-bg-hover transition-all duration-200"
                      onClick={() => {
                        const tabId = crypto.randomUUID();
                        const server = servers?.find((s) => s.id === session.serverId);
                        setTabs((prev) => [
                          ...prev,
                          {
                            id: tabId,
                            sessionId: session.id,
                            serverId: session.serverId,
                            label: `${server?.name ?? "?"} - ${session.sessionName}`,
                          },
                        ]);
                        setActiveTabId(tabId);
                        setNewSessionModal(false);
                      }}
                    >
                      <span className="text-sm text-mg-text font-mono">{session.sessionName}</span>
                      <span className="text-xs text-mg-text-tertiary ml-2">({session.status})</span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
