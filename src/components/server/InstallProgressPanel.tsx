"use client";

/**
 * InstallProgressPanel — tracks the SSH-push agent install for a given
 * serverId by polling GET /api/servers/:id until `agentStatus` leaves the
 * `installing` state.
 *
 * Displays a checklist of stages ("connecting", "detecting OS", "uploading
 * binary", "installing service") that the backend writes into
 * `agentInstallStage` as the installer runs. On success/failure the panel
 * calls `onDone` so the parent can close the modal or refresh.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Server } from "@/types";
import { Button } from "@/components/ui/Button";
import { retryAgentInstall } from "@/lib/hooks/useApi";

interface InstallProgressPanelProps {
  serverId: string;
  onDone?: (server: Server) => void;
}

/**
 * Ordered list of stage "milestones". Each entry matches a substring that
 * the backend writes into `agentInstallStage`. We walk the list in order
 * and mark earlier stages done once a later one shows up.
 *
 * `buildOnly: true` entries only appear in the slow path, where the
 * dashboard has no cached binary for the target architecture and has to
 * compile the agent on the remote host itself. When the fast path runs
 * (cached binary already present), those rows are hidden entirely.
 */
interface Stage {
  match: string;
  label: string;
  buildOnly?: boolean;
}

const STAGES: Stage[] = [
  { match: "starting", label: "Initializing install" },
  { match: "connecting via ssh", label: "Connecting via SSH" },
  { match: "detecting os", label: "Detecting OS and architecture" },
  { match: "checking for rust toolchain", label: "Checking for Rust toolchain", buildOnly: true },
  { match: "installing rust toolchain", label: "Installing Rust toolchain", buildOnly: true },
  { match: "waiting for another install", label: "Waiting for concurrent build", buildOnly: true },
  { match: "uploading agent source", label: "Uploading agent source", buildOnly: true },
  { match: "compiling agent on target", label: "Compiling agent on target", buildOnly: true },
  { match: "caching compiled binary", label: "Caching compiled binary", buildOnly: true },
  { match: "uploading agent binary", label: "Uploading agent binary" },
  { match: "installing service", label: "Installing systemd/launchd service" },
  // Final stage: install command succeeded SSH-side, but we don't trust the
  // agent is actually working until it phones home. The status-monitor
  // watchdog will fail this stage with a useful error if no heartbeat lands
  // within 60s; until then we sit on the spinner.
  { match: "awaiting first heartbeat", label: "Waiting for first heartbeat from agent" },
];

/** Stages whose appearance proves the installer took the build-on-target path. */
const BUILD_PATH_MARKERS = new Set(
  STAGES.filter((s) => s.buildOnly).map((s) => s.match)
);

function stageIndex(stage: string | undefined): number {
  if (!stage) return 0;
  const s = stage.toLowerCase();
  for (let i = STAGES.length - 1; i >= 0; i--) {
    if (s.includes(STAGES[i].match)) return i;
  }
  return 0;
}

function isBuildPathStage(stage: string | undefined): boolean {
  if (!stage) return false;
  const s = stage.toLowerCase();
  for (const marker of BUILD_PATH_MARKERS) {
    if (s.includes(marker)) return true;
  }
  return false;
}

export function InstallProgressPanel({ serverId, onDone }: InstallProgressPanelProps) {
  const [server, setServer] = useState<Server | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sticky: once the installer has entered the build-on-target path in this
  // attempt, keep showing those stages even after it moves past them.
  const [buildPathSeen, setBuildPathSeen] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/servers/${serverId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const next: Server = json.data ?? json;
        if (cancelled) return;
        setServer(next);
        setError(null);
        if (isBuildPathStage(next.agentInstallStage)) {
          setBuildPathSeen(true);
        }

        const status = next.agentStatus;
        if (status !== "installing" && !doneRef.current) {
          doneRef.current = true;
          onDone?.(next);
          return; // stop polling
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Poll failed");
      }

      if (!cancelled && !doneRef.current) {
        timer = setTimeout(poll, 1000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [serverId, onDone]);

  const activeIndex = stageIndex(server?.agentInstallStage);
  const status = server?.agentStatus ?? "installing";
  const failed = status === "install_failed";
  const succeeded = status === "healthy";

  // Hide build-only stages on the fast path (cached binary). Once we see
  // any build-path stage in this attempt, we show them for the rest of the
  // run — otherwise the checklist would confusingly shrink and grow.
  const visibleStages = useMemo(
    () => STAGES.filter((s) => !s.buildOnly || buildPathSeen),
    [buildPathSeen]
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-mg-text">
          {succeeded
            ? "Agent installed"
            : failed
            ? "Install failed"
            : "Installing monitoring agent"}
        </h3>
        <p className="text-xs text-mg-text-tertiary mt-1">
          The dashboard is pushing the Rust agent over SSH and registering it
          as a background service on the remote host.
        </p>
      </div>

      <ul className="space-y-2">
        {visibleStages.map((stage) => {
          // Compare using the stage's index in the FULL list, not the
          // filtered one — activeIndex is measured against STAGES.
          const absoluteIdx = STAGES.indexOf(stage);
          const done = succeeded || absoluteIdx < activeIndex;
          const current = !succeeded && !failed && absoluteIdx === activeIndex;
          return (
            <li key={stage.match} className="flex items-center gap-3 text-sm">
              <StageIcon state={done ? "done" : current ? "running" : "pending"} />
              <span
                className={
                  done
                    ? "text-mg-text"
                    : current
                    ? "text-mg-text"
                    : "text-mg-text-tertiary"
                }
              >
                {stage.label}
              </span>
            </li>
          );
        })}
      </ul>

      {failed && server?.agentInstallError && (
        <div className="text-xs text-mg-danger bg-mg-danger/10 border border-mg-danger/30 rounded-md px-3 py-2 whitespace-pre-wrap break-words font-mono">
          {server.agentInstallError}
        </div>
      )}

      {error && (
        <div className="text-xs text-mg-warning bg-mg-warning/10 border border-mg-warning/30 rounded-md px-3 py-2">
          Poll error: {error}
        </div>
      )}

      {failed && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              try {
                await retryAgentInstall(serverId);
                doneRef.current = false;
                setBuildPathSeen(false);
                setServer((s) =>
                  s ? { ...s, agentStatus: "installing", agentInstallError: undefined } : s
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : "Retry failed");
              }
            }}
          >
            Retry install
          </Button>
        </div>
      )}
    </div>
  );
}

function StageIcon({ state }: { state: "pending" | "running" | "done" }) {
  if (state === "done") {
    return (
      <span className="w-5 h-5 rounded-full bg-mg-success/20 border border-mg-success/40 flex items-center justify-center">
        <svg className="w-3 h-3 text-mg-success" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z"
            clipRule="evenodd"
          />
        </svg>
      </span>
    );
  }
  if (state === "running") {
    return (
      <span className="w-5 h-5 rounded-full border-2 border-mg-info/40 border-t-mg-info animate-spin" />
    );
  }
  return <span className="w-5 h-5 rounded-full border border-mg-border" />;
}
