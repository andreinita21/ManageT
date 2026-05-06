/**
 * POST /api/stacks/[id]/launch — fan out and start every service in the
 * stack in parallel. Returns per-service success/failure so the UI can
 * show a "3/4 launched" badge etc.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { launchStack } from "@/lib/stacks";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const result = await launchStack(id);
    const status = result.failed.length === 0 ? 200 : 207;
    return NextResponse.json({ data: result }, { status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
