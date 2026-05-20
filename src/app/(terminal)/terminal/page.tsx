"use client";

/**
 * /terminal — multi-tab terminal view.
 *
 * URL contract:
 *   ?server=<id>   → auto-create a brand-new session for that server (no
 *                    modal in between). This is what the "Open Terminal"
 *                    button on a server detail page links to.
 *   ?session=<id>  → auto-attach to an existing session (used after a
 *                    browser reload, or when re-opening from the Sessions
 *                    page).
 *   no params      → show the empty state with a "New Session" button.
 *
 * The "+ New" button (in the tab bar) opens a small picker for choosing a
 * server or attaching to an existing session. The picker is only ever
 * surfaced through that button — never as a side-effect of opening the
 * page, so a directly-linked Open Terminal click feels like one action.
 */
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { CommandRunner } from "@/components/terminal/CommandRunner";
import { GroupMenu } from "@/components/terminal/GroupMenu";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useServers, useSessions } from "@/lib/hooks/useApi";
import { useToast } from "@/components/ui/Toast";
import type { Server, Session } from "@/types";

interface TerminalTab {
  id: string;
  serverId: string;
  /** null means "this tab will create a fresh session as soon as TerminalPane mounts". */
  sessionId: string | null;
  label: string;
}

export default function TerminalPageWrapper() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full bg-mg-bg text-mg-text-secondary">
          Loading terminal...
        </div>
      }
    >
      <TerminalPage />
    </Suspense>
  );
}

