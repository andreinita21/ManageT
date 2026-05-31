/**
 * POST /api/cli/stacks/[id]/launch
 *
 * Token-authenticated stack launch for the Rust CLI
 * (`managet stack launch`). CLI-auth variant of the browser
 * /api/stacks/[id]/launch route.
 *
 * Body (JSON, all optional):
 *   { force?: boolean, serviceIds?: string[] }
 *   - force: kill any already-active sessions first, then respawn.
 *   - serviceIds: launch only this subset (used by --server/--service).
 *     Empty/omitted means the whole stack.
 *
 * Returns 200 when every service launched, 207 (partial content) when some
 * failed. Both are 2xx so the CLI's reqwest-based client parses the body.
 */
import { NextResponse } from "next/server";

import { requireCliUserId } from "@/lib/cli-auth";
import { launchStack } from "@/lib/stacks";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const body: unknown = await request.json().catch(() => ({}));
  const force =
    typeof body === "object" && body !== null && "force" in body
      ? (body as { force?: unknown }).force === true
      : false;
  const rawIds =
    typeof body === "object" && body !== null && "serviceIds" in body
      ? (body as { serviceIds?: unknown }).serviceIds
      : undefined;
  const serviceIds =
    Array.isArray(rawIds) && rawIds.length
      ? rawIds.filter((v): v is string => typeof v === "string")
      : undefined;

  try {
    const result = await launchStack(id, { force, serviceIds });
    const status = result.failed.length === 0 ? 200 : 207;
    return NextResponse.json({ data: result }, { status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
