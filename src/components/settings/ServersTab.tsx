"use client";

/**
 * Servers management — the body of the old /servers page, now rendered
 * as a section inside Settings. Self-contained: owns its own form,
 * delete-confirm, and install-progress state.
 */
import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { useServers, createServer, deleteServer, updateServer } from "@/lib/hooks/useApi";
import { Button } from "@/components/ui/Button";
import { Table } from "@/components/ui/Table";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { AgentStatusBadge } from "@/components/server/AgentStatusBadge";
import { InstallProgressPanel } from "@/components/server/InstallProgressPanel";
import type { Server, CreateServerRequest } from "@/types";

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: "key" | "password";
  privateKeyPath: string;
  password: string;
  groupName: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  host: "",
  port: "22",
  username: "",
  authMethod: "key",
  privateKeyPath: "",
  password: "",
  groupName: "",
};

export function ServersTab() {
  const router = useRouter();
  const { data: servers, loading, refetch } = useServers();
  const { toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [installingServerId, setInstallingServerId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Server | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Server whose agent settings (heartbeat interval, log level, etc.)
  // are being edited. NULL = modal closed.
  const [agentEditTarget, setAgentEditTarget] = useState<Server | null>(null);
  // Server whose connection details (name/host/port/user/password) are
  // being edited. NULL = modal closed.
  const [serverEditTarget, setServerEditTarget] = useState<Server | null>(null);

  const columns = useMemo(
    () => [
      {
        key: "name",
        header: "Name",
        render: (s: Server) => (
          <div className="flex flex-col">
            <span className="text-mg-text font-medium">{s.name}</span>
            {s.groupName && (
              <span className="text-xs text-mg-text-tertiary">{s.groupName}</span>
            )}
          </div>
        ),
      },
      {
        key: "address",
        header: "Address",
        render: (s: Server) => (
          <span className="font-mono text-xs text-mg-text-secondary">
            {s.username}@{s.host}:{s.port}
          </span>
        ),
      },
      {
        key: "auth",
        header: "Auth",
        render: (s: Server) => (
          <span className="text-xs text-mg-text-tertiary uppercase">{s.authMethod}</span>
        ),
      },
      {
        key: "status",
        header: "Agent",
        render: (s: Server) => (
          <AgentStatusBadge
            status={s.agentStatus}
            lastHeartbeatAt={s.agentLastHeartbeatAt}
            installStage={s.agentInstallStage}
            installError={s.agentInstallError}
          />
        ),
      },
      {
        key: "lastConnected",
        header: "Last Connected",
        render: (s: Server) => (
          <span className="text-xs text-mg-text-tertiary">
            {s.lastConnectedAt
              ? new Date(s.lastConnectedAt).toLocaleString()
              : "—"}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        render: (s: Server) => (
          <div className="flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/terminal?server=${s.id}`);
              }}
            >
              Connect
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setServerEditTarget(s);
              }}
              title="Edit connection details (name, host, user, password)"
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setAgentEditTarget(s);
              }}
              title="Edit per-server agent settings"
            >
              Agent
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setForceDelete(false);
                setDeleteTarget(s);
              }}
            >
              <span className="text-mg-danger">Delete</span>
            </Button>
          </div>
        ),
        className: "text-right",
      },
    ],
    [router]
  );

  const handleSaveAgentConfig = async (
    target: Server,
    patch: AgentConfigPatch
  ) => {
    try {
      await updateServer(target.id, patch);
      toast(`Agent settings saved for ${target.name}`, "success");
      setAgentEditTarget(null);
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Save failed", "error");
    }
  };

  const handleSaveServer = async (
    target: Server,
    patch: ServerEditPatch
  ) => {
    try {
      // Empty `password` from the form means "don't change it" — strip
      // it so we never send `password: ""` to the API, which would
      // re-encrypt an empty string as the new password.
      const cleaned: ServerEditPatch = { ...patch };
      if (!cleaned.password) delete cleaned.password;
      await updateServer(target.id, cleaned);
      toast(`Saved ${target.name}`, "success");
      setServerEditTarget(null);
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Save failed", "error");
    }
  };

  const handleSubmit = async () => {
    setFormError(null);

    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setFormError("Name, host, and username are required.");
      return;
    }
    const portNum = parseInt(form.port || "22", 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setFormError("Port must be a number between 1 and 65535.");
      return;
    }
    if (form.authMethod === "key" && !form.privateKeyPath.trim()) {
      setFormError("Private key path is required when auth is 'key'.");
      return;
    }
    if (form.authMethod === "password" && !form.password) {
      setFormError("Password is required when auth is 'password'.");
      return;
    }

    const payload: CreateServerRequest = {
      name: form.name.trim(),
      host: form.host.trim(),
      port: portNum,
      username: form.username.trim(),
      authMethod: form.authMethod,
      privateKeyPath: form.authMethod === "key" ? form.privateKeyPath.trim() : undefined,
      password: form.authMethod === "password" ? form.password : undefined,
      groupName: form.groupName.trim() || undefined,
      labels: [],
    };

    try {
      setSubmitting(true);
      const created = await createServer(payload);
      toast(`Created ${payload.name} — installing agent`, "success");
      setForm(EMPTY_FORM);
      setInstallingServerId(created.id);
      refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create failed";
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      await deleteServer(deleteTarget.id, { force: forceDelete });
      toast(
        forceDelete
          ? `Force-deleted ${deleteTarget.name}`
          : `Removing ${deleteTarget.name}…`,
        "success"
      );
      setDeleteTarget(null);
      setForceDelete(false);
      refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast(msg, "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-mg-text">Servers</h2>
          <p className="text-sm text-mg-text-tertiary mt-0.5">
            Manage SSH targets. Click a row for details, or Connect to open a terminal.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Server
        </Button>
      </div>

      <div className="bg-mg-bg-secondary border border-mg-border rounded-lg">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-mg-text-tertiary text-sm">
            Loading servers...
          </div>
        ) : (
          <Table
            columns={columns}
            data={servers ?? []}
            keyExtractor={(s) => s.id}
            emptyMessage="No servers yet. Click 'Add Server' to create one."
            onRowClick={(s) => router.push(`/servers/${s.id}`)}
          />
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={() => {
          if (submitting || installingServerId) return;
          setCreateOpen(false);
          setFormError(null);
        }}
        title={installingServerId ? "Installing agent" : "Add Server"}
        footer={
          installingServerId ? (
            <Button
              onClick={() => {
                setInstallingServerId(null);
                setCreateOpen(false);
                refetch();
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                onClick={() => setCreateOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? "Saving..." : "Create"}
              </Button>
            </>
          )
        }
      >
        {installingServerId ? (
          <InstallProgressPanel
            serverId={installingServerId}
            onDone={() => {
              refetch();
            }}
          />
        ) : (
          <div className="space-y-3">
            <Input
              label="Name"
              placeholder="e.g. Pi"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Input
                  label="Host"
                  placeholder="192.168.1.10 or example.com"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </div>
              <Input
                label="Port"
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
              />
            </div>
            <Input
              label="Username"
              placeholder="root, ubuntu, ..."
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <Select
              label="Auth Method"
              value={form.authMethod}
              onChange={(e) =>
                setForm({ ...form, authMethod: e.target.value as "key" | "password" })
              }
              options={[
                { value: "key", label: "Private Key" },
                { value: "password", label: "Password" },
              ]}
            />
            {form.authMethod === "key" ? (
              <Input
                label="Private Key Path"
                placeholder="~/.ssh/id_ed25519"
                value={form.privateKeyPath}
                onChange={(e) => setForm({ ...form, privateKeyPath: e.target.value })}
              />
            ) : (
              <Input
                label="Password"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            )}
            <Input
              label="Group (optional)"
              placeholder="production, staging, ..."
              value={form.groupName}
              onChange={(e) => setForm({ ...form, groupName: e.target.value })}
            />
            {formError && (
              <div className="text-xs text-mg-danger bg-mg-danger/10 border border-mg-danger/30 rounded-md px-3 py-2">
                {formError}
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) {
            setDeleteTarget(null);
            setForceDelete(false);
          }
        }}
        title={`Delete ${deleteTarget?.name ?? "server"}?`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleteTarget(null);
                setForceDelete(false);
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button onClick={handleDeleteConfirm} disabled={deleting}>
              {deleting ? "Deleting..." : forceDelete ? "Force delete" : "Delete"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-mg-text-secondary">
          <p>
            This will send an uninstall signal to the monitoring agent on{" "}
            <span className="text-mg-text font-medium">{deleteTarget?.name}</span>.
            The agent will stop, remove its systemd/launchd service, delete its
            config and binary, and then the server record will be removed from
            the dashboard.
          </p>
          <p className="text-mg-text-tertiary text-xs">
            This action is not reversible.
          </p>
          <label className="flex items-start gap-2 text-xs text-mg-text-secondary cursor-pointer pt-2">
            <input
              type="checkbox"
              checked={forceDelete}
              onChange={(e) => setForceDelete(e.target.checked)}
              className="mt-0.5 accent-mg-danger"
            />
            <span>
              <span className="font-medium text-mg-text">Force delete</span>{" "}
              — skip the agent signal and remove the row immediately. Use this
              if the agent is already gone or the remote host is permanently
              unreachable.
            </span>
          </label>
        </div>
      </Modal>

      <AgentConfigModal
        target={agentEditTarget}
        onClose={() => setAgentEditTarget(null)}
        onSave={handleSaveAgentConfig}
      />

      <ServerEditModal
        target={serverEditTarget}
        onClose={() => setServerEditTarget(null)}
        onSave={handleSaveServer}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Server connection-details modal
// ---------------------------------------------------------------------------

interface ServerEditPatch {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: "key" | "password";
  privateKeyPath?: string;
  password?: string;
}

function ServerEditModal({
  target,
  onClose,
  onSave,
}: {
  target: Server | null;
  onClose: () => void;
  onSave: (target: Server, patch: ServerEditPatch) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<"key" | "password">("key");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (!target) return;
    setName(target.name);
    setHost(target.host);
    setPort(String(target.port));
    setUsername(target.username);
    setAuthMethod(target.authMethod);
    setPrivateKeyPath(target.privateKeyPath ?? "");
    setPassword("");
    setError(null);
  }, [target]);

  const handleSave = async () => {
    if (!target) return;
    setError(null);
    if (!name.trim() || !host.trim() || !username.trim()) {
      setError("Name, host, and username can't be empty.");
      return;
    }
    const portNum = parseInt(port || "22", 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setError("Port must be 1–65535.");
      return;
    }
    if (authMethod === "key" && !privateKeyPath.trim()) {
      setError("Private key path is required when auth is 'key'.");
      return;
    }
    setSaving(true);
    try {
      const patch: ServerEditPatch = {
        name: name.trim(),
        host: host.trim(),
        port: portNum,
        username: username.trim(),
        authMethod,
        // The PUT handler decrypts password into passwordEncrypted; an
        // empty string is stripped upstream so it won't overwrite the
        // stored credential when the user just edits other fields.
        privateKeyPath: authMethod === "key" ? privateKeyPath.trim() : undefined,
        password: authMethod === "password" ? password : undefined,
      };
      await onSave(target, patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={target !== null}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={`Edit ${target?.name ?? "server"}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      {target && (
        <div className="space-y-3">
          <p className="text-xs text-mg-text-tertiary">
            Only updates the dashboard's stored connection details — the
            installed agent isn't touched. If you rename or move the host,
            the existing agent keeps heartbeating until you change the
            Dashboard URL or reinstall.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input
              label="Host / IP"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
            <Input
              label="Port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
            <Input
              label="SSH username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <Select
              label="Auth method"
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value as "key" | "password")}
              options={[
                { value: "key", label: "Private key" },
                { value: "password", label: "Password" },
              ]}
            />
            {authMethod === "key" ? (
              <Input
                label="Private key path"
                value={privateKeyPath}
                onChange={(e) => setPrivateKeyPath(e.target.value)}
                placeholder="/home/user/.ssh/id_ed25519"
              />
            ) : (
              <Input
                label="Password (leave blank to keep current)"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            )}
          </div>
          {error && (
            <div className="text-xs text-mg-danger bg-mg-danger/10 border border-mg-danger/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Agent config modal
// ---------------------------------------------------------------------------

interface AgentConfigPatch {
  heartbeatIntervalSecs: number;
  logLevel: Server["logLevel"];
  autoUpdate: boolean;
  sessionRetentionDays: number;
  maxSessions: number | null;
  apiUrl: string;
  barColor: NonNullable<Server["barColor"]>;
  barFields: string;
}

const BAR_COLORS: Array<{ value: NonNullable<Server["barColor"]>; label: string }> = [
  { value: "green", label: "green (default)" },
  { value: "cyan", label: "cyan" },
  { value: "magenta", label: "magenta" },
  { value: "yellow", label: "yellow" },
  { value: "blue", label: "blue" },
  { value: "red", label: "red" },
  { value: "white", label: "white" },
  { value: "gray", label: "gray (dim)" },
];

const BAR_FIELD_OPTIONS = [
  { key: "session", label: "Session name" },
  { key: "user_host", label: "user@host" },
  { key: "duration", label: "Attach duration" },
  { key: "detach", label: "Ctrl+A D hint" },
] as const;

function AgentConfigModal({
  target,
  onClose,
  onSave,
}: {
  target: Server | null;
  onClose: () => void;
  onSave: (target: Server, patch: AgentConfigPatch) => Promise<void> | void;
}) {
  // Local draft seeded from the row each time the modal opens.
  const [apiUrl, setApiUrl] = useState("");
  const [heartbeat, setHeartbeat] = useState("10");
  const [logLevel, setLogLevel] = useState<Server["logLevel"]>("info");
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [retentionDays, setRetentionDays] = useState("30");
  const [maxSessions, setMaxSessions] = useState("");
  const [barColor, setBarColor] = useState<NonNullable<Server["barColor"]>>("green");
  const [barFieldsSet, setBarFieldsSet] = useState<Set<string>>(
    new Set(["session", "user_host", "detach"])
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (!target) return;
    setApiUrl(target.apiUrl ?? "");
    setHeartbeat(String(target.heartbeatIntervalSecs));
    setLogLevel(target.logLevel);
    setAutoUpdate(target.autoUpdate);
    setRetentionDays(String(target.sessionRetentionDays));
    setMaxSessions(
      target.maxSessions != null ? String(target.maxSessions) : ""
    );
    setBarColor((target.barColor as NonNullable<Server["barColor"]>) ?? "green");
    setBarFieldsSet(
      new Set(
        (target.barFields ?? "session,user_host,detach")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
    setError(null);
  }, [target]);

  const urlChanged = target ? apiUrl.trim() !== (target.apiUrl ?? "") : false;

  const handleSave = async () => {
    if (!target) return;
    setError(null);
    const url = apiUrl.trim();
    if (!url) {
      setError("Dashboard URL is required.");
      return;
    }
    if (!(url.startsWith("http://") || url.startsWith("https://"))) {
      setError("Dashboard URL must start with http:// or https://.");
      return;
    }
    const hb = parseInt(heartbeat, 10);
    if (Number.isNaN(hb) || hb < 5 || hb > 600) {
      setError("Heartbeat interval must be between 5 and 600 seconds.");
      return;
    }
    const ret = parseInt(retentionDays, 10);
    if (Number.isNaN(ret) || ret < 0 || ret > 3650) {
      setError("Retention must be between 0 (off) and 3650 days.");
      return;
    }
    let cap: number | null = null;
    if (maxSessions.trim() !== "") {
      cap = parseInt(maxSessions, 10);
      if (Number.isNaN(cap) || cap < 1 || cap > 1000) {
        setError("Max sessions must be empty (no cap) or 1–1000.");
        return;
      }
    }
    // Bar fields are serialised back into the same comma-separated
    // string the agent expects. Preserve the BAR_FIELD_OPTIONS order
    // so the bar's left-to-right layout matches the checklist order.
    const barFieldsStr = BAR_FIELD_OPTIONS.filter((o) => barFieldsSet.has(o.key))
      .map((o) => o.key)
      .join(",");
    if (!barFieldsStr) {
      setError("Pick at least one bar field — otherwise the bar would be empty.");
      return;
    }
    setSaving(true);
    try {
      await onSave(target, {
        apiUrl: url,
        heartbeatIntervalSecs: hb,
        logLevel,
        autoUpdate,
        sessionRetentionDays: ret,
        maxSessions: cap,
        barColor,
        barFields: barFieldsStr,
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleBarField = (key: string, on: boolean) => {
    setBarFieldsSet((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  return (
    <Modal
      open={target !== null}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={`Agent settings — ${target?.name ?? ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      {target && (
        <div className="space-y-4">
          <p className="text-xs text-mg-text-tertiary">
            Changing the dashboard URL or heartbeat interval pushes the
            new value to the agent over SSH and restarts it. Log level and
            auto-update apply on the agent's next install. Retention and
            max sessions are enforced by the dashboard.
          </p>
          <div>
            <Input
              label="Dashboard URL (the agent calls home to this)"
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://managet.example.com"
            />
            {urlChanged && (
              <p className="mt-1 text-xs text-mg-warning">
                Saving will SSH into the agent, rewrite its config, and
                restart it. The agent must be reachable from this dashboard
                at the new URL or it will go silent.
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Heartbeat interval (seconds)"
              type="number"
              min={5}
              max={600}
              value={heartbeat}
              onChange={(e) => setHeartbeat(e.target.value)}
            />
            <Select
              label="Log level"
              value={logLevel}
              onChange={(e) =>
                setLogLevel(e.target.value as Server["logLevel"])
              }
              options={[
                { value: "debug", label: "debug" },
                { value: "info", label: "info (default)" },
                { value: "warn", label: "warn" },
                { value: "error", label: "error" },
              ]}
            />
            <Input
              label="Session retention (days, 0 = never delete)"
              type="number"
              min={0}
              max={3650}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
            />
            <Input
              label="Max sessions (blank = no cap)"
              type="number"
              min={1}
              max={1000}
              value={maxSessions}
              onChange={(e) => setMaxSessions(e.target.value)}
              placeholder="unlimited"
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-mg-text-secondary cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={autoUpdate}
              onChange={(e) => setAutoUpdate(e.target.checked)}
              className="mt-0.5 accent-mg-accent"
            />
            <span>
              <span className="font-medium text-mg-text">Auto-update agent</span>{" "}
              — fetch the latest agent binary on every restart. Off by
              default; turning it on may surprise users with a brief
              restart on each agent boot.
            </span>
          </label>

          {/* `managet attach` status bar */}
          <div className="border-t border-mg-border pt-3 space-y-3">
            <div>
              <p className="text-sm font-medium text-mg-text">
                Status bar (managet attach)
              </p>
              <p className="text-xs text-mg-text-tertiary mt-0.5">
                Customise the one-line bar shown at the bottom of a terminal
                when a user runs `managet attach` directly on this host.
                Doesn't affect the web terminal.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Select
                label="Colour"
                value={barColor}
                onChange={(e) =>
                  setBarColor(e.target.value as NonNullable<Server["barColor"]>)
                }
                options={BAR_COLORS.map((c) => ({ value: c.value, label: c.label }))}
              />
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-mg-text-secondary font-medium">
                  Fields (order matches the list)
                </span>
                <div className="grid grid-cols-2 gap-1.5">
                  {BAR_FIELD_OPTIONS.map((opt) => {
                    const checked = barFieldsSet.has(opt.key);
                    return (
                      <label
                        key={opt.key}
                        className="flex items-center gap-2 text-xs text-mg-text-secondary cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => toggleBarField(opt.key, e.target.checked)}
                          className="accent-mg-accent"
                        />
                        {opt.label}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="text-xs text-mg-danger bg-mg-danger/10 border border-mg-danger/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
