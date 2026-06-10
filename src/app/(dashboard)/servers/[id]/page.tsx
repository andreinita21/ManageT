/**
 * Server-rendered detail page for a single server. Fetches the server row,
 * a 1h metrics bucket array, and the session list in parallel so the
 * first paint already has data — no client fetch waterfall, no
 * "No metric data" placeholder flashing while metrics load.
 *
 * The interactive bits live in ./ServerDetailClient.tsx.
 */
import { notFound, redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { servers, sessions as sessionsTable } from "@/lib/db/schema";
import { toPublicServer, rowToSession } from "@/lib/db/transform";
import {
  defaultMetricsWindow,
  fetchMetricBuckets,
} from "@/lib/monitor/metrics-buckets";
import type { MetricSnapshot } from "@/types";
import { ServerDetailClient } from "./ServerDetailClient";

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
    // Mirror the GET /api/sessions filter: hide rows the reconciler has
    // already marked as `closed` (orphans whose PTY no longer exists on
    // the agent) so SSR matches the live useSessions() refetch and the
    // /sessions hub.
    db
      .select()
      .from(sessionsTable)
      .where(
        and(
          eq(sessionsTable.serverId, id),
          ne(sessionsTable.status, "closed")
        )
      ),
  ]);

  if (serverRows.length === 0) {
    notFound();
  }

  const initialServer = toPublicServer(serverRows[0]);
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
