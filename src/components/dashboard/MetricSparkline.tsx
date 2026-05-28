"use client";

import React from "react";

interface MetricSparklineProps {
  data: number[];
  height?: number;
  color?: string;
  className?: string;
}

// Internal coordinate space for the polyline. The SVG stretches to the
// parent's width via viewBox + preserveAspectRatio="none", so this
// number only controls the path resolution, not the on-screen size.
const VBOX_W = 100;

export function MetricSparkline({
  data,
  height = 30,
  // Default to the active theme's accent so the sparkline retints when
  // the user switches themes instead of staying ManageT purple.
  color = "var(--color-mg-accent)",
  className = "",
}: MetricSparklineProps) {
  // Stretch to fill the parent container's width — matches how the RAM
  // bar (w-full div) spans the card. We set width on every layer the
  // browser might consult: SVG width="100%" attribute, inline
  // width:100% style, and a Tailwind `w-full` class. Belt + suspenders
  // because a missing one occasionally causes Chrome to fall back to
  // the SVG's default 300px intrinsic size.
  const commonSvgProps = {
    width: "100%",
    height,
    viewBox: `0 0 ${VBOX_W} ${height}`,
    preserveAspectRatio: "none" as const,
    style: { width: "100%", display: "block" } as React.CSSProperties,
    className: `block w-full ${className}`,
  };

  if (data.length < 2) {
    return (
      <svg {...commonSvgProps}>
        <line
          x1={0}
          y1={height / 2}
          x2={VBOX_W}
          y2={height / 2}
          stroke={color}
          strokeOpacity={0.3}
          strokeWidth={1}
          // The viewBox is non-uniformly scaled, so picking
          // vectorEffect=non-scaling-stroke keeps the line 1px wide
          // visually regardless of how wide the card is.
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const padding = 2;

  const points = data
    .map((value, i) => {
      const x = (i / (data.length - 1)) * VBOX_W;
      const y = padding + ((max - value) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");

  const gradientId = `sparkline-gradient-${Math.random().toString(36).slice(2)}`;

  return (
    <svg {...commonSvgProps}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {/* Fill area */}
      <polygon
        points={`0,${height} ${points} ${VBOX_W},${height}`}
        fill={`url(#${gradientId})`}
      />
      {/* Line — non-scaling-stroke keeps the stroke 1.5px regardless of
       *  how stretched the viewBox is horizontally. Without it the line
       *  thickens visibly on wider cards. */}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
