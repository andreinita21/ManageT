"use client";

/**
 * Servers management — the body of the old /servers page, now rendered
 * as a section inside Settings. Self-contained: owns its own form,
 * delete-confirm, and install-progress state.
 */
import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { useServers, createServer, deleteServer } from "@/lib/hooks/useApi";
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
    </div>
  );
}
