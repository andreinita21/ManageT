"use client";

/**
 * /sessions — central hub for everything terminal-shaped.
 *
 * Three sectioned views on a single page:
 *   1. Terminal sessions       — free-standing shells (no stack, no group).
 *   2. Group Terminal sessions — sessions that belong to a `groups` row,
 *                                rendered grouped by group with a link to
 *                                the mosaic view at /groups/[id].
 *   3. Stacks                  — live stacks (link out to /stacks for
 *                                create/edit/delete management).
 */
import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  addGroupMember,
  createGroup,
  deleteSession,
  removeGroupMember,
  useGroups,
  useServers,
  useSessions,
  useStacks,
} from "@/lib/hooks/useApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Table } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import {
  GROUP_MAX_MEMBERS,
  type Group,
  type Server,
  type Session,
} from "@/types";

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

interface GroupPickerState {
  session: Session;
}

export default function SessionsPage() {
  const router = useRouter();
  const { data: sessions, loading, refetch: refetchSessions } = useSessions();
  const { data: servers } = useServers();
  const { data: groups, refetch: refetchGroups } = useGroups();
  const { data: stacks } = useStacks();
  const { toast } = useToast();

  const [logsModal, setLogsModal] = useState<LogsModalState | null>(null);
  const [groupPicker, setGroupPicker] = useState<GroupPickerState | null>(null);

  // Multi-select on the standalone "Terminal sessions" section. Grouped
  // sessions are intentionally out of scope — see comment near
  // SectionHeader for the standalone section.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkGroupOpen, setBulkGroupOpen] = useState(false);
  const [bulkGroupName, setBulkGroupName] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const serverById = useMemo(() => {
    const map = new Map<string, Server>();
    (servers ?? []).forEach((s) => map.set(s.id, s));
    return map;
  }, [servers]);

  const standaloneSessions = useMemo(
    () =>
      (sessions ?? []).filter(
        (s) => !s.stackId && !s.groupId && s.status !== "closed"
      ),
    [sessions]
  );

  // Flat list of every session the multi-select toolbar covers — free
  // terminals plus members of every group. Stack-bound sessions are
  // out (they have their own management page). Drives select-all and
  // the "X selected" count.
  const allSelectableSessions = useMemo(() => {
    const grouped = (sessions ?? []).filter(
      (s) => s.groupId && s.status !== "closed"
    );
    return [...standaloneSessions, ...grouped];
  }, [standaloneSessions, sessions]);

  const groupedSessions = useMemo(() => {
    const result: Array<{ group: Group; sessions: Session[] }> = [];
    for (const g of groups ?? []) {
      const members = (sessions ?? [])
        .filter((s) => s.groupId === g.id)
        .sort((a, b) => (a.groupOrderIndex ?? 0) - (b.groupOrderIndex ?? 0));
      result.push({ group: g, sessions: members });
    }
    return result;
  }, [groups, sessions]);

  const handleClose = async (session: Session) => {
    if (!confirm(`Close session "${session.sessionName}"? The remote shell will be killed.`)) {
      return;
    }
    try {
      await deleteSession(session.id);
      toast(`Closed ${session.sessionName}`, "success");
      refetchSessions();
      refetchGroups();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Close failed";
      toast(msg, "error");
    }
  };

  /** Pulls the server's current agentStatus and returns a friendly
   *  reason string when the operator can't open a terminal on it.
   *  Null means "go ahead". Kept inline (small + only used here) to
   *  avoid a separate util file. */
  const blockedReasonForServer = (serverId: string): string | null => {
    const srv = serverById.get(serverId);
    if (!srv) return null;
    if (srv.agentStatus === "manually_stopped") {
      return (
        "Server is currently stopped (via `managet stop`). Run " +
        "`managet start` on the host to resume."
      );
    }
    if (
      srv.agentStatus === "not_installed" ||
      srv.agentStatus === "installing" ||
      srv.agentStatus === "install_failed" ||
      srv.agentStatus === "uninstalling" ||
      srv.agentStatus === "uninstall_failed"
    ) {
      return `Agent is '${srv.agentStatus}'; terminal is unavailable until it's healthy.`;
    }
    return null;
  };

  const handleView = (session: Session) => {
    const reason = blockedReasonForServer(session.serverId);
    if (reason) {
      toast(reason, "warning");
      return;
    }
    router.push(`/terminal?session=${session.id}`);
  };

  const handleBulkClose = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (
      !confirm(
        `Close ${ids.length} session${ids.length === 1 ? "" : "s"}? Each remote shell will be killed.`
      )
    )
      return;
    setBulkBusy(true);
    try {
      // Fire all deletes in parallel — they hit different sessions and
      // the agent fan-out is independent per server. Use allSettled so
      // a single slow/failed kill doesn't block the others.
      const results = await Promise.allSettled(
        ids.map((id) => deleteSession(id))
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed === 0) {
        toast(`Closed ${ids.length} session${ids.length === 1 ? "" : "s"}`, "success");
      } else {
        toast(`Closed ${ids.length - failed} of ${ids.length} (${failed} failed)`, "error");
      }
      exitSelectMode();
      refetchSessions();
      refetchGroups();
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkGroup = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (ids.length > GROUP_MAX_MEMBERS) {
      toast(
        `Group cap is ${GROUP_MAX_MEMBERS} terminals — selected ${ids.length}`,
        "error"
      );
      return;
    }
    const name = bulkGroupName.trim();
    if (!name) {
      toast("Group name is required", "error");
      return;
    }

    // Pre-flight: any selected session that's currently in another group
    // has to leave it first — one-group-per-session is enforced
    // server-side. We do the detaches sequentially so a per-session
    // failure surfaces cleanly; on failure we abort before creating the
    // new group (otherwise the user ends up with a half-empty group).
    const stalest = sessions ?? [];
    const idToSession = new Map(stalest.map((s) => [s.id, s]));
    const toDetach = ids
      .map((id) => idToSession.get(id))
      .filter(
        (s): s is Session => Boolean(s && s.groupId)
      );

    setBulkBusy(true);
    try {
      for (const s of toDetach) {
        if (!s.groupId) continue;
        await removeGroupMember(s.groupId, s.id);
      }
      // Atomic-ish flow: createGroup makes a group with the first
      // session in one round-trip; the rest are added sequentially so
      // we can surface a precise "X added, Y failed" if any fail.
      const [firstId, ...rest] = ids;
      const group = await createGroup({ name, sessionId: firstId });
      const addResults = await Promise.allSettled(
        rest.map((sid) => addGroupMember(group.id, sid))
      );
      const failed = addResults.filter((r) => r.status === "rejected").length;
      const detachNote =
        toDetach.length > 0
          ? ` (${toDetach.length} moved from another group)`
          : "";
      toast(
        failed === 0
          ? `Created "${group.name}" with ${ids.length} terminal${ids.length === 1 ? "" : "s"}${detachNote}`
          : `Created "${group.name}" with ${ids.length - failed} of ${ids.length}${detachNote} (${failed} failed to attach)`,
        failed === 0 ? "success" : "error"
      );
      setBulkGroupOpen(false);
      setBulkGroupName("");
      exitSelectMode();
      refetchSessions();
      refetchGroups();
      router.push(`/groups/${group.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Group creation failed", "error");
    } finally {
      setBulkBusy(false);
    }
  };

  const handleRemoveFromGroup = async (session: Session) => {
    if (!session.groupId) return;
    try {
      await removeGroupMember(session.groupId, session.id);
      toast("Removed from group", "success");
      refetchSessions();
      refetchGroups();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Remove failed", "error");
    }
  };

  const standaloneColumns = [
      // Checkbox column — only rendered while select mode is on. The
      // header doubles as a select-all toggle that flips between
      // "all selected" and "none selected" for the visible rows.
      ...(selectMode
        ? [
            {
              key: "_select",
              header: "",
              className: "w-10",
              render: (s: Session) => (
                <input
                  type="checkbox"
                  checked={selectedIds.has(s.id)}
                  onChange={() => toggleSelected(s.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="accent-mg-accent w-4 h-4 cursor-pointer"
                  aria-label={`Select ${s.sessionName}`}
                />
              ),
            },
          ]
        : []),
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
          <div className="flex items-center justify-end gap-1">
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
                setGroupPicker({ session: s });
              }}
              title="Add this terminal to a group"
            >
              Group
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
              <span className="text-mg-danger">Close</span>
            </Button>
          </div>
        ),
        className: "text-right",
      },
    ];

  const groupedColumns = [
      // Same checkbox-column-only-while-selecting trick as the
      // standalone table. Selection works across both sections so
      // bulk-close / bulk-move covers the user's full session list.
      ...(selectMode
        ? [
            {
              key: "_select",
              header: "",
              className: "w-10",
              render: (s: Session) => (
                <input
                  type="checkbox"
                  checked={selectedIds.has(s.id)}
                  onChange={() => toggleSelected(s.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="accent-mg-accent w-4 h-4 cursor-pointer"
                  aria-label={`Select ${s.sessionName}`}
                />
              ),
            },
          ]
        : []),
      {
        key: "slot",
        header: "#",
        render: (s: Session) => (
          <span className="font-mono text-mg-accent">
            {(s.groupOrderIndex ?? 0) + 1}
          </span>
        ),
      },
      {
        key: "name",
        header: "Session",
        render: (s: Session) => (
          <span className="font-mono text-mg-text">{s.sessionName}</span>
        ),
      },
      {
        key: "server",
        header: "Server",
        render: (s: Session) => {
          const server = serverById.get(s.serverId);
          return (
            <span className="text-sm text-mg-text">
              {server?.name ?? "—"}
            </span>
          );
        },
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
          <div className="flex items-center justify-end gap-1">
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
                handleRemoveFromGroup(s);
              }}
            >
              Remove
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleClose(s);
              }}
            >
              <span className="text-mg-danger">Close</span>
            </Button>
          </div>
        ),
        className: "text-right",
      },
    ];

  const activeStandaloneCount = standaloneSessions.filter(
    (s) => s.status === "active"
  ).length;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-mg-text">Sessions</h1>
          <p className="text-sm text-mg-text-tertiary mt-1">
            {activeStandaloneCount} active free terminal
            {activeStandaloneCount === 1 ? "" : "s"} ·{" "}
            {(groups ?? []).length} group
            {(groups ?? []).length === 1 ? "" : "s"} ·{" "}
            {(stacks ?? []).length} stack
            {(stacks ?? []).length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!selectMode && allSelectableSessions.length > 0 && (
            <Button
              variant="secondary"
              onClick={() => setSelectMode(true)}
            >
              Select
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              refetchSessions();
              refetchGroups();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Multi-select toolbar — sticky-feeling bar at the page top
          spanning both sections. Selection IDs can come from either
          the standalone or any group's table; bulk Close kills via
          deleteSession (which already auto-cleans empty groups), and
          bulk "Group as…" detaches any currently-grouped sessions
          first before creating the new group. */}
      {selectMode && (
        <div className="flex items-center justify-between gap-3 bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2 -mt-4">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={
                selectedIds.size > 0 &&
                selectedIds.size === allSelectableSessions.length
              }
              ref={(el) => {
                // Indeterminate when some-but-not-all selected. Has to
                // be set imperatively — no React prop for it. `el`
                // can be null during unmount.
                if (el)
                  el.indeterminate =
                    selectedIds.size > 0 &&
                    selectedIds.size < allSelectableSessions.length;
              }}
              onChange={(e) => {
                if (e.target.checked) {
                  setSelectedIds(
                    new Set(allSelectableSessions.map((s) => s.id))
                  );
                } else {
                  setSelectedIds(new Set());
                }
              }}
              className="accent-mg-accent w-4 h-4 cursor-pointer"
              aria-label="Select all terminals"
            />
            <span className="text-sm text-mg-text">
              {selectedIds.size === 0
                ? "Select terminals…"
                : `${selectedIds.size} selected`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (selectedIds.size === 0) return;
                if (selectedIds.size > GROUP_MAX_MEMBERS) {
                  toast(
                    `Group cap is ${GROUP_MAX_MEMBERS} terminals — pick fewer`,
                    "error"
                  );
                  return;
                }
                setBulkGroupName("");
                setBulkGroupOpen(true);
              }}
              disabled={selectedIds.size === 0 || bulkBusy}
              title={
                selectedIds.size > GROUP_MAX_MEMBERS
                  ? `Group cap is ${GROUP_MAX_MEMBERS} terminals`
                  : "Create a new group containing the selected terminals"
              }
            >
              Group as…
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleBulkClose}
              disabled={selectedIds.size === 0 || bulkBusy}
            >
              <span className="text-mg-danger">
                Close {selectedIds.size > 0 ? selectedIds.size : ""}
              </span>
            </Button>
            <Button size="sm" variant="ghost" onClick={exitSelectMode}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* --- Section 1: free-standing terminal sessions --- */}
      <section>
        <SectionHeader
          title="Terminal sessions"
          subtitle="Standalone shells, not in a group or stack."
        />
        <div className="bg-mg-bg-secondary border border-mg-border rounded-lg">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-mg-text-tertiary text-sm">
              Loading sessions...
            </div>
          ) : (
            <Table
              columns={standaloneColumns}
              data={standaloneSessions}
              keyExtractor={(s) => s.id}
              emptyMessage="No free terminals. Open one from the Servers page, or look in a group/stack below."
              onRowClick={(s) =>
                selectMode ? toggleSelected(s.id) : handleView(s)
              }
            />
          )}
        </div>
      </section>

      {/* --- Section 2: groups --- */}
      <section>
        <SectionHeader
          title="Group Terminal sessions"
          subtitle="Up to 6 terminals laid out side-by-side. Click a group to open its mosaic."
        />
        {groupedSessions.length === 0 ? (
          <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-6 text-sm text-mg-text-tertiary">
            No groups yet. Open a free terminal and use the &ldquo;Add to
            group&rdquo; menu in its top-right corner to create one.
          </div>
        ) : (
          <div className="space-y-4">
            {groupedSessions.map(({ group, sessions: members }) => (
              <div
                key={group.id}
                className="bg-mg-bg-secondary border border-mg-border rounded-lg overflow-hidden"
              >
                <div className="flex items-center justify-between px-4 py-2 bg-mg-bg-tertiary border-b border-mg-border">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => router.push(`/groups/${group.id}`)}
                      className="text-mg-text font-medium hover:text-mg-accent transition-colors"
                    >
                      {group.name}
                    </button>
                    <span className="text-xs text-mg-text-tertiary">
                      {members.length}/{GROUP_MAX_MEMBERS} terminals
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => router.push(`/groups/${group.id}`)}
                  >
                    Open mosaic →
                  </Button>
                </div>
                <Table
                  columns={groupedColumns}
                  data={members}
                  keyExtractor={(s) => s.id}
                  emptyMessage="Empty group — it should have been auto-cleaned. Refresh."
                  onRowClick={(s) =>
                    selectMode ? toggleSelected(s.id) : handleView(s)
                  }
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* --- Section 3: stacks (read-only, manage on /stacks) --- */}
      <section>
        <SectionHeader
          title="Stacks"
          subtitle="Launch-together service bundles. Manage on the Stacks page."
          action={
            <Button size="sm" onClick={() => router.push("/stacks")}>
              Manage stacks →
            </Button>
          }
        />
        {(stacks ?? []).length === 0 ? (
          <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-6 text-sm text-mg-text-tertiary">
            No stacks defined.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {(stacks ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => router.push(`/stacks`)}
                className="text-left bg-mg-bg-secondary border border-mg-border rounded-lg p-4 hover:border-mg-accent transition-all"
              >
                <div className="text-mg-text font-medium">{s.name}</div>
                {s.description && (
                  <div className="text-xs text-mg-text-tertiary mt-1 line-clamp-2">
                    {s.description}
                  </div>
                )}
                <div className="text-xs text-mg-text-tertiary mt-2">
                  {s.services.length} service
                  {s.services.length === 1 ? "" : "s"}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* --- Logs modal --- */}
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
            </div>
          </div>
        )}
      </Modal>

      {/* --- Bulk "Group as…" modal (multi-select Group action) --- */}
      <Modal
        open={bulkGroupOpen}
        onClose={() => {
          if (!bulkBusy) {
            setBulkGroupOpen(false);
            setBulkGroupName("");
          }
        }}
        title={`Group ${selectedIds.size} terminal${selectedIds.size === 1 ? "" : "s"}`}
        size="md"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setBulkGroupOpen(false);
                setBulkGroupName("");
              }}
              disabled={bulkBusy}
            >
              Cancel
            </Button>
            <Button onClick={handleBulkGroup} disabled={bulkBusy}>
              {bulkBusy ? "Creating…" : "Create group"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-mg-text-secondary">
            Creates a new group containing the {selectedIds.size} selected
            terminal{selectedIds.size === 1 ? "" : "s"} as its members.
          </p>
          <Input
            label="Group name"
            autoFocus
            value={bulkGroupName}
            onChange={(e) => setBulkGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !bulkBusy) void handleBulkGroup();
            }}
            placeholder="e.g. dev-cluster"
          />
        </div>
      </Modal>

      {/* --- Group picker modal (per-row "Group" button) --- */}
      <GroupPickerModal
        state={groupPicker}
        groups={groups ?? []}
        onClose={() => setGroupPicker(null)}
        onAddExisting={async (groupId) => {
          if (!groupPicker) return;
          try {
            await addGroupMember(groupId, groupPicker.session.id);
            toast("Added to group", "success");
            setGroupPicker(null);
            refetchSessions();
            refetchGroups();
            router.push(`/groups/${groupId}`);
          } catch (err) {
            toast(err instanceof Error ? err.message : "Add failed", "error");
          }
        }}
        onCreate={async (name) => {
          if (!groupPicker) return;
          try {
            const g = await createGroup({
              name,
              sessionId: groupPicker.session.id,
            });
            toast(`Created group "${g.name}"`, "success");
            setGroupPicker(null);
            refetchSessions();
            refetchGroups();
            router.push(`/groups/${g.id}`);
          } catch (err) {
            toast(err instanceof Error ? err.message : "Create failed", "error");
          }
        }}
      />
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-3">
      <div>
        <h2 className="text-base font-semibold text-mg-text">{title}</h2>
        {subtitle && (
          <p className="text-xs text-mg-text-tertiary mt-0.5">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

function GroupPickerModal({
  state,
  groups,
  onClose,
  onAddExisting,
  onCreate,
}: {
  state: GroupPickerState | null;
  groups: Group[];
  onClose: () => void;
  onAddExisting: (groupId: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  // Reset internal state whenever the picker is reopened for a different
  // session, so leftover input doesn't carry over.
  React.useEffect(() => {
    if (!state) {
      setCreating(false);
      setName("");
    }
  }, [state]);

  const eligible = groups.filter((g) => g.members.length < GROUP_MAX_MEMBERS);

  return (
    <Modal
      open={state !== null}
      onClose={onClose}
      title={
        state ? `Add "${state.session.sessionName}" to a group` : "Add to group"
      }
      size="md"
      footer={
        creating ? (
          <>
            <Button
              variant="secondary"
              onClick={() => setCreating(false)}
            >
              Back
            </Button>
            <Button
              onClick={() => {
                const n = name.trim();
                if (n) void onCreate(n);
              }}
            >
              Create
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      {creating ? (
        <Input
          label="Group name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const n = name.trim();
              if (n) void onCreate(n);
            }
          }}
        />
      ) : (
        <div className="space-y-3">
          {eligible.length > 0 && (
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {eligible.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => void onAddExisting(g.id)}
                  className="w-full text-left bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2 hover:border-mg-accent transition-all flex items-center justify-between"
                >
                  <span className="text-sm text-mg-text">{g.name}</span>
                  <span className="text-xs text-mg-text-tertiary">
                    {g.members.length}/{GROUP_MAX_MEMBERS}
                  </span>
                </button>
              ))}
            </div>
          )}
          <Button
            variant="secondary"
            onClick={() => setCreating(true)}
            className="w-full"
          >
            + New group…
          </Button>
        </div>
      )}
    </Modal>
  );
}
