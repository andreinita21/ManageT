"use client";

import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "accent";
  className?: string;
}

const variantClasses: Record<NonNullable<BadgeProps["variant"]>, string> = {
  default: "bg-mg-bg-tertiary text-mg-text-secondary",
  success: "bg-mg-success/15 text-mg-success border-mg-success/30",
  warning: "bg-mg-warning/15 text-mg-warning border-mg-warning/30",
  danger: "bg-mg-danger/15 text-mg-danger border-mg-danger/30",
  accent: "bg-mg-accent/15 text-mg-accent-bright border-mg-accent/30",
};

export function Badge({ children, variant = "default", className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all duration-200 ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
