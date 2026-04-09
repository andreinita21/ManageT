"use client";

import React, { useState, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { RecoveryBanner } from "@/components/terminal/RecoveryBanner";
import { CommandRunner } from "@/components/terminal/CommandRunner";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { useServers, useSessions } from "@/lib/hooks/useApi";
import { useWebSocket } from "@/lib/hooks/useWebSocket";
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

export default function TerminalPage() {
  const searchParams = useSearchParams();
  const initialServer = searchParams.get("server") ?? "";
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

  const wsUrl = useMemo(() => {
    const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "localhost:3000";
    return `${proto}//${host}/api/ws`;
  }, []);

  const handleWsMessage = useCallback(
    (msg: ServerMessage) => {
      if (msg.type === "session:recovered") {
        setRecoveries((prev) => [
          ...prev,
          {
            sessionId: msg.sessionId,
            method: msg.method,
            command: msg.command,
            cwd: msg.cwd,
          },
        ]);
        toast(`Session recovered via ${msg.method}`, "success");
      }
      if (msg.type === "session:lost") {
        toast(`Session lost: ${msg.reason}`, "error");
      }
    },
    [toast]
  );

  const { send, connected } = useWebSocket({
    url: wsUrl,
    onMessage: handleWsMessage,
  });

  const createTab = useCallback(
    (serverId: string) => {
      const server = servers?.find((s) => s.id === serverId);
      if (!server) return;

      const tabId = crypto.randomUUID();
      // Request session creation via WebSocket
      send({ type: "session:create", serverId });

      const newTab: TerminalTab = {
        id: tabId,
        sessionId: null, // Will be set when session:state comes back
        serverId,
        label: server.name,
      };

      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
      setNewSessionModal(false);
    },
    [servers, send]
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.sessionId) {
        send({ type: "session:detach", sessionId: tab.sessionId });
      }

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
    },
    [tabs, activeTabId, splitTabId, send]
  );

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const splitTab = tabs.find((t) => t.id === splitTabId);

  return (
    <div className="h-full flex flex-col -m-6">
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
      <div className="flex items-center border-b border-mg-border bg-mg-bg-secondary px-2">
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setNewSessionModal(true)}
            title="New terminal"
          >
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
          <div className="flex items-center gap-1.5 ml-2 px-2 border-l border-mg-border">
            <div className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`} />
            <span className="text-xs text-mg-text-tertiary">{connected ? "WS" : "..."}</span>
          </div>
        </div>
      </div>

      {/* Terminal area */}
      <div className="flex-1 flex overflow-hidden">
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

            {/* Quick command runner */}
            {servers && servers.length > 0 && (
              <div className="w-full max-w-2xl mt-6">
                <CommandRunner servers={servers} />
              </div>
            )}
          </div>
        ) : (
          <>
            <div className={`${splitView ? "w-1/2 border-r border-mg-border" : "w-full"}`}>
              {activeTab && (
                <TerminalPane
                  sessionId={activeTab.sessionId}
                  wsUrl={wsUrl}
                  className="h-full"
                />
              )}
            </div>
            {splitView && splitTab && (
              <div className="w-1/2">
                <TerminalPane
                  sessionId={splitTab.sessionId}
                  wsUrl={wsUrl}
                  className="h-full"
                />
              </div>
            )}
          </>
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
                            label: `${server?.name ?? "?"} - ${session.tmuxSessionName}`,
                          },
                        ]);
                        setActiveTabId(tabId);
                        setNewSessionModal(false);
                        send({ type: "session:attach", sessionId: session.id });
                      }}
                    >
                      <span className="text-sm text-mg-text font-mono">{session.tmuxSessionName}</span>
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
