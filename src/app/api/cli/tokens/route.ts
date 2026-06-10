/**
 * DELETE /api/cli/tokens — revoke all of the current user's CLI tokens
 *   ("log out all CLI sessions"). Authenticated via the browser session, so a
 *   user can always invalidate leaked/forgotten CLI tokens from the dashboard.
 */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/guard";
import { revokeAllCliTokensForUser } from "@/lib/cli-auth";

export async function DELETE() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) return gate;

  const revoked = await revokeAllCliTokensForUser(gate.id);
  return NextResponse.json({ data: { revoked } });
}
