/**
 * Shared helpers for the stacks feature: CRUD-side reusable bits and the
 * launch fan-out itself. Importable from API routes and (later) from
 * scheduled triggers.
 */
import { v4 as uuidv4 } from "uuid";
import { eq, isNull, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { stackServices, sessions, stacks } from "@/lib/db/schema";
import { createSession, killSession } from "@/lib/ssh/session-manager";
import type {
  CreateStackServiceInput,
  LaunchStackResponse,
  Stack,
  StackRuntime,
  StackRunState,
  StackServiceRuntime,
  StackService,
} from "@/types";

/**
 * Replace all rows in `stack_services` for a stack with a fresh ordered
 * list. Used by the PUT route. Wraps in a single transaction-equivalent
 * (better-sqlite3 doesn't expose async tx via Drizzle, so we delete +
 * insert sequentially; if a write fails partway through, the row in
 * `stacks` is still consistent because no `stacks` row is touched here).
 */
export async function replaceServicesForStack(
  stackId: string,
  services: CreateStackServiceInput[]
): Promise<StackService[]> {
  await db.delete(stackServices).where(eq(stackServices.stackId, stackId));
  const result: StackService[] = [];
  for (let i = 0; i < services.length; i += 1) {
    const svc = services[i];
    const id = uuidv4();
    await db.insert(stackServices).values({
      id,
      stackId,
      name: svc.name,
      serverId: svc.serverId,
      cwd: svc.cwd ?? null,
      command: svc.command ?? null,
      orderIndex: i,
    });
    result.push({
      id,
      stackId,
      name: svc.name,
      serverId: svc.serverId,
      cwd: svc.cwd,
      command: svc.command,
      orderIndex: i,
    });
  }
  return result;
}

/**
 * Fetch a stack with its ordered services.
 */
export async function getStack(stackId: string): Promise<Stack | null> {
  const stackRows = await db
    .select()
    .from(stacks)
    .where(eq(stacks.id, stackId))
    .limit(1);
  if (stackRows.length === 0) return null;
  const s = stackRows[0];
  const serviceRows = await db
    .select()
    .from(stackServices)
    .where(eq(stackServices.stackId, stackId));
  const services = serviceRows
    .map<StackService>((r) => ({
      id: r.id,
      stackId: r.stackId,
      name: r.name,
      serverId: r.serverId,
      cwd: r.cwd ?? undefined,
      command: r.command ?? undefined,
      orderIndex: r.orderIndex,
    }))
    .sort((a, b) => a.orderIndex - b.orderIndex);
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? undefined,
    deletedAt: s.deletedAt ?? undefined,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    services,
  };
}

/**
 * Launch every service in a stack in parallel. Each service becomes a new
 * agent session on its target server, with the command (if any) executed
 * inside the new shell. Failures are isolated — one server being down
 * doesn't block the others.
 *
 * When `missingOnly` is true, services that already have an active session
 * (matched by `serverId` + service name) are skipped — used by the
 * "Launch missing" path on a partially-running stack so we don't fork
 * duplicates.
 *
 * Returns per-service success/failure so the UI can show partial results.
 */
export async function launchStack(
  stackId: string,
  opts: { missingOnly?: boolean } = {}
): Promise<LaunchStackResponse> {
  const stack = await getStack(stackId);
  if (!stack) {
    throw new Error(`stack ${stackId} not found`);
  }
  if (stack.deletedAt) {
    throw new Error(
      `stack "${stack.name}" is in the trash — restore it first`
    );
  }

  let toLaunch: StackService[] = stack.services;
  if (opts.missingOnly) {
    const runtime = await getStackRuntime(stackId);
    const activeServiceIds = new Set(
      runtime.services.filter((s) => s.status === "active").map((s) => s.serviceId)
    );
    toLaunch = stack.services.filter((svc) => !activeServiceIds.has(svc.id));
  }

  const launched: LaunchStackResponse["launched"] = [];
  const failed: LaunchStackResponse["failed"] = [];

  if (toLaunch.length === 0) {
    return { stackId: stack.id, launched, failed };
  }

  // Fan out in parallel — each create call talks to a different agent so
  // there's no contention. allSettled because we want the slowest one
  // not to block reporting the others.
  const results = await Promise.allSettled(
    toLaunch.map((svc) =>
      createSession(svc.serverId, {
        name: svc.name,
        command: svc.command,
        stackId: stack.id,
      }).then((created) => ({ svc, created }))
    )
  );

  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const svc = toLaunch[i];
    if (r.status === "fulfilled") {
      launched.push({
        serviceId: svc.id,
        sessionId: r.value.created.sessionId,
        serverId: svc.serverId,
        sessionName: r.value.created.sessionName,
      });
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      failed.push({
        serviceId: svc.id,
        serverId: svc.serverId,
        error: reason,
      });
    }
  }

  return {
    stackId: stack.id,
    launched,
    failed,
  };
}

/**
 * Derive the live runtime view of a stack — which services are running,
 * what CPU/RAM they're consuming right now, and the rolled-up state pill
 * (idle/partial/running). Pure read; safe to poll.
 *
 * Service ↔ session join: a stack-launched session has `stackId` matching
 * and `sessionName` equal to the service name. If multiple active sessions
 * collide (e.g. user launched twice without stopping), the most recently
 * updated one wins.
 */
