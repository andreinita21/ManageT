"use client";

/**
 * /groups/[id] — the group mosaic view.
 *
 * Renders up to 6 attached terminals in a 3-per-row layout (max 2 rows).
 * The row heights and the column widths inside each row are draggable
 * and persisted per user. Members can be reordered by drag-and-drop:
 * during a drag the panes are blurred and each slot shows its big
 * position number so it's obvious where you're dropping.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  addGroupMember,
  deleteGroup,
  deleteSession,
  removeGroupMember,
  renameGroup,
  updateSession,
  useGroup,
  useServers,
  useSessions,
} from "@/lib/hooks/useApi";
import { GROUP_MAX_MEMBERS, type Server, type Session } from "@/types";

import { GroupMosaic, type GroupMosaicHandle } from "./GroupMosaic";
import {
  LayoutPicker,
  ServerResourceStrip,
} from "./GroupHeaderWidgets";

export default function GroupPage() {
  const params = useParams<{ id: string }>();
  const groupId = params.id;
  const router = useRouter();
  const { toast } = useToast();

  const { data: group, loading, refetch: refetchGroup } = useGroup(groupId);
  const { data: sessions, refetch: refetchSessions } = useSessions();
  const { data: servers } = useServers();

  const [addOpen, setAddOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);

  const serversById = useMemo(() => {
    const m = new Map<string, Server>();
    (servers ?? []).forEach((s) => m.set(s.id, s));
    return m;
  }, [servers]);

  // The group view exists to display ≥1 terminal. If the page is loaded
  // for a group that has been auto-cleaned (last member detached), bounce
  // back to the Sessions hub rather than showing an empty mosaic.
  useEffect(() => {
    if (!loading && group === null) {
      toast("This group no longer exists", "info");
      router.replace("/sessions");
    }
  }, [loading, group, router, toast]);

  // Open the rename modal pre-populated with the current name.
  useEffect(() => {
    if (renaming && group) setRenameValue(group.name);
  }, [renaming, group]);

  const handleRename = async () => {
    if (!group) return;
    const name = renameValue.trim();
    if (!name || name === group.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    try {
      await renameGroup(group.id, name);
      toast("Renamed", "success");
      setRenaming(false);
      await refetchGroup();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Rename failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteGroup = async () => {
    if (!group) return;
    const count = group.members.length;
    if (
      !confirm(
        `Delete group "${group.name}" and close ${count} terminal${count === 1 ? "" : "s"}? The remote shell${count === 1 ? "" : "s"} will be killed.`
      )
    )
      return;
    setBusy(true);
    try {
      // Kill every member in parallel. `deleteSession` runs through
      // `killSession` on the server which:
      //   1. asks the agent to SIGTERM the PTY,
      //   2. drops the DB row,
      //   3. calls cleanupEmptyGroupIfNeeded — once the last member
      //      goes the group row is auto-deleted, so we typically don't
      //      need the explicit `deleteGroup` below. The explicit call
      //      remains as a belt-and-braces for the rare case where the
      //      group somehow survived (e.g. all kills failed). It's a
      //      no-op when the row is already gone.
      // allSettled because one stuck agent shouldn't block the others.
      const results = await Promise.allSettled(
        group.members.map((m) => deleteSession(m.id))
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      try {
        await deleteGroup(group.id);
      } catch {
        // Group was already auto-cleaned by the killSession cascade —
        // expected on the happy path.
      }
      toast(
        failed === 0
          ? `Closed ${count} terminal${count === 1 ? "" : "s"} and deleted group`
          : `Deleted group; closed ${count - failed} of ${count} (${failed} failed)`,
        failed === 0 ? "success" : "error"
      );
      router.push("/sessions");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (sessionId: string) => {
    if (!group) return;
    try {
      const res = await removeGroupMember(group.id, sessionId);
      toast("Removed from group", "success");
      if (res.groupDeleted) {
        router.push("/sessions");
        return;
      }
      await refetchGroup();
      await refetchSessions();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Remove failed", "error");
    }
  };

  const handleRenameMember = async (sessionId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await updateSession(sessionId, { sessionName: trimmed });
      // Refetch both — the group view shows the bar name (from group
      // members) and Sessions hub uses the list. Failing to refresh
      // would leave the bar showing the old name despite the DB
      // already having the new one.
      await refetchGroup();
      await refetchSessions();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Rename failed", "error");
    }
  };

  const mosaicRef = useRef<GroupMosaicHandle>(null);
  const handleBumpAllFont = (delta: number) => {
    mosaicRef.current?.bumpAll(delta);
  };

  // Which server's resource tile is currently being hovered in the
  // header. Drives the translucent accent overlay over the matching
  // cells in the mosaic.
  const [highlightServerId, setHighlightServerId] = useState<string | null>(null);

  // Unique servers backing this group's members, in first-appearance
  // order so the strip's tile order stays stable across renders.
  const uniqueServers = useMemo(() => {
    if (!group) return [] as Server[];
    const seen = new Set<string>();
    const out: Server[] = [];
    for (const m of group.members) {
      if (seen.has(m.serverId)) continue;
      const s = serversById.get(m.serverId);
      if (!s) continue;
      seen.add(m.serverId);
      out.push(s);
    }
    return out;
  }, [group, serversById]);

  // Active row arrangement, sourced from GroupMosaic via callback. The
  // mosaic owns the layout state (so its persistence debounce works);
  // we just mirror the partition here so the LayoutPicker's "active"
  // highlight stays in sync.
  const [currentPartition, setCurrentPartition] = useState<number[] | null>(null);

  if (loading || !group) {
    return (
      <div className="flex items-center justify-center h-full text-mg-text-tertiary text-sm">
        Loading group…
      </div>
    );
  }

  const memberIds = new Set(group.members.map((m) => m.id));
  const freeSessions = (sessions ?? []).filter(
    (s) =>
      !s.stackId &&
      (!s.groupId || s.groupId === group.id) &&
      !memberIds.has(s.id) &&
      s.status !== "closed"
  );
  const atCap = group.members.length >= GROUP_MAX_MEMBERS;

  return (
    <div className="flex flex-col h-full">

      <div className="flex items-center gap-3 border-b border-mg-border bg-mg-bg-secondary px-4 py-2 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0 shrink-0">
          <button
            type="button"
            onClick={() => router.push("/sessions")}
            className="text-mg-text-tertiary hover:text-mg-text text-sm"
          >
            ← Sessions
          </button>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-mg-text truncate">
              {group.name}
            </h1>
            <p className="text-xs text-mg-text-tertiary">
              {group.members.length}/{GROUP_MAX_MEMBERS} terminal
              {group.members.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        {/* Per-server resource tiles. Sits between the title and the
            action buttons, filling the previously-empty header space.
            Hovering a tile highlights the matching terminals via the
            translucent accent overlay rendered by GroupMosaic. */}
        <div className="flex-1 min-w-0 px-2">
          <ServerResourceStrip
            servers={uniqueServers}
            onHover={setHighlightServerId}
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <LayoutPicker
            memberCount={group.members.length}
            current={currentPartition}
            onPick={(p) => mosaicRef.current?.setRowPartition(p)}
          />
          {/* Group-wide font bump — only shown once the layout opens a
              second row (≥4 members), where individual panes start
              feeling cramped and a single sweep is easier than nudging
              each pane in turn. */}
          {group.members.length >= 4 && (
            <div
              className="flex items-center gap-1 border border-mg-border rounded-md px-1 py-0.5 mr-1"
              title="Adjust font size on every terminal in this group"
            >
              <button
                type="button"
                onClick={() => handleBumpAllFont(-1)}
                className="w-6 h-6 flex items-center justify-center rounded text-mg-text-secondary hover:text-mg-text hover:bg-mg-bg-hover text-sm leading-none"
                aria-label="Decrease font size on all terminals"
              >
                −
              </button>
              <span className="text-[10px] text-mg-text-tertiary px-1">
                Aa
              </span>
              <button
                type="button"
                onClick={() => handleBumpAllFont(1)}
                className="w-6 h-6 flex items-center justify-center rounded text-mg-text-secondary hover:text-mg-text hover:bg-mg-bg-hover text-sm leading-none"
                aria-label="Increase font size on all terminals"
              >
                +
              </button>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRenaming(true)}
          >
            Rename
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDeleteGroup}
            disabled={busy}
          >
            <span className="text-mg-danger">Delete group</span>
          </Button>
          <Button
            onClick={() => setAddOpen(true)}
            size="sm"
            disabled={atCap}
            title={
              atCap
                ? `Groups are capped at ${GROUP_MAX_MEMBERS} terminals`
                : "Add terminal to this group"
            }
          >
            + Add terminal
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <GroupMosaic
          ref={mosaicRef}
          group={group}
          serversById={serversById}
          onReorderPersisted={refetchGroup}
          onRemoveMember={handleRemoveMember}
          onRenameMember={handleRenameMember}
          highlightServerId={highlightServerId}
          onPartitionChange={setCurrentPartition}
        />
      </div>

      <AddMemberModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        freeSessions={freeSessions}
        servers={servers ?? []}
        atCap={atCap}
        onAddExisting={async (sessionId) => {
          setBusy(true);
          try {
            await addGroupMember(group.id, sessionId);
            toast("Added to group", "success");
            setAddOpen(false);
            await refetchGroup();
            await refetchSessions();
          } catch (err) {
            toast(err instanceof Error ? err.message : "Add failed", "error");
          } finally {
            setBusy(false);
          }
        }}
        onLaunchNew={async (serverId) => {
          setBusy(true);
          try {
            // Launch the session, then attach it to the group. The two
            // calls aren't atomic; in the rare case the second one fails
            // the user still has a usable free terminal and a clear
            // error toast — they can retry the add from the menu.
            const res = await fetch(`/api/servers/${serverId}/sessions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const json = await res.json();
            const newSession = (json.data ?? json) as Session;
            await addGroupMember(group.id, newSession.id);
            toast("Launched and added", "success");
            setAddOpen(false);
            await refetchGroup();
            await refetchSessions();
          } catch (err) {
            toast(err instanceof Error ? err.message : "Launch failed", "error");
          } finally {
            setBusy(false);
          }
        }}
      />

      <Modal
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename group"
        size="md"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setRenaming(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <Input
          label="Name"
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleRename();
          }}
        />
      </Modal>
    </div>
  );
}

interface AddMemberModalProps {
  open: boolean;
  onClose: () => void;
  freeSessions: Session[];
  servers: { id: string; name: string; host: string }[];
  atCap: boolean;
  onAddExisting: (sessionId: string) => Promise<void>;
  onLaunchNew: (serverId: string) => Promise<void>;
}

function AddMemberModal({
  open,
  onClose,
  freeSessions,
  servers,
  atCap,
  onAddExisting,
  onLaunchNew,
}: AddMemberModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Add terminal" size="lg">
      {atCap ? (
        <p className="text-sm text-mg-text-secondary">
          This group is already at the {GROUP_MAX_MEMBERS}-terminal cap.
          Remove a member first.
        </p>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="text-xs text-mg-text-tertiary mb-2 uppercase tracking-wide">
              Pick an existing free terminal
            </p>
            {freeSessions.length === 0 ? (
              <div className="text-sm text-mg-text-secondary bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2">
                No free standalone terminals available.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {freeSessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => void onAddExisting(s.id)}
                    className="w-full text-left bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2 hover:border-mg-accent hover:bg-mg-bg-hover transition-all"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-mg-text font-mono">
                        {s.sessionName}
                      </span>
                      <span className="text-xs text-mg-text-tertiary">
                        {s.status}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs text-mg-text-tertiary mb-2 uppercase tracking-wide">
              Or launch a new one on a server
            </p>
            {servers.length === 0 ? (
              <div className="text-sm text-mg-text-secondary bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2">
                No servers configured.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {servers.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => void onLaunchNew(s.id)}
                    className="w-full text-left bg-mg-bg-tertiary border border-mg-border rounded-lg px-3 py-2 hover:border-mg-accent hover:bg-mg-bg-hover transition-all"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-mg-text">{s.name}</span>
                      <span className="text-xs text-mg-text-tertiary font-mono">
                        {s.host}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
