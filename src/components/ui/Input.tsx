"use client";

import React from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  icon?: React.ReactNode;
}

export function Input({
  label,
  error,
  icon,
  className = "",
  id,
  ...props
}: InputProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm text-mg-text-secondary font-medium">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-mg-text-tertiary">
            {icon}
          </span>
        )}
        <input
          id={inputId}
          className={`w-full rounded-lg bg-mg-bg-tertiary border border-mg-border px-3 py-2 text-sm text-mg-text placeholder:text-mg-text-tertiary focus:border-mg-accent focus:outline-none focus:ring-1 focus:ring-mg-accent/30 transition-all duration-200 ${icon ? "pl-10" : ""} ${error ? "border-mg-danger" : ""} ${className}`}
          {...props}
        />
      </div>
      {error && <span className="text-xs text-mg-danger">{error}</span>}
    </div>
  );
}
