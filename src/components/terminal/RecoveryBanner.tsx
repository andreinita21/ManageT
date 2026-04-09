"use client";

import React, { useEffect, useState } from "react";

interface RecoveryBannerProps {
  sessionId: string;
  method: "reattach" | "recreate";
  command?: string;
  cwd?: string;
  onDismiss?: () => void;
}

export function RecoveryBanner({ sessionId, method, command, cwd, onDismiss }: RecoveryBannerProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, 10000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  if (!visible) return null;

  return (
    <div className="bg-mg-accent/10 border border-mg-accent/30 rounded-lg px-4 py-3 flex items-center gap-3 animate-slide-up">
      <div className="w-2 h-2 rounded-full bg-mg-accent animate-pulse-glow flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-mg-accent-bright font-medium">
          Session recovered via {method}
        </p>
        <p className="text-xs text-mg-text-tertiary mt-0.5 truncate">
          {command && <span>Command: <code className="font-mono">{command}</code></span>}
          {command && cwd && " | "}
          {cwd && <span>Dir: <code className="font-mono">{cwd}</code></span>}
          {!command && !cwd && <span>Session ID: {sessionId}</span>}
        </p>
      </div>
      <button
        onClick={() => {
          setVisible(false);
          onDismiss?.();
        }}
        className="text-mg-text-tertiary hover:text-mg-text transition-colors duration-200 flex-shrink-0"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
