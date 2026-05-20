"use client";

/**
 * Floating top-right control on the /terminal page that lets the user
 * add the active session to a group (or jump to / leave the group the
 * session is already in).
 *
 * Visibility rules:
 *   - Hidden when the session is part of a stack (stack-bound sessions
 *     are ineligible for groups by design).
 *   - Hidden until the session has a backend id (i.e. the create flow
 *     has resolved — otherwise there's nothing to group yet).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import {
  addGroupMember,
  createGroup,
  removeGroupMember,
  useGroups,
} from "@/lib/hooks/useApi";
import { GROUP_MAX_MEMBERS, type Session } from "@/types";

interface GroupMenuProps {
  session: Session | null;
  /** Called after any successful group mutation so the parent page can
   *  refetch its sessions list (so the membership UI updates immediately). */
  onMutated: () => void;
}

export function GroupMenu({ session, onMutated }: GroupMenuProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { data: groups, refetch: refetchGroups } = useGroups();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close the popover on outside click. We don't trap focus — this is a
  // small auxiliary menu, not a modal.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      setOpen(false);
      setCreating(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const currentGroup = session?.groupId
    ? (groups ?? []).find((g) => g.id === session.groupId)
    : null;
  const sessionGroupId = session?.groupId;
  const eligibleGroups = useMemo(
    () =>
      (groups ?? []).filter(
        (g) => g.id !== sessionGroupId && g.members.length < GROUP_MAX_MEMBERS
      ),
    [groups, sessionGroupId]
  );

  // Hidden when there's no session yet or it's stack-bound. Kept *after*
  // the hooks above so hook order stays stable across renders.
  if (!session) return null;
  if (session.stackId) return null;

  const closeAll = () => {
    setOpen(false);
    setCreating(false);
    setNewName("");
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      toast("Name required", "error");
      return;
    }
    setBusy(true);
    try {
      const g = await createGroup({ name, sessionId: session.id });
      toast(`Created group "${g.name}"`, "success");
      closeAll();
      await refetchGroups();
      onMutated();
      router.push(`/groups/${g.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Create failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async (groupId: string) => {
    setBusy(true);
    try {
      await addGroupMember(groupId, session.id);
      toast("Added to group", "success");
      closeAll();
      await refetchGroups();
      onMutated();
      router.push(`/groups/${groupId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Add failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleLeave = async () => {
    if (!session.groupId) return;
    setBusy(true);
    try {
      await removeGroupMember(session.groupId, session.id);
      toast("Removed from group", "success");
      closeAll();
      await refetchGroups();
      onMutated();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Remove failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleOpenGroup = () => {
    if (!session.groupId) return;
    router.push(`/groups/${session.groupId}`);
  };

  return (
    <div
      ref={popoverRef}
      className="absolute top-2 right-2 z-20 select-none"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 bg-mg-bg-secondary/90 hover:bg-mg-bg-hover border border-mg-border rounded-md px-2.5 py-1 text-xs text-mg-text-secondary hover:text-mg-text transition-colors"
        title={currentGroup ? `In group: ${currentGroup.name}` : "Add to a group"}
      >
        <svg
          className="w-3.5 h-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
        <span>
          {currentGroup ? `Group: ${currentGroup.name}` : "Add to group"}
        </span>
        <svg
          className="w-3 h-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && !creating && (
        <div className="mt-1 min-w-[220px] bg-mg-bg-secondary border border-mg-border rounded-md shadow-lg py-1 text-sm">
          {currentGroup ? (
            <>
              <button
                type="button"
                onClick={handleOpenGroup}
                className="w-full text-left px-3 py-1.5 hover:bg-mg-bg-hover text-mg-text"
              >
                Open group view
              </button>
              <button
                type="button"
                onClick={handleLeave}
                disabled={busy}
                className="w-full text-left px-3 py-1.5 hover:bg-mg-bg-hover text-mg-danger disabled:opacity-50"
              >
                Remove from group
              </button>
            </>
          ) : (
            <>
              {eligibleGroups.length > 0 && (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-mg-text-tertiary">
                    Existing groups
                  </div>
                  {eligibleGroups.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => handleJoin(g.id)}
                      disabled={busy}
                      className="w-full text-left px-3 py-1.5 hover:bg-mg-bg-hover text-mg-text disabled:opacity-50 flex items-center justify-between"
                    >
                      <span className="truncate">{g.name}</span>
                      <span className="text-xs text-mg-text-tertiary ml-2">
                        {g.members.length}/{GROUP_MAX_MEMBERS}
                      </span>
                    </button>
                  ))}
                  <div className="border-t border-mg-border my-1" />
                </>
              )}
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="w-full text-left px-3 py-1.5 hover:bg-mg-bg-hover text-mg-accent"
              >
                + New group…
              </button>
            </>
          )}
        </div>
      )}

      <Modal
        open={open && creating}
        onClose={closeAll}
        title="New group"
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={closeAll} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-mg-text-secondary">
            Creates a group containing this terminal as its first member.
            You can add up to {GROUP_MAX_MEMBERS - 1} more from the group
            view.
          </p>
          <Input
            label="Name"
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
            }}
            placeholder="e.g. dev-cluster"
          />
        </div>
      </Modal>
    </div>
  );
}
