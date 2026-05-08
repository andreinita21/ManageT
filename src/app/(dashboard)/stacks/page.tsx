"use client";

/**
 * /stacks — define and launch multi-server command stacks.
 *
 * A stack is a named bundle of (server, command) tuples. Pressing
 * "Launch" fans out across all listed servers in parallel, opening one
 * agent session per service. Each session is tagged with the stack's
 * id so "Stop" can SIGTERM them all in a single click.
 *
 * The PTYs live inside the per-host agent (see
 * `src/lib/ssh/agent-socket.ts`), so the dashboard isn't holding open
 * any state — closing this page does nothing to the running services.
 *
 * Trash: deleting a stack soft-deletes it (sets `deletedAt`). The Trash
 * view lists those rows with Restore and Delete-forever actions, so an
 * accidental click on Delete doesn't lose a multi-host config.
 */

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  createStack,
  deleteStack,
  launchStack,
  restoreStack,
  stopStack,
  updateStack,
  useServers,
  useStacks,
  useTrashedStacks,
} from "@/lib/hooks/useApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Table } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import type { CreateStackServiceInput, Server, Stack } from "@/types";

type View = "active" | "trash";

interface DraftService extends CreateStackServiceInput {
  /** Local key for React; stripped before submit. */
  key: string;
}

interface DraftStack {
  /** Empty when creating; the existing stack id when editing. */
  id?: string;
  name: string;
  description: string;
  services: DraftService[];
}

