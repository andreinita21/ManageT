"use client";

/**
 * AgentStatusBadge — renders a pill summarising the state of the Rust
 * monitoring agent on a server. Pulls from `Server.agentStatus` (which the
 * backend derives from install progress + heartbeat freshness).
 */
import React, { useEffect, useState } from "react";
import type { Server } from "@/types";

type AgentStatus = NonNullable<Server["agentStatus"]>;

interface AgentStatusBadgeProps {
  status: AgentStatus;
  lastHeartbeatAt?: number;
  installStage?: string;
  installError?: string;
  className?: string;
}

/** Visual config per status. */
const STATUS: Record<
  AgentStatus,
  { label: string; dot: string; bg: string; text: string; ring: string }
> = {
  not_installed: {
    label: "Not installed",
    dot: "bg-mg-text-tertiary",
    bg: "bg-mg-text-tertiary/10",
    text: "text-mg-text-secondary",
    ring: "ring-mg-text-tertiary/30",
  },
  installing: {
    label: "Installing agent",
    dot: "bg-mg-info animate-pulse",
    bg: "bg-mg-info/10",
    text: "text-mg-info",
    ring: "ring-mg-info/30",
  },
  install_failed: {
    label: "Install failed",
    dot: "bg-mg-danger",
    bg: "bg-mg-danger/10",
    text: "text-mg-danger",
    ring: "ring-mg-danger/40",
  },
  healthy: {
    label: "Healthy",
    dot: "bg-mg-success shadow-[0_0_6px_var(--color-mg-success)]",
    bg: "bg-mg-success/10",
    text: "text-mg-success",
    ring: "ring-mg-success/30",
  },
  unreachable: {
    label: "Unreachable",
    dot: "bg-mg-warning",
    bg: "bg-mg-warning/10",
    text: "text-mg-warning",
    ring: "ring-mg-warning/40",
  },
  manually_stopped: {
    label: "Stopped",
    // Slate / grey tone to read as "deliberately offline" — neither
    // alarming (no red/amber) nor healthy (no green). The "stopped"
    // word + this colour together signal "this is intentional, run
    // `managet start` on the host to bring it back".
    dot: "bg-mg-text-tertiary",
    bg: "bg-mg-text-tertiary/15",
    text: "text-mg-text-secondary",
    ring: "ring-mg-text-tertiary/40",
  },
  uninstalling: {
    label: "Uninstalling",
    dot: "bg-mg-text-tertiary animate-pulse",
    bg: "bg-mg-text-tertiary/10",
    text: "text-mg-text-secondary",
    ring: "ring-mg-text-tertiary/30",
  },
  uninstall_failed: {
    label: "Uninstall failed",
    dot: "bg-mg-danger",
    bg: "bg-mg-danger/10",
    text: "text-mg-danger",
    ring: "ring-mg-danger/40",
  },
};

/** Produce a short "4s ago" style string from a timestamp. */
function formatAge(ts: number | undefined): string | null {
  if (!ts) return null;
  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) return "just now";
  const secs = Math.floor(deltaMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function AgentStatusBadge({
  status,
  lastHeartbeatAt,
  installStage,
  installError,
  className = "",
}: AgentStatusBadgeProps) {
  const cfg = STATUS[status];

  // The age string ("8s ago", "2m ago"…) is derived from Date.now(),
  // which differs between the server render and the client hydration
  // by however many ms it took the page to ship. That mismatch
  // triggers a React hydration warning the first time the badge
  // paints. Computing the age only on the client (after mount) and
  // letting SSR + the first client paint render `age = null` keeps
  // the two renders identical; the visible age then ticks in on the
  // next animation frame and refreshes every few seconds.
  const [age, setAge] = useState<string | null>(null);
  useEffect(() => {
    if (lastHeartbeatAt == null) {
      setAge(null);
      return;
    }
    const update = () => setAge(formatAge(lastHeartbeatAt));
    update();
    const id = setInterval(update, 5000);
    return () => clearInterval(id);
  }, [lastHeartbeatAt]);

  // Per-status detail line.
  let detail: string | null = null;
  if (status === "healthy" && age) {
    detail = `heartbeat ${age}`;
  } else if (status === "installing" && installStage) {
    detail = installStage;
  } else if (status === "install_failed") {
    detail = installError ?? "install failed";
  } else if (status === "unreachable" && age) {
    detail = `no heartbeat for ${age}`;
  } else if (status === "manually_stopped") {
    // installError carries the reason string the agent sent on its
    // /api/agent/lifecycle POST (or the default). Always include the
    // recovery hint so anyone landing on the page understands what
    // to do without having to dig into docs.
    detail = installError
      ? `${installError} Run \`managet start\` on the host to resume.`
      : "Stopped via `managet stop`. Run `managet start` on the host to resume.";
  } else if (status === "uninstalling" && installStage) {
    detail = installStage;
  } else if (status === "uninstall_failed") {
    detail = installError ?? "uninstall failed";
  }

  return (
    <span
      className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs ring-1 ${cfg.bg} ${cfg.text} ${cfg.ring} ${className}`}
      title={detail ?? cfg.label}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      <span className="font-medium">{cfg.label}</span>
      {detail && (
        <span className="text-mg-text-tertiary font-normal truncate max-w-[14rem]">
          · {detail}
        </span>
      )}
    </span>
  );
}
