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
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import {
  createStack,
  deleteStack,
  launchStack,
  restoreStack,
  stopStack,
  updateStack,
  useServers,
  useStacks,
  useStackRuntimes,
  useTrashedStacks,
} from "@/lib/hooks/useApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Table } from "@/components/ui/Table";
import { useToast } from "@/components/ui/Toast";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import type {
  CreateStackServiceInput,
  Server,
  Stack,
  StackRuntime,
  StackRunState,
  StackServiceRuntime,
} from "@/types";

/**
 * Singleton "what's open in the bottom split" descriptor. Keyed by
 * sessionId so swapping to a new service unmounts+remounts TerminalPane
 * cleanly (the agent's PTY survives — only the dashboard's WS detaches).
 */
interface OpenTerminal {
  stackId: string;
  stackName: string;
  serviceId: string;
  serviceName: string;
  serverId: string;
  serverName: string;
  sessionId: string;
}

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
  const { data: runtimeMap, refetch: refetchRuntime } = useStackRuntimes();
  const { toast } = useToast();

  const [view, setView] = useState<View>("active");
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<DraftStack>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [expandedStackId, setExpandedStackId] = useState<string | null>(null);
  // Singleton bottom-split terminal. Opening another service swaps it.
  const [openTerminal, setOpenTerminal] = useState<OpenTerminal | null>(null);

  const refetch = () => {
    refetchActive();
    refetchTrash();
    refetchRuntime();
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

  const handleLaunch = async (stack: Stack, missingOnly = false) => {
    try {
      const result = await launchStack(stack.id, { missingOnly });
      if (result.launched.length === 0 && result.failed.length === 0) {
        toast("Nothing to launch — all services already running", "info");
      } else if (result.failed.length === 0) {
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
      // Don't push to /sessions on a "launch missing" — the user is
      // recovering a partial stack and probably wants to stay on this page.
      if (!missingOnly && result.launched.length > 0) {
        router.push("/sessions");
      }
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

  /**
   * Open a service's session in the bottom split. Caller must ensure the
   * service is currently running (button is disabled otherwise) — we
   * source the sessionId from the runtime map. A second call replaces
   * whatever is currently in the split: the previous TerminalPane
   * unmounts, its WS closes, the agent's PTY stays alive.
   */
  const handleOpenTerminal = (stack: Stack, svc: { id: string; serverId: string; name: string }) => {
    const runtime = runtimeMap[stack.id];
    const r = runtime?.services.find((s) => s.serviceId === svc.id);
    if (!r || r.status !== "active" || !r.sessionId) {
      toast(
        `Service "${svc.name}" isn't running. Launch it first.`,
        "warning"
      );
      return;
    }
    const server = serversById.get(svc.serverId);
    setOpenTerminal({
      stackId: stack.id,
      stackName: stack.name,
      serviceId: svc.id,
      serviceName: svc.name,
      serverId: svc.serverId,
      serverName: server?.name ?? svc.serverId.slice(0, 6),
      sessionId: r.sessionId,
    });
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
              <span className="text-mg-danger">Delete forever</span>
            </Button>
          </div>
        ),
      },
    ],
    []
  );

  const trashCount = trashedStacks?.length ?? 0;
  const showingActive = view === "active";

  // Top-of-page content (header + view tabs + table) lives in the upper
  // panel. The bottom panel hosts the active service terminal when one is
  // open. /stacks owns its own padding (see SidebarLayout) so the
  // PanelGroup can fill the full content height edge-to-edge.
  const tableSection = (
    <div className="h-full overflow-auto">
      <div className="space-y-6 p-6">
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
              <ActiveStacksTable
                stacks={activeStacks ?? []}
                runtimeMap={runtimeMap}
                serversById={serversById}
                expandedStackId={expandedStackId}
                openTerminal={openTerminal}
                onToggleExpand={(id) =>
                  setExpandedStackId((cur) => (cur === id ? null : id))
                }
                onLaunch={handleLaunch}
                onStop={handleStop}
                onEdit={openEdit}
                onDelete={handleSoftDelete}
                onOpenTerminal={handleOpenTerminal}
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
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      <PanelGroup
        direction="vertical"
        autoSaveId="stacks-page-split"
        className="flex-1"
      >
        <Panel defaultSize={openTerminal ? 60 : 100} minSize={20}>
          {tableSection}
        </Panel>
        {openTerminal && (
          <>
            <PanelResizeHandle className="h-1.5 bg-mg-border hover:bg-mg-accent transition-colors data-[resize-handle-state=drag]:bg-mg-accent" />
            <Panel defaultSize={40} minSize={15}>
              <BottomTerminalSplit
                terminal={openTerminal}
                onClose={() => setOpenTerminal(null)}
              />
            </Panel>
          </>
        )}
      </PanelGroup>

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

/**
 * Bottom panel of the /stacks split: header strip + xterm pane attached
 * to the selected service's session. Re-keyed on `sessionId` so swapping
 * to another service unmounts the previous TerminalPane (closing its WS)
 * and mounts a fresh one.
 */
function BottomTerminalSplit({
  terminal,
  onClose,
}: {
  terminal: OpenTerminal;
  onClose: () => void;
}) {
  return (
    <div className="h-full flex flex-col bg-[#0d0d14]">
      <div className="flex items-center justify-between px-4 py-2 border-y border-mg-border bg-mg-bg-secondary flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0 text-sm">
          <span className="text-mg-text-tertiary">{terminal.stackName}</span>
          <span className="text-mg-text-tertiary">›</span>
          <span className="text-mg-text font-medium truncate">
            {terminal.serviceName}
          </span>
          <span className="text-mg-text-tertiary text-xs ml-2">
            ({terminal.serverName})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-mg-text-tertiary hover:text-mg-text transition-colors"
            onClick={onClose}
            title="Detach (the service keeps running on the agent)"
            aria-label="Close terminal"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <TerminalPane
          key={terminal.sessionId}
          serverId={terminal.serverId}
          sessionId={terminal.sessionId}
          className="h-full"
        />
      </div>
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
                    className="text-xs text-mg-danger hover:underline"
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

// ---------------------------------------------------------------------------
// Active stacks table — replaces the generic <Table> for the live view so we
// can do per-stack expand rows + state-driven button styling.
// ---------------------------------------------------------------------------

interface ActiveStacksTableProps {
  stacks: Stack[];
  runtimeMap: Record<string, StackRuntime>;
  serversById: Map<string, Server>;
  expandedStackId: string | null;
  /** Currently-attached service in the bottom split, if any. Used to
   *  highlight the row of the service whose terminal is on screen. */
  openTerminal: OpenTerminal | null;
  onToggleExpand: (id: string) => void;
  onLaunch: (stack: Stack, missingOnly?: boolean) => void;
  onStop: (stack: Stack) => void;
  onEdit: (stack: Stack) => void;
  onDelete: (stack: Stack) => void;
  onOpenTerminal: (
    stack: Stack,
    svc: { id: string; serverId: string; name: string }
  ) => void;
}

function ActiveStacksTable({
  stacks,
  runtimeMap,
  serversById,
  expandedStackId,
  openTerminal,
  onToggleExpand,
  onLaunch,
  onStop,
  onEdit,
  onDelete,
  onOpenTerminal,
}: ActiveStacksTableProps) {
  if (stacks.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-mg-text-tertiary text-sm">
        No stacks yet. Create one to launch commands across multiple servers in
        parallel.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-mg-border">
            <th className="w-8 px-4 py-3" />
            <th className="px-4 py-3 text-left text-xs font-medium text-mg-text-tertiary uppercase tracking-wider">
              Status
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-mg-text-tertiary uppercase tracking-wider">
              Stack
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium text-mg-text-tertiary uppercase tracking-wider">
              Services
            </th>
            <th className="px-4 py-3 text-right text-xs font-medium text-mg-text-tertiary uppercase tracking-wider" />
          </tr>
        </thead>
        <tbody>
          {stacks.map((s) => {
            const runtime = runtimeMap[s.id];
            const expanded = expandedStackId === s.id;
            return (
              <React.Fragment key={s.id}>
                <tr
                  onClick={() => onToggleExpand(s.id)}
                  className="border-b border-mg-border/50 cursor-pointer hover:bg-mg-bg-hover transition-all duration-200"
                >
                  <td className="px-4 py-3 text-mg-text-tertiary">
                    <span
                      className={`inline-block transition-transform duration-200 ${
                        expanded ? "rotate-90" : ""
                      }`}
                    >
                      ▸
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StateBadge runtime={runtime} totalServices={s.services.length} />
                  </td>
                  <td className="px-4 py-3 text-sm text-mg-text">
                    <div className="flex flex-col">
                      <span className="font-medium">{s.name}</span>
                      {s.description && (
                        <span className="text-xs text-mg-text-tertiary">
                          {s.description}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap gap-1.5 max-w-xl">
                      {s.services.map((svc) => {
                        const server = serversById.get(svc.serverId);
                        return (
                          <Badge key={svc.id} variant="default">
                            <span className="font-mono text-xs">
                              {svc.name} →{" "}
                              {server?.name ?? svc.serverId.slice(0, 6)}
                            </span>
                          </Badge>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <StackRowActions
                      stack={s}
                      runtime={runtime}
                      onLaunch={onLaunch}
                      onStop={onStop}
                      onEdit={onEdit}
                      onDelete={onDelete}
                    />
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-mg-border/50 bg-mg-bg-tertiary/30">
                    <td colSpan={5} className="px-4 py-4">
                      <StackDetailGrid
                        stack={s}
                        runtime={runtime}
                        serversById={serversById}
                        openTerminal={openTerminal}
                        onOpenTerminal={onOpenTerminal}
                      />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StateBadge({
  runtime,
  totalServices,
}: {
  runtime: StackRuntime | undefined;
  totalServices: number;
}) {
  // While the runtime poll is still in flight on first paint, show a
  // neutral placeholder so the column doesn't jump.
  if (!runtime) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-mg-bg-tertiary text-mg-text-tertiary">
        <span className="h-1.5 w-1.5 rounded-full bg-mg-text-tertiary/50" />
        …
      </span>
    );
  }
  const labels: Record<StackRunState, { text: string; dot: string; bg: string }> = {
    idle: {
      text: `Idle 0/${totalServices}`,
      dot: "bg-mg-text-tertiary",
      bg: "bg-mg-bg-tertiary text-mg-text-secondary",
    },
    partial: {
      text: `Partial ${runtime.activeCount}/${runtime.totalCount}`,
      dot: "bg-mg-warning",
      bg: "bg-mg-warning/15 text-mg-warning",
    },
    running: {
      text: `Running ${runtime.activeCount}/${runtime.totalCount}`,
      dot: "bg-mg-success",
      bg: "bg-mg-success/15 text-mg-success",
    },
  };
  const l = labels[runtime.state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${l.bg}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${l.dot}`} />
      {l.text}
    </span>
  );
}

function StackRowActions({
  stack,
  runtime,
  onLaunch,
  onStop,
  onEdit,
  onDelete,
}: {
  stack: Stack;
  runtime: StackRuntime | undefined;
  onLaunch: (stack: Stack, missingOnly?: boolean) => void;
  onStop: (stack: Stack) => void;
  onEdit: (stack: Stack) => void;
  onDelete: (stack: Stack) => void;
}) {
  // Default to "idle" semantics until the first runtime poll completes —
  // that way the Launch button is usable before the table even has stats,
  // and a freshly-loaded page never accidentally enables "Stop" against an
  // empty stack.
  const state: StackRunState = runtime?.state ?? "idle";
  const launchDisabled = state === "running";
  const stopDisabled = state === "idle";
  const launchLabel = state === "partial" ? "Launch missing" : "Launch";
  const launchTitle =
    state === "running"
      ? "All services already running"
      : state === "partial"
        ? "Spawn only the services that aren't running"
        : "Start every service in this stack";

  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        size="sm"
        disabled={launchDisabled}
        title={launchTitle}
        onClick={(e) => {
          e.stopPropagation();
          onLaunch(stack, state === "partial");
        }}
      >
        {launchLabel}
      </Button>
      <Button
        size="sm"
        variant="danger"
        disabled={stopDisabled}
        title={
          stopDisabled
            ? "Nothing to stop — no active sessions for this stack"
            : `Stop all running services in "${stack.name}"`
        }
        onClick={(e) => {
          e.stopPropagation();
          onStop(stack);
        }}
      >
        Stop
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(stack);
        }}
      >
        Edit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(stack);
        }}
      >
        <span className="text-mg-danger">Delete</span>
      </Button>
    </div>
  );
}

function StackDetailGrid({
  stack,
  runtime,
  serversById,
  openTerminal,
  onOpenTerminal,
}: {
  stack: Stack;
  runtime: StackRuntime | undefined;
  serversById: Map<string, Server>;
  openTerminal: OpenTerminal | null;
  onOpenTerminal: (
    stack: Stack,
    svc: { id: string; serverId: string; name: string }
  ) => void;
}) {
  // Build a service-id → runtime map for fast lookup.
  const byService = new Map<string, StackServiceRuntime>();
  if (runtime) {
    for (const r of runtime.services) byService.set(r.serviceId, r);
  }
  const anyRunning = stack.services.some(
    (svc) => byService.get(svc.id)?.status === "active"
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-mg-text-tertiary">
          Per-service runtime
        </div>
        <a
          href={`/stacks/${stack.id}/terminals`}
          target="_blank"
          rel="noopener noreferrer"
          className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
            anyRunning
              ? "border-mg-border text-mg-text-secondary hover:text-mg-text hover:border-mg-accent"
              : "border-mg-border/40 text-mg-text-tertiary/60 pointer-events-none"
          }`}
          onClick={(e) => {
            // Block navigation when nothing is running. The link is also
            // pointer-events-none above, but this is a belt-and-braces
            // guard against keyboard activation.
            if (!anyRunning) e.preventDefault();
          }}
          title={
            anyRunning
              ? "Open every running service in a side-by-side terminal mosaic (new tab)"
              : "No running services — Launch the stack first"
          }
        >
          View all terminals ↗
        </a>
      </div>
      <div className="overflow-x-auto rounded-md border border-mg-border/60">
        <table className="w-full text-sm">
          <thead className="bg-mg-bg-tertiary/40">
            <tr className="text-left text-xs uppercase tracking-wider text-mg-text-tertiary">
              <th className="px-3 py-2 font-medium">Service</th>
              <th className="px-3 py-2 font-medium">Server</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium text-right">CPU</th>
              <th className="px-3 py-2 font-medium text-right">RAM</th>
              <th className="px-3 py-2 font-medium">Command</th>
              <th className="px-3 py-2 font-medium text-right">Terminal</th>
            </tr>
          </thead>
          <tbody>
            {stack.services.map((svc) => {
              const r = byService.get(svc.id);
              const server = serversById.get(svc.serverId);
              const isActive = r?.status === "active";
              const stale =
                r?.statsAgeMs !== null && (r?.statsAgeMs ?? 0) > 30_000;
              const isOpenInSplit =
                openTerminal !== null &&
                openTerminal.stackId === stack.id &&
                openTerminal.serviceId === svc.id;
              return (
                <tr
                  key={svc.id}
                  className={`border-t border-mg-border/40 align-middle ${
                    isOpenInSplit ? "bg-mg-accent/5" : ""
                  }`}
                >
                  <td className="px-3 py-2 font-mono text-xs text-mg-text">
                    {svc.name}
                  </td>
                  <td className="px-3 py-2 text-xs text-mg-text-secondary">
                    {server?.name ?? svc.serverId.slice(0, 6)}
                  </td>
                  <td className="px-3 py-2">
                    {isActive ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-mg-success/15 px-2 py-0.5 text-xs font-medium text-mg-success">
                        <span className="h-1.5 w-1.5 rounded-full bg-mg-success" />
                        running
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-mg-bg-tertiary px-2 py-0.5 text-xs text-mg-text-tertiary">
                        <span className="h-1.5 w-1.5 rounded-full bg-mg-text-tertiary/60" />
                        stopped
                      </span>
                    )}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-xs ${
                      stale ? "text-mg-text-tertiary" : "text-mg-text"
                    }`}
                  >
                    {r?.cpuPercent != null
                      ? `${r.cpuPercent.toFixed(1)}%`
                      : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-xs ${
                      stale ? "text-mg-text-tertiary" : "text-mg-text"
                    }`}
                  >
                    {r?.memoryMb != null ? `${r.memoryMb} MB` : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-mg-text-tertiary truncate max-w-xs">
                    {svc.command ?? "(login shell)"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant={isOpenInSplit ? "primary" : "secondary"}
                      disabled={!isActive}
                      title={
                        !isActive
                          ? "Service isn't running — Launch the stack first"
                          : isOpenInSplit
                            ? "Already open in the split below"
                            : "Open this service in the bottom split"
                      }
                      onClick={() =>
                        onOpenTerminal(stack, {
                          id: svc.id,
                          serverId: svc.serverId,
                          name: svc.name,
                        })
                      }
                    >
                      {isOpenInSplit ? "Open" : "Open"}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {runtime?.services.some(
        (s) => s.status === "active" && s.cpuPercent == null
      ) && (
        <p className="text-xs text-mg-text-tertiary">
          Some active services are reporting <code>—</code> for stats. The host
          agent is older than v0.2.0 — upgrade it to see live CPU/RAM here.
        </p>
      )}
    </div>
  );
}
