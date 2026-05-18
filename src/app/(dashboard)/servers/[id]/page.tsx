/**
 * Server-rendered detail page for a single server. Fetches the server row,
 * a 1h metrics bucket array, and the session list in parallel so the
 * first paint already has data — no client fetch waterfall, no
 * "No metric data" placeholder flashing while metrics load.
 *
 * The interactive bits live in ./ServerDetailClient.tsx.
 */
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { servers, sessions as sessionsTable } from "@/lib/db/schema";
import { rowToServer } from "@/lib/db/transform";
import {
  defaultMetricsWindow,
  fetchMetricBuckets,
} from "@/lib/monitor/metrics-buckets";
import type { MetricSnapshot, Session } from "@/types";
import { ServerDetailClient } from "./ServerDetailClient";

function rowToSession(r: typeof sessionsTable.$inferSelect): Session {
  return {
    ...r,
    status: r.status as Session["status"],
    restartPolicy: r.restartPolicy as Session["restartPolicy"],
    cwd: r.cwd ?? undefined,
    lastCommand: r.lastCommand ?? undefined,
    envSnapshot: r.envSnapshot
      ? (JSON.parse(r.envSnapshot) as Record<string, string>)
      : undefined,
    scrollBufferTail: r.scrollBufferTail ?? undefined,
    disconnectedAt: r.disconnectedAt ?? undefined,
    stackId: r.stackId ?? undefined,
  };
}

export default async function ServerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const { id } = await params;
  const { from, to } = defaultMetricsWindow("1h");

  const [serverRows, bucketRows, sessionRows] = await Promise.all([
    db.select().from(servers).where(eq(servers.id, id)).limit(1),
    fetchMetricBuckets(id, "1h", from, to),
    db.select().from(sessionsTable).where(eq(sessionsTable.serverId, id)),
  ]);

  if (serverRows.length === 0) {
    notFound();
  }

  const initialServer = rowToServer(serverRows[0]);
  const initialMetrics = bucketRows as unknown as MetricSnapshot[];
  const initialSessions = sessionRows.map(rowToSession);

  return (
    <ServerDetailClient
      serverId={id}
      initialServer={initialServer}
      initialMetrics={initialMetrics}
      initialSessions={initialSessions}
    />
  );
}
