/**
 * Shared helpers for the stacks feature: CRUD-side reusable bits and the
 * launch fan-out itself. Importable from API routes and (later) from
 * scheduled triggers.
 */
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { stackServices, sessions, stacks } from "@/lib/db/schema";
import { createSession, killSession } from "@/lib/ssh/session-manager";
import type {
  CreateStackServiceInput,
  LaunchStackResponse,
  Stack,
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
 * Returns per-service success/failure so the UI can show partial results.
 */
export async function launchStack(stackId: string): Promise<LaunchStackResponse> {
  const stack = await getStack(stackId);
  if (!stack) {
    throw new Error(`stack ${stackId} not found`);
  }
  if (stack.deletedAt) {
    throw new Error(
      `stack "${stack.name}" is in the trash — restore it first`
    );
  }

  const launched: LaunchStackResponse["launched"] = [];
  const failed: LaunchStackResponse["failed"] = [];

  // Fan out in parallel — each create call talks to a different agent so
  // there's no contention. allSettled because we want the slowest one
  // not to block reporting the others.
  const results = await Promise.allSettled(
    stack.services.map((svc) =>
      createSession(svc.serverId, {
        name: svc.name,
        command: svc.command,
        stackId: stack.id,
      }).then((created) => ({ svc, created }))
    )
  );

  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const svc = stack.services[i];
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
