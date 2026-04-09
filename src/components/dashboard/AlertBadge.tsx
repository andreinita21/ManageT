"use client";

import React from "react";

interface AlertBadgeProps {
  count: number;
  className?: string;
}

export function AlertBadge({ count, className = "" }: AlertBadgeProps) {
  if (count === 0) return null;

  return (
    <span
      className={`inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 text-xs font-bold px-1.5 animate-pulse-glow ${className}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
