"use client";

import React, { useState, useMemo } from "react";
import { useRestartRules, useServers } from "@/lib/hooks/useApi";
import { createRestartRule, deleteRestartRule, testRestartRule } from "@/lib/hooks/useApi";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { Tabs } from "@/components/ui/Tabs";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import type { RestartRule, CreateRestartRuleRequest, TestRestartRuleResponse } from "@/types";

export default function SettingsPage() {
  const { data: rules, loading, refetch } = useRestartRules();
  const { data: servers } = useServers();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("rules");
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [testCommand, setTestCommand] = useState("");
  const [testResult, setTestResult] = useState<TestRestartRuleResponse | null>(null);
  const [testing, setTesting] = useState(false);

  const [form, setForm] = useState<CreateRestartRuleRequest>({
    scope: "global",
    pattern: "",
    patternType: "glob",
    action: "auto",
    priority: 0,
  });

  const handleAdd = async () => {
    setSubmitting(true);
    try {
      await createRestartRule(form);
      toast("Restart rule created", "success");
      setAddModalOpen(false);
      setForm({ scope: "global", pattern: "", patternType: "glob", action: "auto", priority: 0 });
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to create rule", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteRestartRule(id);
      toast("Rule deleted", "success");
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete", "error");
    }
  };

  const handleTest = async () => {
    if (!testCommand.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testRestartRule({ command: testCommand.trim() });
      setTestResult(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Test failed", "error");
    } finally {
      setTesting(false);
    }
  };

  const ruleColumns = useMemo(
    () => [
      {
        key: "pattern",
        header: "Pattern",
        render: (r: RestartRule) => (
          <code className="font-mono text-xs text-mg-accent-bright bg-mg-accent/10 px-2 py-0.5 rounded">
            {r.pattern}
          </code>
        ),
      },
      {
        key: "type",
        header: "Type",
        render: (r: RestartRule) => (
          <span className="text-xs text-mg-text-secondary">{r.patternType}</span>
        ),
      },
      {
        key: "scope",
        header: "Scope",
        render: (r: RestartRule) => <Badge variant="default">{r.scope}</Badge>,
      },
      {
        key: "action",
        header: "Action",
        render: (r: RestartRule) => (
          <Badge
            variant={r.action === "auto" ? "success" : r.action === "never" ? "danger" : "warning"}
          >
            {r.action}
          </Badge>
        ),
      },
      {
        key: "priority",
        header: "Priority",
        render: (r: RestartRule) => (
          <span className="font-mono text-xs text-mg-text-secondary">{r.priority}</span>
        ),
      },
      {
        key: "actions",
        header: "",
        render: (r: RestartRule) => (
          <Button variant="ghost" size="sm" onClick={() => handleDelete(r.id)}>
            <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </Button>
        ),
        className: "w-12",
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <div className="space-y-6 animate-fade-in max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-mg-text">Settings</h1>
      </div>

      <Tabs
        tabs={[
          { id: "rules", label: "Restart Rules", count: rules?.length ?? 0 },
          { id: "test", label: "Test Command" },
          { id: "profile", label: "Profile" },
        ]}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* Restart Rules Tab */}
      {activeTab === "rules" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-mg-text-secondary">
              Configure how sessions are restarted based on the last command.
            </p>
            <Button onClick={() => setAddModalOpen(true)}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Rule
            </Button>
          </div>

          <div className="bg-mg-bg-secondary border border-mg-border rounded-lg overflow-hidden">
            {loading ? (
              <div className="p-8 text-center">
                <div className="w-6 h-6 border-2 border-mg-accent border-t-transparent rounded-full animate-spin mx-auto" />
              </div>
            ) : (
              <Table<RestartRule>
                columns={ruleColumns}
                data={rules ?? []}
                keyExtractor={(r) => r.id}
                emptyMessage="No restart rules configured. Add one to customize session recovery behavior."
              />
            )}
          </div>

          {/* Add Rule Modal */}
          <Modal
            open={addModalOpen}
            onClose={() => setAddModalOpen(false)}
            title="Add Restart Rule"
            footer={
              <>
                <Button variant="secondary" onClick={() => setAddModalOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleAdd} loading={submitting} disabled={!form.pattern.trim()}>
                  Create Rule
                </Button>
              </>
            }
          >
            <div className="space-y-4">
              <Input
                label="Pattern"
                placeholder="e.g. npm run *, ^sudo .*"
                value={form.pattern}
                onChange={(e) => setForm((p) => ({ ...p, pattern: e.target.value }))}
                className="font-mono"
              />
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Pattern Type"
                  options={[
                    { value: "glob", label: "Glob" },
                    { value: "regex", label: "Regex" },
                    { value: "exact", label: "Exact" },
                  ]}
                  value={form.patternType}
                  onChange={(e) => setForm((p) => ({ ...p, patternType: e.target.value as "glob" | "regex" | "exact" }))}
                />
                <Select
                  label="Action"
                  options={[
                    { value: "auto", label: "Auto Restart" },
                    { value: "ask", label: "Ask First" },
                    { value: "never", label: "Never Restart" },
                  ]}
                  value={form.action}
                  onChange={(e) => setForm((p) => ({ ...p, action: e.target.value as "auto" | "ask" | "never" }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Scope"
                  options={[
                    { value: "global", label: "Global" },
                    { value: "server", label: "Server" },
                    { value: "session", label: "Session" },
                  ]}
                  value={form.scope}
                  onChange={(e) => setForm((p) => ({ ...p, scope: e.target.value as "global" | "server" | "session" }))}
                />
                <Input
                  label="Priority"
                  type="number"
                  value={form.priority?.toString() ?? "0"}
                  onChange={(e) => setForm((p) => ({ ...p, priority: parseInt(e.target.value) || 0 }))}
                />
              </div>
              {form.scope === "server" && servers && (
                <Select
                  label="Server"
                  placeholder="Select server..."
                  options={servers.map((s) => ({ value: s.id, label: s.name }))}
                  value={form.scopeId ?? ""}
                  onChange={(e) => setForm((p) => ({ ...p, scopeId: e.target.value }))}
                />
              )}
            </div>
          </Modal>
        </div>
      )}

      {/* Test Command Tab */}
      {activeTab === "test" && (
        <div className="space-y-4">
          <p className="text-sm text-mg-text-secondary">
            Test how a command would be classified by the restart system.
          </p>
          <div className="flex gap-3">
            <div className="flex-1">
              <Input
                placeholder="Enter a command to test..."
                value={testCommand}
                onChange={(e) => setTestCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleTest();
                }}
                className="font-mono"
              />
            </div>
            <Button onClick={handleTest} loading={testing} disabled={!testCommand.trim()}>
              Test
            </Button>
          </div>

          {testResult && (
            <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4 space-y-3 animate-slide-up">
              <div className="flex items-center gap-3">
                <span className="text-sm text-mg-text-secondary">Action:</span>
                <Badge
                  variant={
                    testResult.result.action === "auto"
                      ? "success"
                      : testResult.result.action === "never"
                      ? "danger"
                      : "warning"
                  }
                >
                  {testResult.result.action}
                </Badge>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-mg-text-secondary">Matched by:</span>
                <Badge variant="accent">{testResult.result.matchedBy}</Badge>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-mg-text-secondary">Confidence:</span>
                <Badge
                  variant={
                    testResult.result.confidence === "high"
                      ? "success"
                      : testResult.result.confidence === "medium"
                      ? "warning"
                      : "default"
                  }
                >
                  {testResult.result.confidence}
                </Badge>
              </div>
              {testResult.matchedRules.length > 0 && (
                <div>
                  <p className="text-xs text-mg-text-tertiary mb-2">Matched rules:</p>
                  <div className="space-y-1">
                    {testResult.matchedRules.map((r) => (
                      <div key={r.id} className="flex items-center gap-2 text-xs">
                        <code className="font-mono text-mg-accent-bright">{r.pattern}</code>
                        <span className="text-mg-text-tertiary">({r.patternType})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Profile Tab */}
      {activeTab === "profile" && (
        <div className="space-y-6">
          <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-6 space-y-4">
            <h3 className="text-sm font-medium text-mg-text">User Profile</h3>
            <Input label="Email" type="email" placeholder="admin@example.com" />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Current Password" type="password" placeholder="Current password" />
              <Input label="New Password" type="password" placeholder="New password" />
            </div>
            <div className="flex justify-end">
              <Button>Save Changes</Button>
            </div>
          </div>

          <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-6 space-y-4">
            <h3 className="text-sm font-medium text-mg-text">Preferences</h3>
            <Select
              label="Default Restart Policy"
              options={[
                { value: "auto", label: "Auto Restart" },
                { value: "ask", label: "Ask First" },
                { value: "never", label: "Never" },
              ]}
              defaultValue="ask"
            />
            <Select
              label="Terminal Font Size"
              options={[
                { value: "12", label: "12px" },
                { value: "14", label: "14px (default)" },
                { value: "16", label: "16px" },
                { value: "18", label: "18px" },
              ]}
              defaultValue="14"
            />
            <div className="flex justify-end">
              <Button>Save Preferences</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
