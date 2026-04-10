"use client";

import React, { useState, useMemo } from "react";
import { useServers, useLatestMetrics } from "@/lib/hooks/useApi";
import { ServerCard } from "@/components/dashboard/ServerCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { createServer } from "@/lib/hooks/useApi";
import { useToast } from "@/components/ui/Toast";
import type { Server, CreateServerRequest } from "@/types";

const statusFilters = [
  { value: "all", label: "All Statuses" },
  { value: "connected", label: "Connected" },
  { value: "disconnected", label: "Disconnected" },
  { value: "reconnecting", label: "Reconnecting" },
  { value: "unreachable", label: "Unreachable" },
];

export default function DashboardPage() {
  const { data: servers, loading, error, refetch } = useServers();
  const { data: latestMetrics } = useLatestMetrics();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState<CreateServerRequest>({
    name: "",
    host: "",
    port: 22,
    username: "root",
    authMethod: "key",
    labels: [],
  });
  const [labelInput, setLabelInput] = useState("");

  const filteredServers = useMemo(() => {
    if (!servers) return [];
    return servers.filter((s) => {
      const matchesSearch =
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.host.toLowerCase().includes(search.toLowerCase()) ||
        s.labels.some((l) => l.toLowerCase().includes(search.toLowerCase()));
      const matchesStatus = statusFilter === "all" || s.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [servers, search, statusFilter]);

  const handleAddServer = async () => {
    setSubmitting(true);
    try {
      await createServer(form);
      toast("Server added successfully", "success");
      setAddModalOpen(false);
      setForm({ name: "", host: "", port: 22, username: "root", authMethod: "key", labels: [] });
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to add server", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const addLabel = () => {
    const trimmed = labelInput.trim();
    if (trimmed && !(form.labels ?? []).includes(trimmed)) {
      setForm((prev) => ({ ...prev, labels: [...(prev.labels ?? []), trimmed] }));
      setLabelInput("");
    }
  };

  const removeLabel = (label: string) => {
    setForm((prev) => ({ ...prev, labels: (prev.labels ?? []).filter((l) => l !== label) }));
  };

  const counts = useMemo(() => {
    if (!servers) return { total: 0, connected: 0, disconnected: 0 };
    return {
      total: servers.length,
      connected: servers.filter((s) => s.status === "connected").length,
      disconnected: servers.filter((s) => s.status !== "connected").length,
    };
  }, [servers]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
          <p className="text-xs text-mg-text-tertiary uppercase tracking-wider">Total Servers</p>
          <p className="text-2xl font-bold text-mg-text mt-1">{counts.total}</p>
        </div>
        <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
          <p className="text-xs text-mg-text-tertiary uppercase tracking-wider">Online</p>
          <p className="text-2xl font-bold text-emerald-400 mt-1">{counts.connected}</p>
        </div>
        <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
          <p className="text-xs text-mg-text-tertiary uppercase tracking-wider">Offline</p>
          <p className="text-2xl font-bold text-red-400 mt-1">{counts.disconnected}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex-1 w-full sm:w-auto">
          <Input
            placeholder="Search servers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon={
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            }
          />
        </div>
        <Select
          options={statusFilters}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-full sm:w-48"
        />
        <Button onClick={() => setAddModalOpen(true)}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Server
        </Button>
      </div>

      {/* Server Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4 h-48 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="bg-mg-bg-secondary border border-red-500/30 rounded-lg p-8 text-center">
          <p className="text-red-400 text-sm">Failed to load servers: {error}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={refetch}>
            Retry
          </Button>
        </div>
      ) : filteredServers.length === 0 ? (
        <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-12 text-center">
          <svg className="w-12 h-12 text-mg-text-tertiary mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
          </svg>
          <p className="text-mg-text-secondary text-sm">
            {servers && servers.length > 0
              ? "No servers match your search"
              : "No servers configured yet"}
          </p>
          {servers && servers.length === 0 && (
            <Button size="sm" className="mt-4" onClick={() => setAddModalOpen(true)}>
              Add Your First Server
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredServers.map((server) => {
            const m = latestMetrics[server.id];
            return (
              <ServerCard
                key={server.id}
                server={server}
                cpuHistory={m?.cpuHistory ?? []}
                memoryUsedMb={m?.memoryUsedMb}
                memoryTotalMb={m?.memoryTotalMb}
              />
            );
          })}
        </div>
      )}

      {/* Add Server Modal */}
      <Modal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        title="Add Server"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddServer} loading={submitting} disabled={!form.name || !form.host}>
              Add Server
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Server Name"
            placeholder="production-web-1"
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          />
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Input
                label="Host"
                placeholder="192.168.1.100"
                value={form.host}
                onChange={(e) => setForm((p) => ({ ...p, host: e.target.value }))}
              />
            </div>
            <Input
              label="Port"
              type="number"
              value={form.port?.toString() ?? "22"}
              onChange={(e) => setForm((p) => ({ ...p, port: parseInt(e.target.value) || 22 }))}
            />
          </div>
          <Input
            label="Username"
            placeholder="root"
            value={form.username}
            onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
          />
          <Select
            label="Auth Method"
            options={[
              { value: "key", label: "SSH Key" },
              { value: "password", label: "Password" },
            ]}
            value={form.authMethod}
            onChange={(e) => setForm((p) => ({ ...p, authMethod: e.target.value as "key" | "password" }))}
          />
          {form.authMethod === "key" && (
            <Input
              label="Private Key Path"
              placeholder="~/.ssh/id_rsa"
              value={form.privateKeyPath ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, privateKeyPath: e.target.value }))}
            />
          )}
          {form.authMethod === "password" && (
            <Input
              label="Password"
              type="password"
              value={form.password ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
            />
          )}
          {/* Labels */}
          <div>
            <label className="text-sm text-mg-text-secondary font-medium mb-1.5 block">Labels</label>
            <div className="flex gap-2">
              <Input
                placeholder="Add label..."
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addLabel();
                  }
                }}
              />
              <Button variant="secondary" size="sm" onClick={addLabel}>
                Add
              </Button>
            </div>
            {(form.labels ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {(form.labels ?? []).map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1 bg-mg-accent/15 text-mg-accent-bright border border-mg-accent/30 rounded-full px-2.5 py-0.5 text-xs"
                  >
                    {label}
                    <button onClick={() => removeLabel(label)} className="hover:text-white transition-colors">
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
