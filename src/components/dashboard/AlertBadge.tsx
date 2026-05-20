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
      className={`inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-mg-danger/20 text-mg-danger border border-mg-danger/30 text-xs font-bold px-1.5 animate-pulse-glow ${className}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
