"use client";

import React from "react";

interface Column<T> {
  key: string;
  header: string;
  render: (item: T) => React.ReactNode;
  className?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  emptyMessage?: string;
  onRowClick?: (item: T) => void;
}

export function Table<T>({ columns, data, keyExtractor, emptyMessage = "No data found", onRowClick }: TableProps<T>) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-mg-text-tertiary text-sm">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-mg-border">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-4 py-3 text-left text-xs font-medium text-mg-text-tertiary uppercase tracking-wider ${col.className || ""}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr
              key={keyExtractor(item)}
              onClick={() => onRowClick?.(item)}
              className={`border-b border-mg-border/50 transition-all duration-200 ${
                onRowClick ? "cursor-pointer hover:bg-mg-bg-hover" : ""
              }`}
            >
              {columns.map((col) => (
                <td key={col.key} className={`px-4 py-3 text-sm text-mg-text ${col.className || ""}`}>
                  {col.render(item)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
