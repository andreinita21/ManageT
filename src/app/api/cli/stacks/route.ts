/**
 * GET /api/cli/stacks
 *
 * Token-authenticated stack list for the Rust CLI (`managet stacks`).
 * Mirrors /api/cli/groups: browser routes keep using NextAuth cookies,
 * this one accepts only CLI bearer tokens.
 *
 * Returns the live (non-trash) stacks with their ordered services, the
 * minimal server directory (so the CLI can render server labels), and the
 * bulk runtime view (active/inactive + sessionId per service) so the CLI
 * can show how many services are running without a second round-trip.
 */
import { NextResponse } from "next/server";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { getAllStackRuntimes, listStacks } from "@/lib/stacks";

export async function GET(request: Request) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [stacks, serverRows, runtimes] = await Promise.all([
    listStacks(),
    db
      .select({
        id: servers.id,
        name: servers.name,
        host: servers.host,
        username: servers.username,
      })
      .from(servers),
    getAllStackRuntimes(),
  ]);

  return NextResponse.json({
    data: { stacks, servers: serverRows, runtimes },
  });
}
