"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  Server,
  MetricSnapshot,
  Session,
  RestartRule,
  Stack,
  StackRuntime,
  CreateServerRequest,
  CreateRestartRuleRequest,
  CreateStackRequest,
  UpdateStackRequest,
  ExecCommandRequest,
  ExecCommandResponse,
  LaunchStackResponse,
  TestRestartRuleRequest,
  TestRestartRuleResponse,
} from "@/types";

const API_BASE = "/api";

function handleUnauthorized(res: Response): void {
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
}

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function useFetch<T>(url: string): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${url}`);
      if (res.status === 401) {
        setError("Unauthorized");
        setLoading(false);
        if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
          window.location.href = "/login";
        }
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData((json.data ?? json) as T);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

// --- Server hooks ---

export function useServers() {
  return useFetch<Server[]>("/servers");
}

export function useServer(id: string) {
  return useFetch<Server>(`/servers/${id}`);
}

export function useServerMetrics(serverId: string) {
  return useFetch<MetricSnapshot[]>(`/servers/${serverId}/metrics`);
}

export interface LatestMetricsEntry {
  cpuPercent?: number;
  cpuHistory: number[];
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  diskUsedPercent?: number;
  load1m?: number;
  capturedAt: number;
}

/**
 * Fetches the latest metric snapshot per server every `intervalMs` so the
 * dashboard sparklines stay live without one request per ServerCard. Returns
 * a map keyed by server id.
 */
export function useLatestMetrics(intervalMs = 10000) {
  const [data, setData] = useState<Record<string, LatestMetricsEntry>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const tick = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/metrics/latest`);
      if (res.status === 401) {
        setError("Unauthorized");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData((json.data ?? {}) as Record<string, LatestMetricsEntry>);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void tick();
    timerRef.current = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [tick, intervalMs]);

  return { data, loading, error, refetch: tick };
}

export async function createServer(data: CreateServerRequest): Promise<Server> {
  const res = await fetch(`${API_BASE}/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.data ?? json) as Server;
}

export async function deleteServer(
  id: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  const qs = opts.force ? "?force=true" : "";
  const res = await fetch(`${API_BASE}/servers/${id}${qs}`, { method: "DELETE" });
  handleUnauthorized(res);
  if (!res.ok) {
    // Try to surface the server's error message so the user knows why the
    // delete was rejected (e.g. agent unreachable + SSH fallback failed).
    let detail: string | undefined;
    try {
      const body = await res.json();
      detail = body?.error ?? body?.detail;
    } catch {
      /* non-JSON body — ignore */
    }
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
}

/** Kick off a background retry of the SSH-push agent install. */
export async function retryAgentInstall(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/servers/${id}/agent/install-retry`, {
    method: "POST",
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// --- Session hooks ---

export function useSessions(serverId?: string) {
  const url = serverId ? `/sessions?serverId=${serverId}` : "/sessions";
  return useFetch<Session[]>(url);
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${id}`, { method: "DELETE" });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export function useSession(id: string) {
  return useFetch<Session>(`/sessions/${id}`);
}

// --- Restart rule hooks ---

export function useRestartRules() {
  return useFetch<RestartRule[]>("/restart-policies");
}

export async function createRestartRule(data: CreateRestartRuleRequest): Promise<RestartRule> {
  const res = await fetch(`${API_BASE}/restart-policies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<RestartRule>;
}

export async function deleteRestartRule(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/restart-policies/${id}`, { method: "DELETE" });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function testRestartRule(data: TestRestartRuleRequest): Promise<TestRestartRuleResponse> {
  const res = await fetch(`${API_BASE}/restart-policies/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<TestRestartRuleResponse>;
}

// --- Command execution ---

// --- Stack hooks ---

export function useStacks() {
  return useFetch<Stack[]>("/stacks");
}

/** Soft-deleted stacks (the Trash view). */
export function useTrashedStacks() {
  return useFetch<Stack[]>("/stacks?trashed=1");
}

export function useStack(id: string) {
  return useFetch<Stack>(`/stacks/${id}`);
}

/**
 * Live runtime view across all non-trash stacks. Polled on an interval so
 * the running/idle pill, button states, and per-service CPU/RAM in the
 * expanded row stay current without a page refresh. Lookup is by stack id.
 */
export function useStackRuntimes(intervalMs = 10000) {
  const [data, setData] = useState<Record<string, StackRuntime>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const tick = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/stacks/runtime`);
      if (res.status === 401) {
        setError("Unauthorized");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = (json.data ?? []) as StackRuntime[];
      const map: Record<string, StackRuntime> = {};
      for (const r of list) map[r.stackId] = r;
      setData(map);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void tick();
    timerRef.current = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [tick, intervalMs]);

  return { data, loading, error, refetch: tick };
}

export async function createStack(data: CreateStackRequest): Promise<Stack> {
  const res = await fetch(`${API_BASE}/stacks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json.data ?? json) as Stack;
}

export async function updateStack(id: string, data: UpdateStackRequest): Promise<Stack> {
  const res = await fetch(`${API_BASE}/stacks/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json.data ?? json) as Stack;
}

/**
 * Default behaviour is a soft delete: the row stays around in the Trash
 * view and can be restored with `restoreStack(id)`. Pass `force: true`
 * to permanently remove it (no recovery).
 */
export async function deleteStack(
  id: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  const qs = opts.force ? "?force=true" : "";
  const res = await fetch(`${API_BASE}/stacks/${id}${qs}`, {
    method: "DELETE",
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function restoreStack(id: string): Promise<Stack> {
  const res = await fetch(`${API_BASE}/stacks/${id}/restore`, {
    method: "POST",
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json.data ?? json) as Stack;
}

export async function launchStack(
  id: string,
  opts: { missingOnly?: boolean } = {}
): Promise<LaunchStackResponse> {
  const qs = opts.missingOnly ? "?missingOnly=1" : "";
  const res = await fetch(`${API_BASE}/stacks/${id}/launch${qs}`, {
    method: "POST",
  });
  handleUnauthorized(res);
  // 207 = partial — some services failed. We return the body either way.
  const json = await res.json();
  if (!res.ok && res.status !== 207) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return (json.data ?? json) as LaunchStackResponse;
}

export async function stopStack(id: string): Promise<{ stopped: number }> {
  const res = await fetch(`${API_BASE}/stacks/${id}/stop`, { method: "POST" });
  handleUnauthorized(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json.data ?? json) as { stopped: number };
}

// --- Command execution ---

export async function execCommand(serverId: string, data: ExecCommandRequest): Promise<ExecCommandResponse> {
  const res = await fetch(`${API_BASE}/servers/${serverId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ExecCommandResponse>;
}
