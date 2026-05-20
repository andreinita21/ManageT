"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { execCommand } from "@/lib/hooks/useApi";
import type { Server, ExecCommandResponse } from "@/types";

interface CommandRunnerProps {
  servers: Server[];
  className?: string;
}

export function CommandRunner({ servers, className = "" }: CommandRunnerProps) {
  const [selectedServer, setSelectedServer] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecCommandResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async () => {
    if (!selectedServer || !command.trim()) return;
    setRunning(true);
    setResult(null);
    setError(null);

    try {
      const res = await execCommand(selectedServer, {
        command: command.trim(),
        cwd: cwd.trim() || undefined,
        timeout: 30000,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Command execution failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={`bg-mg-bg-secondary border border-mg-border rounded-lg p-4 space-y-4 ${className}`}>
      <h3 className="text-sm font-medium text-mg-text">Quick Command</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Select
          placeholder="Select server..."
          options={servers.map((s) => ({ value: s.id, label: `${s.name} (${s.host})` }))}
          value={selectedServer}
          onChange={(e) => setSelectedServer(e.target.value)}
        />
        <Input
          placeholder="Working directory (optional)"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        />
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <Input
            placeholder="Enter command..."
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleRun();
              }
            }}
            className="font-mono"
          />
        </div>
        <Button
          onClick={handleRun}
          loading={running}
          disabled={!selectedServer || !command.trim()}
        >
          Run
        </Button>
      </div>

      {/* Output */}
      {(result || error) && (
        <div className="bg-mg-bg rounded-lg border border-mg-border overflow-hidden">
          {error && (
            <div className="px-4 py-3 text-sm text-mg-danger">{error}</div>
          )}
          {result && (
            <>
              <div className="flex items-center gap-3 px-4 py-2 border-b border-mg-border text-xs">
                <span className={`font-mono ${result.exitCode === 0 ? "text-mg-success" : "text-mg-danger"}`}>
                  exit: {result.exitCode}
                </span>
                <span className="text-mg-text-tertiary">
                  {result.durationMs}ms
                </span>
              </div>
              {result.stdout && (
                <pre className="px-4 py-3 text-xs font-mono text-mg-text overflow-x-auto whitespace-pre-wrap">
                  {result.stdout}
                </pre>
              )}
              {result.stderr && (
                <pre className="px-4 py-3 text-xs font-mono text-mg-danger overflow-x-auto whitespace-pre-wrap border-t border-mg-border">
                  {result.stderr}
                </pre>
              )}
              {!result.stdout && !result.stderr && (
                <div className="px-4 py-3 text-xs text-mg-text-tertiary">No output</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
