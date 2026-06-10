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
import { RateLimiter, clientIpFromRequest } from "@/lib/rate-limit";

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
});

// Brute-force protection: this endpoint mints a bearer token, so throttle by
// client IP. 10 attempts per 5 minutes is generous for a human and cuts an
// online guessing attack to a crawl.
const loginLimiter = new RateLimiter(10, 5 * 60_000);

export async function POST(request: Request) {
  const ip = clientIpFromRequest(request);
  const limit = loginLimiter.check(`cli-login:${ip}`, Date.now());
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

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
    // Successful login: clear the IP's failure budget.
    loginLimiter.reset(`cli-login:${ip}`);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json(
      { error: "Invalid username or password" },
      { status: 401 }
    );
  }
}