const EMPTY_DRAFT: DraftStack = {
  name: "",
  description: "",
  services: [
    { key: "svc-1", name: "", serverId: "", command: "", cwd: "" },
  ],
};

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function StacksPage() {
  const router = useRouter();
  const { data: activeStacks, refetch: refetchActive, loading: loadingActive } = useStacks();
  const { data: trashedStacks, refetch: refetchTrash, loading: loadingTrash } = useTrashedStacks();
  const { data: servers } = useServers();
  const { toast } = useToast();

  const [view, setView] = useState<View>("active");
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<DraftStack>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);

  const refetch = () => {
    refetchActive();
    refetchTrash();
  };

  const serversById = useMemo(() => {
    const m = new Map<string, Server>();
    (servers ?? []).forEach((s) => m.set(s.id, s));
    return m;
  }, [servers]);

  const openCreate = () => {
    setDraft({
      ...EMPTY_DRAFT,
      services: [{ key: newKey(), name: "", serverId: "", command: "", cwd: "" }],
    });
    setEditorOpen(true);
  };

  const openEdit = (stack: Stack) => {
    setDraft({
      id: stack.id,
      name: stack.name,
      description: stack.description ?? "",
      services: stack.services.map((s) => ({
        key: newKey(),
        name: s.name,
        serverId: s.serverId,
        command: s.command ?? "",
        cwd: s.cwd ?? "",
      })),
    });
    setEditorOpen(true);
  };

  const submit = async () => {
    if (!draft.name.trim()) {
      toast("Stack name is required", "error");
      return;
    }
    if (draft.services.length === 0) {
      toast("A stack needs at least one service", "error");
      return;
    }
    for (const svc of draft.services) {
      if (!svc.name.trim()) {
        toast("Each service needs a name", "error");
        return;
      }
      if (!svc.serverId) {
        toast(`Service "${svc.name || "?"}" has no server selected`, "error");
        return;
      }
    }

    setSubmitting(true);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        services: draft.services.map<CreateStackServiceInput>((s) => ({
          name: s.name.trim(),
          serverId: s.serverId,
          command: s.command?.trim() || undefined,
          cwd: s.cwd?.trim() || undefined,
        })),
      };
      if (draft.id) {
        await updateStack(draft.id, payload);
        toast("Stack updated", "success");
      } else {
        await createStack(payload);
        toast("Stack created", "success");
      }
      setEditorOpen(false);
      refetch();
    } catch (err) {
      const m = err instanceof Error ? err.message : "Save failed";
      toast(m, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleLaunch = async (stack: Stack) => {
    try {
      const result = await launchStack(stack.id);
      if (result.failed.length === 0) {
        toast(`Launched ${result.launched.length} service(s)`, "success");
      } else if (result.launched.length === 0) {
        toast(`All ${result.failed.length} services failed to launch`, "error");
      } else {
        toast(
          `Launched ${result.launched.length}, ${result.failed.length} failed`,
          "warning"
        );
      }
      refetch();
      router.push("/sessions");
    } catch (err) {
      const m = err instanceof Error ? err.message : "Launch failed";
      toast(m, "error");
    }
  };

  const handleStop = async (stack: Stack) => {
    if (!confirm(`Stop all sessions launched from "${stack.name}"?`)) return;
    try {
      const result = await stopStack(stack.id);
      toast(`Stopped ${result.stopped} session(s)`, "success");
      refetch();
    } catch (err) {
      const m = err instanceof Error ? err.message : "Stop failed";
      toast(m, "error");
    }
  };

  const handleSoftDelete = async (stack: Stack) => {
    if (
      !confirm(
        `Move stack "${stack.name}" to Trash? Running sessions are NOT stopped — recover from the Trash tab.`
      )
    ) {
      return;
    }
    try {
      await deleteStack(stack.id);
      toast(`Moved to Trash`, "success");
      refetch();
    } catch (err) {
      const m = err instanceof Error ? err.message : "Delete failed";
      toast(m, "error");
    }
  };

  const handleRestore = async (stack: Stack) => {
    try {
      await restoreStack(stack.id);
      toast(`Restored "${stack.name}"`, "success");
      refetch();
    } catch (err) {
      const m = err instanceof Error ? err.message : "Restore failed";
      toast(m, "error");
    }
  };

  const handleHardDelete = async (stack: Stack) => {
    if (
      !confirm(
        `Permanently delete "${stack.name}"? This cannot be undone. Already-running sessions will keep running but won't be linked to a stack.`
      )
    ) {
      return;
    }
    try {
      await deleteStack(stack.id, { force: true });
      toast(`Deleted "${stack.name}" permanently`, "success");
      refetch();
    } catch (err) {
      const m = err instanceof Error ? err.message : "Delete failed";
      toast(m, "error");
    }
  };

  // ----- columns -----

  const activeColumns = useMemo(
    () => [
      {
        key: "name",
        header: "Stack",
        render: (s: Stack) => (
          <div className="flex flex-col">
            <span className="text-mg-text font-medium">{s.name}</span>
            {s.description && (
              <span className="text-xs text-mg-text-tertiary">{s.description}</span>
            )}
          </div>
        ),
      },
      {
        key: "services",
        header: "Services",
        render: (s: Stack) => (
          <div className="flex flex-wrap gap-1.5 max-w-xl">
            {s.services.map((svc) => {
              const server = serversById.get(svc.serverId);
              return (
                <Badge key={svc.id} variant="default">
                  <span className="font-mono text-xs">
                    {svc.name} → {server?.name ?? svc.serverId.slice(0, 6)}
                  </span>
                </Badge>
              );
            })}
          </div>
        ),
      },
      {
        key: "actions",
        header: "",
        className: "text-right",
        render: (s: Stack) => (
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleLaunch(s);
              }}
            >
              Launch
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleStop(s);
              }}
            >
              Stop
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                openEdit(s);
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleSoftDelete(s);
              }}
            >
              <span className="text-red-400">Delete</span>
            </Button>
          </div>
        ),
      },
    ],
    [serversById]
  );

  const trashColumns = useMemo(
    () => [
      {
        key: "name",
        header: "Stack",
        render: (s: Stack) => (
          <div className="flex flex-col">
            <span className="text-mg-text font-medium">{s.name}</span>
            {s.description && (
              <span className="text-xs text-mg-text-tertiary">{s.description}</span>
            )}
          </div>
        ),
      },
      {
        key: "deletedAt",
        header: "Trashed",
        render: (s: Stack) => (
          <span className="text-xs text-mg-text-secondary">
            {s.deletedAt ? new Date(s.deletedAt).toLocaleString() : "—"}
          </span>
        ),
      },
      {
        key: "services",
        header: "Services",
        render: (s: Stack) => (
          <span className="text-xs text-mg-text-tertiary">
            {s.services.length} service{s.services.length === 1 ? "" : "s"}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        className: "text-right",
        render: (s: Stack) => (
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleRestore(s);
              }}
            >
              Restore
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                handleHardDelete(s);
              }}
            >
              <span className="text-red-400">Delete forever</span>
            </Button>
          </div>
        ),
      },
    ],
    []
  );

  const trashCount = trashedStacks?.length ?? 0;
  const showingActive = view === "active";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-mg-text">Stacks</h1>
          <p className="text-sm text-mg-text-tertiary mt-1">
            Bundle multi-server commands and launch them all in a single click. Sessions
            survive dashboard restarts because they live inside each box&apos;s agent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={refetch}>
            Refresh
          </Button>
          {showingActive && <Button onClick={openCreate}>New Stack</Button>}
        </div>
      </div>

      {/* View tabs */}
      <div className="inline-flex rounded-lg border border-mg-border bg-mg-bg-secondary p-0.5">
        <button
          type="button"
          className={`px-3 py-1.5 text-sm rounded-md transition ${
            showingActive
              ? "bg-mg-bg-active text-mg-accent"
              : "text-mg-text-secondary hover:text-mg-text"
          }`}
          onClick={() => setView("active")}
        >
          Active{" "}
          <span className="text-xs text-mg-text-tertiary">
            ({activeStacks?.length ?? 0})
          </span>
        </button>
        <button
          type="button"
          className={`px-3 py-1.5 text-sm rounded-md transition ${
            !showingActive
              ? "bg-mg-bg-active text-mg-accent"
              : "text-mg-text-secondary hover:text-mg-text"
          }`}
          onClick={() => setView("trash")}
        >
          Trash <span className="text-xs text-mg-text-tertiary">({trashCount})</span>
        </button>
      </div>

      <div className="bg-mg-bg-secondary border border-mg-border rounded-lg">
        {showingActive ? (
          loadingActive ? (
            <div className="flex items-center justify-center py-12 text-mg-text-tertiary text-sm">
              Loading stacks...
            </div>
          ) : (
            <Table
              columns={activeColumns}
              data={activeStacks ?? []}
              keyExtractor={(s) => s.id}
              emptyMessage="No stacks yet. Create one to launch commands across multiple servers in parallel."
            />
          )
        ) : loadingTrash ? (
          <div className="flex items-center justify-center py-12 text-mg-text-tertiary text-sm">
            Loading trash...
          </div>
        ) : (
          <Table
            columns={trashColumns}
            data={trashedStacks ?? []}
            keyExtractor={(s) => s.id}
            emptyMessage="Trash is empty."
          />
        )}
      </div>

      <StackEditor
        open={editorOpen}
        draft={draft}
        servers={servers ?? []}
        submitting={submitting}
        onChange={setDraft}
        onClose={() => setEditorOpen(false)}
        onSubmit={submit}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor modal
