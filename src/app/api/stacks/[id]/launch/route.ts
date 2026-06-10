/**
 * POST /api/stacks/[id]/launch — fan out and start every service in the
 * stack in parallel. Returns per-service success/failure so the UI can
 * show a "3/4 launched" badge etc.
 */
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/guard";
import { launchStack } from "@/lib/stacks";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Launching a stack spawns shell sessions on hosts — operator+.
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  // Launch is idempotent by default — services with an active session
  // (matched by stackId+serverId+sessionName) are reused instead of
  // respawned, preserving terminal scrollback.
  //
  //  - ?missingOnly=1 — legacy flag from the "Launch missing" UI. Now a
  //    no-op against the new default (which already behaves this way),
  //    but accepted so old clients don't break.
  //  - ?force=1       — opt out of reuse: kill the existing active
  //    sessions first, then create fresh ones. Use sparingly.
  const url = new URL(request.url);
  const missingOnly = url.searchParams.get("missingOnly") === "1";
  const force = url.searchParams.get("force") === "1";
  try {
    const result = await launchStack(id, { missingOnly, force });
    const status = result.failed.length === 0 ? 200 : 207;
    return NextResponse.json({ data: result }, { status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
