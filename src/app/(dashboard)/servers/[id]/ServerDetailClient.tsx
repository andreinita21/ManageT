"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  useServer,
  useServerMetrics,
  useSessions,
  useLatestMetrics,
  retryAgentInstall,
} from "@/lib/hooks/useApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { AgentStatusBadge } from "@/components/server/AgentStatusBadge";
import { FanControlWidget } from "@/components/server/FanControlWidget";
import { InstallProgressPanel } from "@/components/server/InstallProgressPanel";
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
import type { Server, MetricSnapshot, Session } from "@/types";

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

interface ServerDetailClientProps {
  serverId: string;
  initialServer: Server;
  initialMetrics: MetricSnapshot[];
  initialSessions: Session[];
}

export function ServerDetailClient({
  serverId,
  initialServer,
  initialMetrics,
  initialSessions,
}: ServerDetailClientProps) {
  const router = useRouter();
  const { data: server, refetch: refetchServer } = useServer(serverId, initialServer);
  const { data: metrics } = useServerMetrics(serverId, initialMetrics);
  const { data: sessions } = useSessions(serverId, initialSessions);
  // Subscribe to the same live "latest sample" stream the dashboard uses so
  // the Quick stats tiles on this page match what's shown on the dashboard
  // card for this server. The bucketed `metrics` array still drives the
  // history charts below.
  const { data: latestByServer } = useLatestMetrics();
  const liveLatest = latestByServer[serverId];
  const [activeTab, setActiveTab] = useState("metrics");
  // Tracks clicks on the Retry/Reinstall button so we can switch to the
  // live progress panel *immediately*, without waiting for the next
  // GET /api/servers/:id cycle to show `agentStatus: installing`.
  const [retryPending, setRetryPending] = useState(false);

  // After SSR we always have a Server here, but useFetchWithInitial returns
  // T | null in its type signature. Fall back to the initial prop so the
  // rest of the component can treat `currentServer` as non-null.
  const currentServer = server ?? initialServer;
  const currentMetrics = metrics ?? initialMetrics;
  const currentSessions = sessions ?? initialSessions;

  const chartData = useMemo(() => {
    return currentMetrics.map((m) => ({
      time: new Date(m.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      cpu: m.cpuPercent ?? 0,
      memory: m.memoryTotalMb && m.memoryTotalMb > 0 ? ((m.memoryUsedMb ?? 0) / m.memoryTotalMb) * 100 : 0,
      disk: m.diskUsedPercent ?? 0,
      load1m: m.load1m ?? 0,
      // Recharts plots `null` as a gap, which is exactly what we want
      // for sensors that occasionally drop out of a bucket. The Temp
      // chart hides the GPU line entirely if every bucket is null.
      cpuTemp: m.cpuTempC ?? null,
      gpuTemp: m.gpuTempC ?? null,
      fanRpm: m.fanMaxRpm ?? null,
    }));
  }, [currentMetrics]);

  // Decide whether each optional chart should render at all. A series
  // is "present" if at least one bucket carries a real number — that
  // way Pi-class hosts (no GPU, no fans) just don't see those panels
  // instead of staring at an empty graph.
  const hasGpuTemp = useMemo(
    () => chartData.some((d) => d.gpuTemp !== null),
    [chartData]
  );
  const hasCpuTemp = useMemo(
    () => chartData.some((d) => d.cpuTemp !== null),
    [chartData]
  );
  const hasFans = useMemo(
    () => chartData.some((d) => d.fanRpm !== null),
    [chartData]
  );

  const sessionColumns = useMemo(
    () => [
      {
        key: "name",
        header: "Session",
        render: (s: Session) => (
          <span className="font-mono text-xs">{s.sessionName}</span>
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

  // The "Quick stats" tiles read from the live latest-sample stream so the
  // numbers track the dashboard card (which polls /api/metrics/latest every
  // 10s). Falling back to the most recent bucket only matters before the
  // first poll completes — once we have a live sample, that's the source of
  // truth for both views.
  const latestBucket = currentMetrics.length > 0 ? currentMetrics[currentMetrics.length - 1] : null;
  const latestMetric = liveLatest
    ? {
        cpuPercent: liveLatest.cpuPercent,
        memoryUsedMb: liveLatest.memoryUsedMb,
        memoryTotalMb: liveLatest.memoryTotalMb,
        diskUsedPercent: liveLatest.diskUsedPercent,
        load1m: liveLatest.load1m,
        cpuTempC: liveLatest.cpuTempC,
        gpuTempC: liveLatest.gpuTempC,
        fans: liveLatest.fans,
        capturedAt: liveLatest.capturedAt,
      }
    : latestBucket;

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
            <h1 className="text-xl font-bold text-mg-text">{currentServer.name}</h1>
            <AgentStatusBadge
              status={currentServer.agentStatus}
              lastHeartbeatAt={currentServer.agentLastHeartbeatAt}
              installStage={currentServer.agentInstallStage}
              installError={currentServer.agentInstallError}
            />
          </div>
          <p className="text-sm text-mg-text-tertiary ml-8">
            {currentServer.username}@{currentServer.host}:{currentServer.port}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push(`/terminal?server=${currentServer.id}`)}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Open Terminal
          </Button>
        </div>
      </div>

      {/* Quick stats. Order:
       *    CPU usage → CPU temp (next to CPU) → Memory → Disk
       *  GPU temp + Fans tiles tack on at the end only when the host
       *  actually reports them. Load average is plotted in the
       *  detailed System Load chart below — it's redundant in the
       *  top-of-page tile strip. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "CPU", value: latestMetric?.cpuPercent != null ? `${latestMetric.cpuPercent.toFixed(1)}%` : "--" },
          // CPU temp sits adjacent to CPU%. Renders "--" when the
          // agent hasn't reported a sensor yet so the grid alignment
          // stays stable across servers — the rest of the tiles slot
          // in deterministically rather than reshuffling per host.
          { label: "CPU temp", value: latestMetric?.cpuTempC != null ? `${latestMetric.cpuTempC.toFixed(1)}°C` : "--" },
          {
            label: "Memory",
            value:
              latestMetric?.memoryUsedMb != null && latestMetric?.memoryTotalMb
                ? `${(latestMetric.memoryUsedMb / 1024).toFixed(1)} / ${(latestMetric.memoryTotalMb / 1024).toFixed(1)} GB`
                : "--",
          },
          { label: "Disk", value: latestMetric?.diskUsedPercent != null ? `${latestMetric.diskUsedPercent.toFixed(1)}%` : "--" },
          ...(latestMetric?.gpuTempC != null
            ? [{ label: "GPU temp", value: `${latestMetric.gpuTempC.toFixed(1)}°C` }]
            : []),
          // Fans intentionally absent — they're surfaced via the
          // FanControlWidget at the top of the Metrics tab, which
          // also exposes the Auto/Manual/Max controls.
        ].map((stat) => (
          <div key={stat.label} className="bg-mg-bg-secondary border border-mg-border rounded-lg p-3">
            <p className="text-xs text-mg-text-tertiary">{stat.label}</p>
            <p className="text-lg font-bold text-mg-text mt-0.5 font-mono">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Agent panel */}
      <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
        {currentServer.agentStatus === "installing" || retryPending ? (
          <InstallProgressPanel
            serverId={currentServer.id}
            onDone={(next) => {
              setRetryPending(false);
              if (next.agentStatus !== "installing") {
                refetchServer();
              }
            }}
          />
        ) : (
          <>
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-mg-text">Monitoring agent</h3>
                <p className="text-xs text-mg-text-tertiary mt-0.5">
                  Pushes CPU, memory, disk, load, and heartbeat every 10s to this dashboard.
                </p>
              </div>
              {(currentServer.agentStatus === "install_failed" ||
                currentServer.agentStatus === "healthy" ||
                currentServer.agentStatus === "unreachable") && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      setRetryPending(true);
                      await retryAgentInstall(currentServer.id);
                      setTimeout(() => refetchServer(), 250);
                    } catch (err) {
                      console.error("retry failed", err);
                      setRetryPending(false);
                    }
                  }}
                >
                  {currentServer.agentStatus === "install_failed" ? "Retry install" : "Reinstall"}
                </Button>
              )}
            </div>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <dt className="text-mg-text-tertiary">Status</dt>
                <dd className="text-mg-text font-mono mt-0.5 capitalize">
                  {currentServer.agentStatus.replace(/_/g, " ")}
                </dd>
              </div>
              <div>
                <dt className="text-mg-text-tertiary">Version</dt>
                <dd className="text-mg-text font-mono mt-0.5">
                  {currentServer.agentVersion ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-mg-text-tertiary">Architecture</dt>
                <dd className="text-mg-text font-mono mt-0.5">
                  {currentServer.agentArch ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-mg-text-tertiary">Last heartbeat</dt>
                <dd className="text-mg-text font-mono mt-0.5">
                  {currentServer.agentLastHeartbeatAt
                    ? new Date(currentServer.agentLastHeartbeatAt).toLocaleTimeString()
                    : "—"}
                </dd>
              </div>
            </dl>
            {currentServer.agentInstallError && (
              <div className="mt-3 text-xs text-mg-danger bg-mg-danger/10 border border-mg-danger/30 rounded-md px-3 py-2 whitespace-pre-wrap break-words font-mono">
                {currentServer.agentInstallError}
              </div>
            )}
          </>
        )}
      </div>

      {/* Tabs */}
      <Tabs
        tabs={[
          { id: "metrics", label: "Metrics" },
          { id: "sessions", label: "Sessions", count: currentSessions.length },
        ]}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* Tab content */}
      {activeTab === "metrics" && (
        <div className="space-y-6">
          {/* Fan control sits above the charts because it's a control
           *  surface, not a read-only graph. Hides itself when the host
           *  reports no fans. */}
          <FanControlWidget
            server={currentServer}
            fans={liveLatest?.fans}
            onChanged={refetchServer}
          />
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
                        <stop offset="5%" stopColor="var(--color-mg-accent)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--color-mg-accent)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-mg-border)" />
                    <XAxis dataKey="time" stroke="var(--color-mg-text-tertiary)" fontSize={11} />
                    <YAxis stroke="var(--color-mg-text-tertiary)" fontSize={11} domain={[0, 100]} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "var(--color-mg-bg-secondary)", border: "1px solid var(--color-mg-border)", borderRadius: "8px" }}
                      labelStyle={{ color: "var(--color-mg-text-secondary)" }}
                      itemStyle={{ color: "var(--color-mg-text)" }}
                    />
                    <Area type="monotone" dataKey="cpu" stroke="var(--color-mg-accent)" fill="url(#cpuGrad)" strokeWidth={2} />
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
                        <stop offset="5%" stopColor="var(--color-mg-accent-bright)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--color-mg-accent-bright)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-mg-border)" />
                    <XAxis dataKey="time" stroke="var(--color-mg-text-tertiary)" fontSize={11} />
                    <YAxis stroke="var(--color-mg-text-tertiary)" fontSize={11} domain={[0, 100]} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "var(--color-mg-bg-secondary)", border: "1px solid var(--color-mg-border)", borderRadius: "8px" }}
                      labelStyle={{ color: "var(--color-mg-text-secondary)" }}
                      itemStyle={{ color: "var(--color-mg-text)" }}
                    />
                    <Area type="monotone" dataKey="memory" stroke="var(--color-mg-accent-bright)" fill="url(#memGrad)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* System Load */}
              <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
                <h3 className="text-sm font-medium text-mg-text-secondary mb-4">System Load</h3>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-mg-border)" />
                    <XAxis dataKey="time" stroke="var(--color-mg-text-tertiary)" fontSize={11} />
                    <YAxis stroke="var(--color-mg-text-tertiary)" fontSize={11} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "var(--color-mg-bg-secondary)", border: "1px solid var(--color-mg-border)", borderRadius: "8px" }}
                      labelStyle={{ color: "var(--color-mg-text-secondary)" }}
                      itemStyle={{ color: "var(--color-mg-text)" }}
                    />
                    <Line type="monotone" dataKey="load1m" stroke="var(--color-mg-accent-dim)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Temperatures — only renders when at least one sensor
               *  reported in the window. CPU + (optional) GPU sit on
               *  the same axis since they share °C as a unit. */}
              {hasCpuTemp && (
                <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
                  <h3 className="text-sm font-medium text-mg-text-secondary mb-4">
                    Temperature {hasGpuTemp ? "(CPU + GPU, °C)" : "(CPU, °C)"}
                  </h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-mg-border)" />
                      <XAxis dataKey="time" stroke="var(--color-mg-text-tertiary)" fontSize={11} />
                      <YAxis stroke="var(--color-mg-text-tertiary)" fontSize={11} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--color-mg-bg-secondary)",
                          border: "1px solid var(--color-mg-border)",
                          borderRadius: "8px",
                        }}
                        labelStyle={{ color: "var(--color-mg-text-secondary)" }}
                        itemStyle={{ color: "var(--color-mg-text)" }}
                      />
                      <Line
                        type="monotone"
                        dataKey="cpuTemp"
                        name="CPU"
                        stroke="var(--color-mg-accent)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      {hasGpuTemp && (
                        <Line
                          type="monotone"
                          dataKey="gpuTemp"
                          name="GPU"
                          stroke="var(--color-mg-accent-bright)"
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                          isAnimationActive={false}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Fan RPM — only shown when the host has at least one
               *  fan. The series is the max RPM across all fans for
               *  the bucket, which collapses cleanly for single-fan
               *  hosts and tracks the loudest fan on multi-fan ones. */}
              {hasFans && (
                <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
                  <h3 className="text-sm font-medium text-mg-text-secondary mb-4">
                    Fan RPM
                  </h3>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-mg-border)" />
                      <XAxis dataKey="time" stroke="var(--color-mg-text-tertiary)" fontSize={11} />
                      <YAxis stroke="var(--color-mg-text-tertiary)" fontSize={11} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "var(--color-mg-bg-secondary)",
                          border: "1px solid var(--color-mg-border)",
                          borderRadius: "8px",
                        }}
                        labelStyle={{ color: "var(--color-mg-text-secondary)" }}
                        itemStyle={{ color: "var(--color-mg-text)" }}
                      />
                      <Line
                        type="monotone"
                        dataKey="fanRpm"
                        name="Max RPM"
                        stroke="var(--color-mg-accent-dim)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                  {/* When multiple fans are reporting right now,
                   *  surface the per-fan breakdown below the graph so
                   *  the user can match a label to its current RPM. */}
                  {liveLatest?.fans && liveLatest.fans.length > 1 && (
                    <div className="mt-3 flex flex-wrap gap-3 text-xs text-mg-text-tertiary">
                      {liveLatest.fans.map((f) => (
                        <span key={f.name} className="font-mono">
                          {f.name}: <span className="text-mg-text">{f.rpm} rpm</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "sessions" && (
        <div className="bg-mg-bg-secondary border border-mg-border rounded-lg overflow-hidden">
          <Table<Session>
            columns={sessionColumns}
            data={currentSessions}
            keyExtractor={(s) => s.id}
            emptyMessage="No active sessions for this server"
            onRowClick={(s) => router.push(`/terminal?session=${s.id}`)}
          />
        </div>
      )}
    </div>
  );
}
