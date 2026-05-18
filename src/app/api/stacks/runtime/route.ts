/**
 * GET /api/stacks/runtime — live state of all non-trash stacks.
 *
 * Polled by the stacks page every ~10s to drive the running/partial/idle
 * pill, button enabled/disabled state, and the per-service CPU/RAM grid in
 * the expandable detail row. Cheap: three indexed queries, joined in
 * memory.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAllStackRuntimes } from "@/lib/stacks";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const data = await getAllStackRuntimes();
  return NextResponse.json({ data });
}
