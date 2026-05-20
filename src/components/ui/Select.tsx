"use client";

import React from "react";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  label?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

export function Select({
  label,
  error,
  options,
  placeholder,
  className = "",
  id,
  ...props
}: SelectProps) {
  const selectId = id || label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={selectId} className="text-sm text-mg-text-secondary font-medium">
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={`w-full rounded-lg bg-mg-bg-tertiary border border-mg-border px-3 py-2 text-sm text-mg-text focus:border-mg-accent focus:outline-none focus:ring-1 focus:ring-mg-accent/30 transition-all duration-200 ${error ? "border-mg-danger" : ""} ${className}`}
        {...props}
      >
        {placeholder && (
          <option value="" className="text-mg-text-tertiary">
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-mg-danger">{error}</span>}
    </div>
  );
}
