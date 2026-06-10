/**
 * PUT /api/cli/stacks/[id]/order — full reorder of a stack's services.
 *   Body: { serviceIds: string[] }   // must equal current service set
 *
 * Bearer-token twin of /api/stacks/[id]/order, used by the CLI stack
 * mosaic's Ctrl-A S swap.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireCliUserId } from "@/lib/cli-auth";
import { reorderStackServices } from "@/lib/stacks";

const reorderSchema = z.object({
  serviceIds: z.array(z.string().min(1)).min(1),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireCliUserId(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  try {
    const stack = await reorderStackServices(id, parsed.data.serviceIds);
    if (!stack) {
      return NextResponse.json({ error: "Stack not found" }, { status: 404 });
    }
    return NextResponse.json({ data: stack });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
