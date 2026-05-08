"use client";

import React, { useEffect, useCallback } from "react";

/**
 * Width sizing tokens. The modal previously hard-coded `max-w-lg` which
 * was painful for forms with multiple fields per row (e.g. the stack
 * editor's Name + Server pair). Bigger sizes also unlock putting more
 * services on screen without scrolling. Body content scrolls
 * internally past 75vh so the modal never grows beyond the viewport.
 */
type ModalSize = "md" | "lg" | "xl" | "2xl" | "3xl";

const SIZE_CLASSES: Record<ModalSize, string> = {
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: ModalSize;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "lg",
}: ModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className={`bg-mg-bg-secondary border border-mg-border rounded-xl shadow-glow-lg w-full ${SIZE_CLASSES[size]} mx-4 max-h-[90vh] flex flex-col animate-slide-up`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-mg-border flex-shrink-0">
          <h2 className="text-lg font-semibold text-mg-text">{title}</h2>
          <button
            onClick={onClose}
            className="text-mg-text-tertiary hover:text-mg-text transition-colors duration-200 p-1"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-mg-border flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
