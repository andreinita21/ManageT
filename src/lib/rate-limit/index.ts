/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * Intended for brute-force protection on credential endpoints in a single
 * long-lived process (the custom server.ts). It is per-process — adequate for
 * this self-hosted single-instance deployment, not for a horizontally scaled
 * one (use a shared store like Redis there). State is bounded by lazy eviction
 * of expired windows on each check.
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for a Retry-After header). */
  retryAfterSec: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /**
   * Record an attempt for `key` and report whether it is allowed. Counts the
   * attempt regardless, so repeated calls past the limit keep failing until
   * the window rolls over.
   */
  check(key: string, now: number): RateLimitResult {
    const existing = this.windows.get(key);
    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.evictExpired(now);
      return { allowed: true, retryAfterSec: 0 };
    }
    existing.count += 1;
    if (existing.count > this.limit) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Clear a key's window early, e.g. on a successful login. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  private evictExpired(now: number): void {
    if (this.windows.size < 1000) return; // cheap amortised cleanup
    for (const [k, w] of this.windows) {
      if (now >= w.resetAt) this.windows.delete(k);
    }
  }
}

/**
 * Best-effort client IP from common proxy headers, falling back to a constant
 * so the limiter still applies (globally) when no IP is available.
 */
export function clientIpFromRequest(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}
