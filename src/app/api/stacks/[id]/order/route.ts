/**
 * PUT /api/stacks/[id]/order — full reorder of a stack's services.
 *   Body: { serviceIds: string[] }   // must equal current service set
 *
 * Browser twin of /api/cli/stacks/[id]/order; both call
 * reorderStackServices. Drives the drag-to-swap on the stack terminals
 * mosaic.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/guard";
import { reorderStackServices } from "@/lib/stacks";

const reorderSchema = z.object({
  serviceIds: z.array(z.string().min(1)).min(1),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireRole("operator");
  if (gate instanceof NextResponse) return gate;
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
