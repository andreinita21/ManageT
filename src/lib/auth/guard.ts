/**
 * Authorization guards for API routes.
 *
 * Authentication answers "who are you" (handled by NextAuth / `auth()`);
 * these helpers answer "are you allowed". Until now every route only checked
 * that *some* session existed, which made a read-only `viewer` indistinguishable
 * from an `admin` — anyone logged in could run commands on any host. These
 * guards enforce the role column the schema already defines.
 *
 * Resource model: servers/sessions/stacks/groups are a single shared workspace
 * (not per-user-owned). Authorization is therefore role-based, not ownership-
 * based: any authenticated user may read; mutations require `operator`;
 * host-level / destructive operations require `admin`.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export type Role = "admin" | "operator" | "viewer";

/** Higher number = more privilege. Unknown roles fall to the lowest tier. */
const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export interface AuthedUser {
  id: string;
  role: Role;
}

function normalizeRole(role: unknown): Role {
  return role === "admin" || role === "operator" || role === "viewer"
    ? role
    : "viewer"; // fail safe: an unrecognised/missing role gets the least privilege
}

/**
 * Resolve the current session user (id + role), or `null` if unauthenticated.
 */
export async function currentUser(): Promise<AuthedUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return { id, role: normalizeRole((session.user as { role?: unknown }).role) };
}

/**
 * Require an authenticated session with at least `min` privilege.
 *
 * Returns the {@link AuthedUser} on success, or a ready-to-return
 * `NextResponse` (401 if not logged in, 403 if under-privileged) on failure:
 *
 * ```ts
 * const gate = await requireRole("admin");
 * if (gate instanceof NextResponse) return gate;
 * // gate.id / gate.role are now available
 * ```
 */
export async function requireRole(min: Role): Promise<AuthedUser | NextResponse> {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (ROLE_RANK[user.role] < ROLE_RANK[min]) {
    return NextResponse.json(
      { error: `Forbidden: requires ${min} role` },
      { status: 403 }
    );
  }
  return user;
}

/** Convenience: any authenticated user (viewer or above). */
export async function requireUser(): Promise<AuthedUser | NextResponse> {
  return requireRole("viewer");
}