export async function getStackRuntime(stackId: string): Promise<StackRuntime> {
  const stack = await getStack(stackId);
  if (!stack) {
    throw new Error(`stack ${stackId} not found`);
  }

  const sessRows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.stackId, stackId));

  // Index sessions by (serverId, sessionName), keeping the freshest active
  // row per pair. "Fresh" = most recent updatedAt.
  type Row = (typeof sessRows)[number];
  const activeByKey = new Map<string, Row>();
  for (const s of sessRows) {
    if (s.status !== "active") continue;
    const key = `${s.serverId}::${s.sessionName}`;
    const existing = activeByKey.get(key);
    if (!existing || s.updatedAt > existing.updatedAt) {
      activeByKey.set(key, s);
    }
  }

  const now = Date.now();
  const services: StackServiceRuntime[] = stack.services.map((svc) => {
    const key = `${svc.serverId}::${svc.name}`;
    const sess = activeByKey.get(key);
    if (!sess) {
      return {
        serviceId: svc.id,
        serverId: svc.serverId,
        sessionId: null,
        status: "inactive",
        cpuPercent: null,
        memoryMb: null,
        statsAgeMs: null,
        pidCount: null,
      };
    }
    return {
      serviceId: svc.id,
      serverId: svc.serverId,
      sessionId: sess.id,
      status: "active",
      cpuPercent: sess.cpuPercent ?? null,
      memoryMb: sess.memoryMb ?? null,
      statsAgeMs: sess.statsUpdatedAt ? now - sess.statsUpdatedAt : null,
      pidCount: null,
    };
  });

  const activeCount = services.filter((s) => s.status === "active").length;
  const totalCount = services.length;
  let state: StackRunState;
  if (activeCount === 0) state = "idle";
  else if (activeCount === totalCount) state = "running";
  else state = "partial";

  return { stackId: stack.id, state, activeCount, totalCount, services };
}

/**
 * Bulk version for the listing page. Cheaper than calling
 * `getStackRuntime` once per stack because it avoids re-querying `stacks`
 * + `stack_services` per row.
 */
export async function getAllStackRuntimes(): Promise<StackRuntime[]> {
  // Pull live (non-trash) stacks + their services + all linked sessions in
  // three queries, then fan out the join in memory. For dev-scale (~tens
  // of stacks) this is well below 10ms total.
  const stackRows = await db
    .select()
    .from(stacks)
    .where(isNull(stacks.deletedAt));
  if (stackRows.length === 0) return [];

  const stackIds = stackRows.map((s) => s.id);
  const serviceRows = await db
    .select()
    .from(stackServices)
    .where(inArray(stackServices.stackId, stackIds));
  const sessRows = await db
    .select()
    .from(sessions)
    .where(inArray(sessions.stackId, stackIds));

  // Index helpers.
  const servicesByStack = new Map<string, typeof serviceRows>();
  for (const sv of serviceRows) {
    const list = servicesByStack.get(sv.stackId) ?? [];
    list.push(sv);
    servicesByStack.set(sv.stackId, list);
  }
  type SessRow = (typeof sessRows)[number];
  const activeByStackKey = new Map<string, SessRow>();
  for (const s of sessRows) {
    if (s.status !== "active") continue;
    const key = `${s.stackId}::${s.serverId}::${s.sessionName}`;
    const existing = activeByStackKey.get(key);
    if (!existing || s.updatedAt > existing.updatedAt) {
      activeByStackKey.set(key, s);
    }
  }

  const now = Date.now();
  return stackRows.map((s) => {
    const svcs = (servicesByStack.get(s.id) ?? []).sort(
      (a, b) => a.orderIndex - b.orderIndex
    );
    const services: StackServiceRuntime[] = svcs.map((svc) => {
      const key = `${s.id}::${svc.serverId}::${svc.name}`;
      const sess = activeByStackKey.get(key);
      if (!sess) {
        return {
          serviceId: svc.id,
          serverId: svc.serverId,
          sessionId: null,
          status: "inactive",
          cpuPercent: null,
          memoryMb: null,
          statsAgeMs: null,
          pidCount: null,
        };
      }
      return {
        serviceId: svc.id,
        serverId: svc.serverId,
        sessionId: sess.id,
        status: "active",
        cpuPercent: sess.cpuPercent ?? null,
        memoryMb: sess.memoryMb ?? null,
        statsAgeMs: sess.statsUpdatedAt ? now - sess.statsUpdatedAt : null,
        pidCount: null,
      };
    });
    const activeCount = services.filter((x) => x.status === "active").length;
    const totalCount = services.length;
    let state: StackRunState;
    if (activeCount === 0) state = "idle";
    else if (activeCount === totalCount) state = "running";
    else state = "partial";
    return { stackId: s.id, state, activeCount, totalCount, services };
  });
}

/**
 * Stop every session created from this stack. Looks up `sessions` rows
 * with `stackId` matching, kills each in parallel.
 *
 * Returns the number of sessions that were attempted; per-server kill
 * errors are logged but not surfaced — a stuck/missing session shouldn't
 * block stopping the rest.
 */
export async function stopStack(stackId: string): Promise<{ stopped: number }> {
  const rows = await db
    .select({ id: sessions.id, serverId: sessions.serverId })
    .from(sessions)
    .where(eq(sessions.stackId, stackId));

  if (rows.length === 0) return { stopped: 0 };

  await Promise.allSettled(
    rows.map((r) =>
      killSession(r.serverId, r.id).catch((err) => {
        console.warn(
          `[stacks] killSession ${r.id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      })
    )
  );
  return { stopped: rows.length };
}
