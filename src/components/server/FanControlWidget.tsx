"use client";

/**
 * Server detail page — fan control widget. Sits at the top of the
 * Metrics tab. Shows the host's currently-reported fan RPM (averaged
 * across fans if there are several) and three mode buttons:
 *
 *   Auto    — give fans back to OS / firmware control. The safe default.
 *   Manual  — popup slider lets the user pin a target RPM. Clamped on
 *             the agent against the hardware's safe min/max.
 *   Max     — peg fans to the hardware maximum. Quick-cool button.
 *
 * The widget hides itself entirely on hosts that don't report fans —
 * a Pi or anywhere the agent's hwmon module came back empty. The
 * dashboard's command is asynchronous: it lands in DB, the next
 * heartbeat carries it to the agent (up to ~10s), and the result
 * shows up in the next heartbeat after that. The "Applying…" badge
 * makes that latency visible to the operator.
 */
import React, { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { setServerFan } from "@/lib/hooks/useApi";
import type { Server, FanReading } from "@/types";

interface FanControlWidgetProps {
  server: Server;
  /** Latest reported fan readings from `/api/metrics/latest`. The
   *  widget shows the mean across fans. */
  fans?: FanReading[];
  /** Called after a successful API update so the parent can refetch
   *  the server row (so `fanMode` / `fanPending` re-render). */
  onChanged?: () => void;
}

// Default slider bounds. The agent re-clamps on the host against the
// firmware's actual safe range, so these are just a UI starting point.
const SLIDER_MIN = 0;
const SLIDER_MAX = 6000;
const SLIDER_STEP = 100;

export function FanControlWidget({ server, fans, onChanged }: FanControlWidgetProps) {
  const [manualOpen, setManualOpen] = useState(false);
  const [pendingRpm, setPendingRpm] = useState<number>(
    server.fanTargetRpm ?? 2500
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hide widget entirely when no fans are reported — RPi, VMs, etc.
  if (!fans || fans.length === 0) return null;

  const avgRpm = Math.round(fans.reduce((a, f) => a + f.rpm, 0) / fans.length);

  async function apply(cmd: { mode: "auto" | "max" } | { mode: "manual"; rpm: number }) {
    setError(null);
    setSubmitting(true);
    try {
      await setServerFan(server.id, cmd);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply");
    } finally {
      setSubmitting(false);
    }
  }

  const modeBadge = (() => {
    if (server.fanPending) {
      return <Badge variant="warning">Applying…</Badge>;
    }
    switch (server.fanMode) {
      case "auto":
        return <Badge variant="default">Auto</Badge>;
      case "manual":
        return (
          <Badge variant="accent">
            Manual{server.fanTargetRpm != null ? ` (${server.fanTargetRpm} rpm)` : ""}
          </Badge>
        );
      case "max":
        return <Badge variant="danger">Max</Badge>;
    }
  })();

  return (
    <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-mg-text">Fan control</h3>
            {modeBadge}
          </div>
          <p className="text-xs text-mg-text-tertiary">
            {fans.length === 1
              ? "Single fan reported by the agent."
              : `${fans.length} fans reported — average shown.`}{" "}
            Manual writes can be rejected by the OS (Apple Silicon
            entitlements, Linux firmware lock). The agent clamps to the
            hardware&apos;s safe range.
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-mg-text-tertiary">Current</p>
          <p className="text-2xl font-bold text-mg-text font-mono leading-none mt-1">
            {avgRpm}
            <span className="text-sm text-mg-text-tertiary font-normal ml-1">rpm</span>
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={server.fanMode === "auto" ? "primary" : "secondary"}
          disabled={submitting}
          onClick={() => apply({ mode: "auto" })}
        >
          Auto
        </Button>
        <Button
          size="sm"
          variant={server.fanMode === "manual" ? "primary" : "secondary"}
          disabled={submitting}
          onClick={() => {
            setPendingRpm(server.fanTargetRpm ?? avgRpm ?? 2500);
            setManualOpen(true);
          }}
        >
          Manual
        </Button>
        <Button
          size="sm"
          variant={server.fanMode === "max" ? "primary" : "secondary"}
          disabled={submitting}
          onClick={() => apply({ mode: "max" })}
        >
          Max
        </Button>
      </div>

      {error && (
        <p className="mt-3 text-xs text-mg-danger bg-mg-danger/10 border border-mg-danger/30 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* Agent-reported apply failure. Shown when the most recent
       *  attempt to push manual/max didn't take. Apple Silicon Mac
       *  mini M4 always lands here — its SMC doesn't expose the
       *  legacy `FS! ` write key. We don't hide the buttons in that
       *  case because the user might still want to try (e.g. on a
       *  later macOS version that adds the key, or a Linux host
       *  whose PWM lock gets unlocked at the BIOS level). */}
      {server.fanError && !server.fanPending && (
        <p className="mt-3 text-xs text-mg-warning bg-mg-warning/10 border border-mg-warning/30 rounded-md px-3 py-2 font-mono break-words">
          Agent could not apply: {server.fanError}
        </p>
      )}

      <Modal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title="Set fan RPM"
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setManualOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={submitting}
              onClick={async () => {
                await apply({ mode: "manual", rpm: pendingRpm });
                setManualOpen(false);
              }}
            >
              {submitting ? "Applying…" : "Apply"}
            </Button>
          </>
        }
      >
        <p className="text-xs text-mg-text-tertiary mb-3">
          The agent clamps this value to the hardware&apos;s reported
          safe min/max. On Apple Silicon, F0Mn and F0Mx define those
          bounds; on Linux PWM, 0&ndash;255 duty cycle is mapped from a
          5000 RPM ceiling.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={SLIDER_MIN}
            max={SLIDER_MAX}
            step={SLIDER_STEP}
            value={pendingRpm}
            onChange={(e) => setPendingRpm(parseInt(e.target.value, 10))}
            className="flex-1 accent-mg-accent"
          />
          <input
            type="number"
            min={SLIDER_MIN}
            max={SLIDER_MAX}
            step={SLIDER_STEP}
            value={pendingRpm}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v)) setPendingRpm(v);
            }}
            className="w-24 px-2 py-1 bg-mg-bg-tertiary border border-mg-border rounded font-mono text-sm text-mg-text"
          />
          <span className="text-sm text-mg-text-tertiary">rpm</span>
        </div>
      </Modal>
    </div>
  );
}
