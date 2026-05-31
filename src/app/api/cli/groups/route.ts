/**
 * GET /api/cli/groups
 *
 * Token-authenticated group list for the Rust CLI. Browser routes keep
 * using NextAuth cookies; this route intentionally accepts only CLI
 * bearer tokens.
 *
 * Returns the user's groups, the minimal server directory (so the CLI
 * can render server labels next to each group), and the caller's
 * "server label" preference — host name vs. friendly name — so
 * `managet ls` matches what they see in the browser tab.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { requireCliUserId } from "@/lib/cli-auth";
import { db } from "@/lib/db";
import { servers, userPreferences } from "@/lib/db/schema";
import {
  cleanupAllEmptyGroups,
  createGroupWithFirstMember,
  GroupConstraintError,
  listGroups,
} from "@/lib/groups";
import { broadcastToAll } from "@/lib/ws";

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await cleanupAllEmptyGroups();
  const [groups, serverRows, prefRows] = await Promise.all([
    listGroups(),
    db
      .select({
        id: servers.id,
        name: servers.name,
        host: servers.host,
        username: servers.username,
      })
      .from(servers),
    db
      .select({ groupViewServerLabel: userPreferences.groupViewServerLabel })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1),
  ]);

  const groupViewServerLabel =
    prefRows[0]?.groupViewServerLabel === "name" ? "name" : "host";

  return NextResponse.json({
    data: {
      groups,
      servers: serverRows,
      preferences: { groupViewServerLabel },
    },
  });
}

const createBodySchema = z.object({
  name: z.string().min(1),
  sessionId: z.string().min(1),
});

/**
 * POST /api/cli/groups — create a new group seeded with one existing
 * session. Used by the solo-attach Ctrl-A G "create new group" flow.
 * Body: { name, sessionId }.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    /* fall through to validation error */
  }
  const parsed = createBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  try {
    const group = await createGroupWithFirstMember({
      name: parsed.data.name,
      sessionId: parsed.data.sessionId,
      createdBy: userId,
    });
    broadcastToAll({ type: "group:changed", groupId: group.id });
    return NextResponse.json({ data: group }, { status: 201 });
  } catch (err) {
    if (err instanceof GroupConstraintError) {
      const status = err.code === "session_not_found" ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
