"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useServers, useSessions, deleteSession } from "@/lib/hooks/useApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Table } from "@/components/ui/Table";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import type { Server, Session } from "@/types";

const statusVariant: Record<string, "success" | "danger" | "warning" | "default"> = {
  active: "success",
  disconnected: "danger",
  reconnecting: "warning",
  recovering: "warning",
  closed: "default",
};

interface LogsModalState {
  session: Session;
  server?: Server;
}

export default function SessionsPage() {
  const router = useRouter();
  const { data: sessions, loading, refetch } = useSessions();
  const { data: servers } = useServers();
  const { toast } = useToast();

  const [logsModal, setLogsModal] = useState<LogsModalState | null>(null);

  const serverById = useMemo(() => {
    const map = new Map<string, Server>();
    (servers ?? []).forEach((s) => map.set(s.id, s));
    return map;
  }, [servers]);

  const handleClose = async (session: Session) => {
    if (!confirm(`Close session "${session.sessionName}"? The remote shell will be killed.`)) {
      return;
    }
    try {
      await deleteSession(session.id);
      toast(`Closed ${session.sessionName}`, "success");
      refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Close failed";
      toast(msg, "error");
    }
  };

  const handleView = (session: Session) => {
    router.push(`/terminal?session=${session.id}`);
  };

  const columns = useMemo(
    () => [
      {
        key: "name",
        header: "Session",
        render: (s: Session) => (
          <div className="flex flex-col">
            <span className="font-mono text-mg-text">{s.sessionName}</span>
            <span className="text-xs text-mg-text-tertiary">
              {new Date(s.createdAt).toLocaleString()}
            </span>
          </div>
        ),
      },
      {
        key: "server",
        header: "Server",
        render: (s: Session) => {
          const server = serverById.get(s.serverId);
          return (
            <div className="flex flex-col">
              <span className="text-mg-text">{server?.name ?? "—"}</span>
              {server && (
                <span className="text-xs text-mg-text-tertiary font-mono">
                  {server.username}@{server.host}
                </span>
              )}
            </div>
          );
        },
      },
      {
        key: "cwd",
        header: "CWD",
        render: (s: Session) => (
          <span className="text-xs text-mg-text-secondary font-mono">{s.cwd ?? "—"}</span>
        ),
      },
      {
        key: "lastCommand",
        header: "Last Command",
        render: (s: Session) => (
          <span className="text-xs text-mg-text-secondary font-mono truncate max-w-[240px] inline-block">
            {s.lastCommand || "—"}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (s: Session) => (
          <Badge variant={statusVariant[s.status] ?? "default"}>{s.status}</Badge>
        ),
      },
      {
        key: "actions",
        header: "",
        render: (s: Session) => (
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleView(s);
              }}
            >
              View
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setLogsModal({ session: s, server: serverById.get(s.serverId) });
              }}
            >
              Logs
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleClose(s);
              }}
            >
              <span className="text-red-400">Close</span>
            </Button>
          </div>
        ),
        className: "text-right",
      },
    ],
    [serverById]
  );

  const activeCount = (sessions ?? []).filter((s) => s.status === "active").length;
  const totalCount = sessions?.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-mg-text">Sessions</h1>
          <p className="text-sm text-mg-text-tertiary mt-1">
            {activeCount} active · {totalCount} total. View logs, reattach, or close.
          </p>
        </div>
        <Button variant="secondary" onClick={() => refetch()}>
          Refresh
        </Button>
      </div>

      <div className="bg-mg-bg-secondary border border-mg-border rounded-lg">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-mg-text-tertiary text-sm">
            Loading sessions...
          </div>
        ) : (
          <Table
            columns={columns}
            data={sessions ?? []}
            keyExtractor={(s) => s.id}
            emptyMessage="No sessions yet. Open a terminal from the Servers page to start one."
            onRowClick={(s) => handleView(s)}
          />
        )}
      </div>

      <Modal
        open={logsModal !== null}
        onClose={() => setLogsModal(null)}
        title={
          logsModal
            ? `${logsModal.server?.name ?? "Session"} — ${logsModal.session.sessionName}`
            : ""
        }
        footer={
          logsModal && (
            <>
              <Button variant="secondary" onClick={() => setLogsModal(null)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  const s = logsModal.session;
                  setLogsModal(null);
                  handleView(s);
                }}
              >
                Open in Terminal
              </Button>
            </>
          )
        }
      >
        {logsModal && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-mg-text-tertiary uppercase tracking-wider mb-1">Status</div>
                <Badge variant={statusVariant[logsModal.session.status] ?? "default"}>
                  {logsModal.session.status}
                </Badge>
              </div>
              <div>
                <div className="text-mg-text-tertiary uppercase tracking-wider mb-1">CWD</div>
                <div className="font-mono text-mg-text">{logsModal.session.cwd ?? "—"}</div>
              </div>
              <div className="col-span-2">
                <div className="text-mg-text-tertiary uppercase tracking-wider mb-1">
                  Last Command
                </div>
                <div className="font-mono text-mg-text break-all">
                  {logsModal.session.lastCommand || "—"}
                </div>
              </div>
            </div>

            <div>
              <div className="text-xs text-mg-text-tertiary uppercase tracking-wider mb-1">
                Recent Output
              </div>
              <pre className="bg-[#0d0d14] border border-mg-border rounded-md p-3 text-xs font-mono text-mg-text whitespace-pre-wrap max-h-80 overflow-auto">
                {logsModal.session.scrollBufferTail?.trim() || "(no buffered output)"}
              </pre>
              <p className="mt-2 text-[10px] text-mg-text-tertiary">
                Showing the last ~100 lines persisted to disk. Open in Terminal to reattach to the
                live stream.
              </p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
