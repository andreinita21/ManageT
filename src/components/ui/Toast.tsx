"use client";

import React, { useEffect, useState, useCallback, createContext, useContext } from "react";

interface ToastItem {
  id: string;
  message: string;
  type: "success" | "error" | "info" | "warning";
}

interface ToastContextValue {
  toast: (message: string, type?: ToastItem["type"]) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

function ToastNotification({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), 4000);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  const iconColors: Record<ToastItem["type"], string> = {
    success: "text-mg-success",
    error: "text-mg-danger",
    info: "text-mg-info",
    warning: "text-mg-warning",
  };

  return (
    <div className="bg-mg-bg-secondary border border-mg-border rounded-lg px-4 py-3 shadow-glow animate-slide-up flex items-center gap-3 min-w-[300px]">
      <span className={`text-lg ${iconColors[item.type]}`}>
        {item.type === "success" && "✓"}
        {item.type === "error" && "✕"}
        {item.type === "info" && "i"}
        {item.type === "warning" && "!"}
      </span>
      <span className="text-sm text-mg-text flex-1">{item.message}</span>
      <button onClick={() => onDismiss(item.id)} className="text-mg-text-tertiary hover:text-mg-text transition-colors duration-200">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastItem["type"] = "info") => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastNotification key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
