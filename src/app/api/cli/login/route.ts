/**
 * POST /api/cli/login
 *
 * Exchanges dashboard credentials for a user-scoped CLI bearer token.
 * The token is used by the Rust `managet` CLI to read group metadata,
 * persist the same per-user group layout as the browser, and attach to
 * dashboard-routed terminal WebSockets.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { createCliToken } from "@/lib/cli-auth";

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  try {
    const data = await createCliToken(parsed.data);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json(
      { error: "Invalid username or password" },
      { status: 401 }
    );
  }
}