// ---------------------------------------------------------------------------

interface StackEditorProps {
  open: boolean;
  draft: DraftStack;
  servers: Server[];
  submitting: boolean;
  onChange: (next: DraftStack) => void;
  onClose: () => void;
  onSubmit: () => void;
}

function StackEditor({
  open,
  draft,
  servers,
  submitting,
  onChange,
  onClose,
  onSubmit,
}: StackEditorProps) {
  const updateService = (key: string, patch: Partial<DraftService>) => {
    onChange({
      ...draft,
      services: draft.services.map((s) =>
        s.key === key ? { ...s, ...patch } : s
      ),
    });
  };
  const addService = () => {
    onChange({
      ...draft,
      services: [
        ...draft.services,
        { key: newKey(), name: "", serverId: "", command: "", cwd: "" },
      ],
    });
  };
  const removeService = (key: string) => {
    if (draft.services.length === 1) return;
    onChange({
      ...draft,
      services: draft.services.filter((s) => s.key !== key),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={draft.id ? "Edit Stack" : "New Stack"}
      size="3xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? "Saving..." : draft.id ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Name"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="e.g. dev environment"
          />
          <Input
            label="Description (optional)"
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            placeholder="What this stack does"
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-mg-text">
              Services{" "}
              <span className="text-xs text-mg-text-tertiary">
                ({draft.services.length})
              </span>
            </h3>
            <Button size="sm" variant="ghost" onClick={addService}>
              + Add service
            </Button>
          </div>

          {draft.services.map((svc, idx) => (
            <div
              key={svc.key}
              className="bg-mg-bg-tertiary border border-mg-border rounded-lg p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs text-mg-text-tertiary uppercase tracking-wider">
                  Service {idx + 1}
                </span>
                {draft.services.length > 1 && (
                  <button
                    type="button"
                    className="text-xs text-red-400 hover:underline"
                    onClick={() => removeService(svc.key)}
                  >
                    Remove
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Name"
                  value={svc.name}
                  onChange={(e) => updateService(svc.key, { name: e.target.value })}
                  placeholder="e.g. backend"
                />
                <Select
                  label="Server"
                  value={svc.serverId}
                  placeholder="Select a server..."
                  options={servers.map((s) => ({
                    value: s.id,
                    label: `${s.name} (${s.host})`,
                  }))}
                  onChange={(e) => updateService(svc.key, { serverId: e.target.value })}
                />
              </div>

              <Input
                label="Command (optional — runs on session start)"
                value={svc.command ?? ""}
                onChange={(e) => updateService(svc.key, { command: e.target.value })}
                placeholder="e.g. cd /srv/api && npm start"
              />
              <Input
                label="Working directory (optional)"
                value={svc.cwd ?? ""}
                onChange={(e) => updateService(svc.key, { cwd: e.target.value })}
                placeholder="e.g. /srv/api"
              />
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