function TerminalPage() {
  const searchParams = useSearchParams();
  const initialServer = searchParams.get("server");
  const initialSession = searchParams.get("session");
  const { data: servers } = useServers();
  const { data: sessions, refetch: refetchSessions } = useSessions();
  const { toast } = useToast();

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The first-render bootstrap is one-shot: we set up tabs from URL params
  // (or auto-restore live sessions) exactly once, then never again. Without
  // this guard the effect would re-run every time `sessions` re-fetches and
  // happily re-create tabs the user just closed.
  const bootstrappedRef = useRef(false);

  const addTab = useCallback(
    (input: { serverId: string; sessionId: string | null; label: string }): string => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setTabs((prev) => [...prev, { id, ...input }]);
      setActiveTabId(id);
      return id;
    },
    []
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const closing = tabs.find((t) => t.id === tabId);
      setTabs((prev) => prev.filter((t) => t.id !== tabId));
      setActiveTabId((curr) => {
        if (curr !== tabId) return curr;
        const remaining = tabs.filter((t) => t.id !== tabId);
        return remaining[remaining.length - 1]?.id ?? null;
      });
      // Closing a tab is an explicit "kill this session" — that's why we
      // DELETE the session row. Browser-window close (refresh / accidental
      // tab close) doesn't run this code path, so the PTY stays alive
      // server-side and the user can re-attach via the Sessions page.
      if (closing?.sessionId) {
        fetch(`/api/sessions/${closing.sessionId}`, { method: "DELETE" }).catch((err) => {
          console.error("[terminal] delete session failed:", err);
        });
      }
    },
    [tabs]
  );

  // ---- Bootstrap: URL-param auto-connect only ----
  // The /terminal page used to auto-open every live session from the
  // backend on a bare visit. That made the "click Terminal in the
  // sidebar" experience feel random — whichever sessions happened to
  // still be alive on the agent suddenly appeared as tabs. We removed
  // that: only ?server= or ?session= in the URL opens a tab; a bare
  // visit lands on the empty state so the user explicitly picks
  // "new terminal" or "send a command". Existing sessions are
  // surfaced via /sessions and the `+` button's picker.
  useEffect(() => {
    if (bootstrappedRef.current) return;
    if (!servers) return; // wait until we know what servers exist
    if (sessions === null || sessions === undefined) return; // wait until sessions list resolved
    bootstrappedRef.current = true;

    // ?session=<id>: auto-attach. If the session is missing/stale, fall
    // through to the empty state rather than showing nothing useful.
    if (initialSession) {
      const sess = sessions.find((s) => s.id === initialSession);
      if (sess) {
        const server = servers.find((s) => s.id === sess.serverId);
        // setState-in-effect is intentional here — one-shot bootstrap
        // gated by `bootstrappedRef`, can't be expressed as derived
        // state without losing the "open exactly once on first nav"
        // behaviour the URL contract needs.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        addTab({
          serverId: sess.serverId,
          sessionId: sess.id,
          label: server?.name ?? sess.sessionName,
        });
        return;
      }
      toast(
        `Session ${initialSession.slice(0, 8)}… isn't available anymore.`,
        "error"
      );
    }

    // ?server=<id>: auto-create a session for that server, no modal.
    if (initialServer) {
      const server = servers.find((s) => s.id === initialServer);
      if (server) {
        addTab({ serverId: server.id, sessionId: null, label: server.name });
        return;
      }
      // URL had a server id but it's no longer in our list — let the user
      // see the picker so they can pick a real one.
      toast(
        `Server ${initialServer.slice(0, 8)}… isn't in your server list anymore.`,
        "error"
      );
    }
  }, [servers, sessions, initialServer, initialSession, addTab, toast]);

  const sessionsById = useMemo(() => {
    const m = new Map<string, Session>();
    (sessions ?? []).forEach((s) => m.set(s.id, s));
    return m;
  }, [sessions]);

  const renderedTabs = useMemo(
    () =>
      tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const liveSession = tab.sessionId
          ? sessionsById.get(tab.sessionId) ?? null
          : null;
        return (
          <div
            key={tab.id}
            className={
              isActive
                ? "absolute inset-0"
                : "absolute inset-0 invisible pointer-events-none"
            }
          >
            <TerminalPane
              serverId={tab.serverId}
              sessionId={tab.sessionId ?? undefined}
              className="h-full"
              onSessionReady={(sid) => {
                setTabs((prev) =>
                  prev.map((t) => (t.id === tab.id ? { ...t, sessionId: sid } : t))
                );
                refetchSessions();
              }}
            />
            {isActive && (
              <GroupMenu
                session={liveSession}
                onMutated={() => refetchSessions()}
              />
            )}
          </div>
        );
      }),
    [tabs, activeTabId, refetchSessions, sessionsById]
  );

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 3.5rem)" }}>
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
              <span className="truncate max-w-[160px]">{tab.label}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-mg-text-tertiary hover:text-mg-danger transition-all duration-200"
                aria-label="Close tab"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 px-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPickerOpen(true)}
            title="New terminal"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden min-h-0 relative">
        {tabs.length === 0 ? (
          <EmptyState
            onNew={() => setPickerOpen(true)}
            servers={servers ?? []}
          />
        ) : (
          renderedTabs
        )}
      </div>

      <NewSessionPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        servers={servers ?? []}
        sessions={(sessions ?? []).filter((s) => s.status === "active" || s.status === "disconnected")}
        existingTabs={tabs}
        onConnect={(serverId) => {
          const server = servers?.find((s) => s.id === serverId);
          if (!server) {
            toast("That server isn't in your list anymore.", "error");
            return;
          }
          addTab({ serverId, sessionId: null, label: server.name });
          setPickerOpen(false);
        }}
        onAttach={(sess) => {
          // If a tab is already attached to this session, just focus it
          // instead of creating a duplicate that would race over input.
          const dup = tabs.find((t) => t.sessionId === sess.id);
          if (dup) {
            setActiveTabId(dup.id);
            setPickerOpen(false);
            return;
          }
          const server = servers?.find((s) => s.id === sess.serverId);
          addTab({
            serverId: sess.serverId,
            sessionId: sess.id,
            label: server?.name ?? sess.sessionName,
          });
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

// ----------------------------------------------------------------------
// Empty state + picker subcomponents
// ----------------------------------------------------------------------

function EmptyState({ onNew, servers }: { onNew: () => void; servers: Server[] }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
      <svg className="w-16 h-16 text-mg-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1}
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
      <p className="text-mg-text-secondary text-sm">No terminal sessions open</p>
      <Button onClick={onNew}>
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        New Session
      </Button>

      {servers.length > 0 && (
        <div className="w-full max-w-2xl mt-6">
          <CommandRunner servers={servers} />
        </div>
      )}
    </div>
  );
}

interface NewSessionPickerProps {
  open: boolean;
  onClose: () => void;
  servers: Server[];
  sessions: Session[];
  existingTabs: TerminalTab[];
  onConnect: (serverId: string) => void;
  onAttach: (s: Session) => void;
}

function NewSessionPicker({
  open,
  onClose,
  servers,
  sessions,
  existingTabs,
  onConnect,
  onAttach,
}: NewSessionPickerProps) {
  return (
    <Modal open={open} onClose={onClose} title="New Terminal Session">
      <div className="space-y-5">
        <div>
          <p className="text-xs text-mg-text-tertiary mb-2 uppercase tracking-wide">
            Connect to a server
          </p>
          {servers.length === 0 ? (
            <div className="text-sm text-mg-text-secondary bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2">
              No servers yet. Add one from the Servers page first.
            </div>
          ) : (
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {servers.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="w-full text-left bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2 hover:border-mg-accent hover:bg-mg-bg-hover transition-all duration-200 flex items-center justify-between"
                  onClick={() => onConnect(s.id)}
                >
                  <span className="text-sm text-mg-text font-medium">{s.name}</span>
                  <span className="text-xs text-mg-text-tertiary font-mono">{s.host}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {sessions.length > 0 && (
          <div>
            <p className="text-xs text-mg-text-tertiary mb-2 uppercase tracking-wide">
              Or attach to a saved session
            </p>
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {sessions.map((session) => {
                const open = existingTabs.some((t) => t.sessionId === session.id);
                const server = servers.find((s) => s.id === session.serverId);
                return (
                  <button
                    key={session.id}
                    type="button"
                    className="w-full text-left bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2 hover:border-mg-accent hover:bg-mg-bg-hover transition-all duration-200"
                    onClick={() => onAttach(session)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-mg-text font-mono">
                        {server?.name ?? "?"}: {session.sessionName}
                      </span>
                      <span className="text-xs text-mg-text-tertiary">
                        {open ? "(already open)" : `(${session.status})`}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
