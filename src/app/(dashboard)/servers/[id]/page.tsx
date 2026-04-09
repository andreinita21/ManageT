"use client";

import React, { useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useServer, useServerMetrics, useSessions } from "@/lib/hooks/useApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Table } from "@/components/ui/Table";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import type { Session } from "@/types";

const statusVariant: Record<string, "success" | "danger" | "warning" | "default"> = {
  connected: "success",
  disconnected: "danger",
  reconnecting: "warning",
  unreachable: "danger",
  unknown: "default",
  active: "success",
  closed: "default",
  recovering: "warning",
};

export default function ServerDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: server, loading: serverLoading } = useServer(params.id);
  const { data: metrics } = useServerMetrics(params.id);
  const { data: sessions } = useSessions(params.id);
  const [activeTab, setActiveTab] = useState("metrics");

  const chartData = useMemo(() => {
    if (!metrics) return [];
    return metrics.map((m) => ({
      time: new Date(m.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      cpu: m.cpuPercent ?? 0,
      memory: m.memoryTotalMb && m.memoryTotalMb > 0 ? ((m.memoryUsedMb ?? 0) / m.memoryTotalMb) * 100 : 0,
      disk: m.diskUsedPercent ?? 0,
      load1m: m.load1m ?? 0,
      connections: m.activeConnections ?? 0,
    }));
  }, [metrics]);

  const sessionColumns = useMemo(
    () => [
      {
        key: "name",
        header: "Session",
        render: (s: Session) => (
          <span className="font-mono text-xs">{s.tmuxSessionName}</span>
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
        key: "cwd",
        header: "Working Dir",
        render: (s: Session) => (
          <span className="font-mono text-xs text-mg-text-secondary">{s.cwd || "~"}</span>
        ),
      },
      {
        key: "lastCommand",
        header: "Last Command",
        render: (s: Session) => (
          <span className="font-mono text-xs text-mg-text-secondary">{s.lastCommand || "-"}</span>
        ),
      },
      {
        key: "policy",
        header: "Restart Policy",
        render: (s: Session) => (
          <Badge variant={s.restartPolicy === "auto" ? "success" : s.restartPolicy === "never" ? "danger" : "warning"}>
            {s.restartPolicy}
          </Badge>
        ),
      },
    ],
    []
  );

  if (serverLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-mg-bg-secondary rounded w-48" />
        <div className="h-64 bg-mg-bg-secondary rounded-lg" />
      </div>
    );
  }

  if (!server) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-mg-text-secondary mb-4">Server not found</p>
        <Button variant="secondary" onClick={() => router.push("/dashboard")}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  const latestMetric = metrics && metrics.length > 0 ? metrics[metrics.length - 1] : null;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <button
              onClick={() => router.push("/dashboard")}
              className="text-mg-text-tertiary hover:text-mg-text transition-colors duration-200"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-xl font-bold text-mg-text">{server.name}</h1>
            <Badge variant={statusVariant[server.status] ?? "default"}>{server.status}</Badge>
          </div>
          <p className="text-sm text-mg-text-tertiary ml-8">
            {server.username}@{server.host}:{server.port}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push(`/terminal?server=${server.id}`)}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Open Terminal
          </Button>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: "CPU", value: latestMetric?.cpuPercent != null ? `${latestMetric.cpuPercent.toFixed(1)}%` : "--" },
          {
            label: "Memory",
            value:
              latestMetric?.memoryUsedMb != null && latestMetric?.memoryTotalMb
                ? `${(latestMetric.memoryUsedMb / 1024).toFixed(1)} / ${(latestMetric.memoryTotalMb / 1024).toFixed(1)} GB`
                : "--",
          },
          { label: "Disk", value: latestMetric?.diskUsedPercent != null ? `${latestMetric.diskUsedPercent.toFixed(1)}%` : "--" },
          { label: "Load (1m)", value: latestMetric?.load1m != null ? latestMetric.load1m.toFixed(2) : "--" },
          { label: "Connections", value: latestMetric?.activeConnections?.toString() ?? "--" },
        ].map((stat) => (
          <div key={stat.label} className="bg-mg-bg-secondary border border-mg-border rounded-lg p-3">
            <p className="text-xs text-mg-text-tertiary">{stat.label}</p>
            <p className="text-lg font-bold text-mg-text mt-0.5 font-mono">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <Tabs
        tabs={[
          { id: "metrics", label: "Metrics" },
          { id: "sessions", label: "Sessions", count: sessions?.length ?? 0 },
        ]}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* Tab content */}
      {activeTab === "metrics" && (
        <div className="space-y-6">
          {chartData.length === 0 ? (
            <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-12 text-center">
              <p className="text-mg-text-tertiary text-sm">No metric data available yet</p>
            </div>
          ) : (
            <>
              {/* CPU Chart */}
              <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
                <h3 className="text-sm font-medium text-mg-text-secondary mb-4">CPU Usage</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#a855f7" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="time" stroke="#71717a" fontSize={11} />
                    <YAxis stroke="#71717a" fontSize={11} domain={[0, 100]} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#12121a", border: "1px solid #27272a", borderRadius: "8px" }}
                      labelStyle={{ color: "#a1a1aa" }}
                      itemStyle={{ color: "#e4e4e7" }}
                    />
                    <Area type="monotone" dataKey="cpu" stroke="#a855f7" fill="url(#cpuGrad)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Memory Chart */}
              <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
                <h3 className="text-sm font-medium text-mg-text-secondary mb-4">Memory Usage</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#c084fc" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#c084fc" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="time" stroke="#71717a" fontSize={11} />
                    <YAxis stroke="#71717a" fontSize={11} domain={[0, 100]} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#12121a", border: "1px solid #27272a", borderRadius: "8px" }}
                      labelStyle={{ color: "#a1a1aa" }}
                      itemStyle={{ color: "#e4e4e7" }}
                    />
                    <Area type="monotone" dataKey="memory" stroke="#c084fc" fill="url(#memGrad)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Load & Connections */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
                  <h3 className="text-sm font-medium text-mg-text-secondary mb-4">System Load</h3>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis dataKey="time" stroke="#71717a" fontSize={11} />
                      <YAxis stroke="#71717a" fontSize={11} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#12121a", border: "1px solid #27272a", borderRadius: "8px" }}
                        labelStyle={{ color: "#a1a1aa" }}
                        itemStyle={{ color: "#e4e4e7" }}
                      />
                      <Line type="monotone" dataKey="load1m" stroke="#7c3aed" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
                  <h3 className="text-sm font-medium text-mg-text-secondary mb-4">Active Connections</h3>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis dataKey="time" stroke="#71717a" fontSize={11} />
                      <YAxis stroke="#71717a" fontSize={11} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#12121a", border: "1px solid #27272a", borderRadius: "8px" }}
                        labelStyle={{ color: "#a1a1aa" }}
                        itemStyle={{ color: "#e4e4e7" }}
                      />
                      <Line type="monotone" dataKey="connections" stroke="#c084fc" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "sessions" && (
        <div className="bg-mg-bg-secondary border border-mg-border rounded-lg overflow-hidden">
          <Table<Session>
            columns={sessionColumns}
            data={sessions ?? []}
            keyExtractor={(s) => s.id}
            emptyMessage="No active sessions for this server"
            onRowClick={(s) => router.push(`/terminal?session=${s.id}`)}
          />
        </div>
      )}
    </div>
  );
}
