"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  Server,
  MetricSnapshot,
  Session,
  RestartRule,
  CreateServerRequest,
  CreateRestartRuleRequest,
  ExecCommandRequest,
  ExecCommandResponse,
  TestRestartRuleRequest,
  TestRestartRuleResponse,
} from "@/types";

const API_BASE = "/api";

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as T;
      setData(json);
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

export async function createServer(data: CreateServerRequest): Promise<Server> {
  const res = await fetch(`${API_BASE}/servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Server>;
}

export async function deleteServer(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/servers/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// --- Session hooks ---

export function useSessions(serverId?: string) {
  const url = serverId ? `/sessions?serverId=${serverId}` : "/sessions";
  return useFetch<Session[]>(url);
}

// --- Restart rule hooks ---

export function useRestartRules() {
  return useFetch<RestartRule[]>("/restart-rules");
}

export async function createRestartRule(data: CreateRestartRuleRequest): Promise<RestartRule> {
  const res = await fetch(`${API_BASE}/restart-rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<RestartRule>;
}

export async function deleteRestartRule(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/restart-rules/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function testRestartRule(data: TestRestartRuleRequest): Promise<TestRestartRuleResponse> {
  const res = await fetch(`${API_BASE}/restart-rules/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<TestRestartRuleResponse>;
}

// --- Command execution ---

export async function execCommand(serverId: string, data: ExecCommandRequest): Promise<ExecCommandResponse> {
  const res = await fetch(`${API_BASE}/servers/${serverId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ExecCommandResponse>;
}
