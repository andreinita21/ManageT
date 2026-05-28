"use client";

/**
 * Dashboard settings tab — user-level toggles for how the group mosaic
 * and other dashboard surfaces present per-server information. Unlike
 * Appearance (theme/font), changes here are committed on click with no
 * Save/Cancel dance: the field set is tiny and accidental flips are
 * trivially reversible.
 */
import React, { useState } from "react";

import { useToast } from "@/components/ui/Toast";
import { useAppearance } from "@/lib/themes/provider";
import type { GroupViewServerLabel } from "@/lib/themes/presets";

export function DashboardTab() {
  const appearance = useAppearance();
  const { toast } = useToast();
  const [savingLabel, setSavingLabel] = useState<GroupViewServerLabel | null>(
    null
  );

  const current: GroupViewServerLabel =
    appearance.prefs.groupViewServerLabel ?? "host";

  const setLabel = async (next: GroupViewServerLabel) => {
    if (next === current || savingLabel) return;
    setSavingLabel(next);
    try {
      await appearance.save({ ...appearance.prefs, groupViewServerLabel: next });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setSavingLabel(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-mg-text-secondary">
          Controls how the group mosaic and other dashboard surfaces
          identify the servers behind each terminal.
        </p>
      </div>

      <div className="bg-mg-bg-secondary border border-mg-border rounded-lg p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-mg-text">
            Server label in group view
          </h3>
          <p className="text-xs text-mg-text-tertiary mt-1">
            What the top bar above each terminal shows for the server —
            its SSH host or the user-assigned friendly name.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <LabelOption
            label="SSH host"
            description="e.g. 192.168.100.95"
            selected={current === "host"}
            saving={savingLabel === "host"}
            onClick={() => void setLabel("host")}
          />
          <LabelOption
            label="Friendly name"
            description="The name you gave the server in Settings → Servers."
            selected={current === "name"}
            saving={savingLabel === "name"}
            onClick={() => void setLabel("name")}
          />
        </div>
      </div>
    </div>
  );
}

interface LabelOptionProps {
  label: string;
  description: string;
  selected: boolean;
  saving: boolean;
  onClick: () => void;
}

function LabelOption({
  label,
  description,
  selected,
  saving,
  onClick,
}: LabelOptionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className={`text-left rounded-lg border p-3 transition-all duration-150 ${
        selected
          ? "border-mg-accent ring-1 ring-mg-accent bg-mg-bg-tertiary"
          : "border-mg-border hover:border-mg-accent-dim bg-mg-bg-tertiary/50"
      } ${saving ? "opacity-60 cursor-wait" : ""}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm text-mg-text font-medium">{label}</span>
        {selected && (
          <span className="text-[10px] text-mg-accent uppercase tracking-wide">
            Active
          </span>
        )}
      </div>
      <p className="text-xs text-mg-text-tertiary mt-1">{description}</p>
    </button>
  );
}
