/**
 * POST /api/agent/validate-token
 *
 * Used by the interactive TUI installer to verify that the token the user
 * pasted is valid before proceeding with the install. Also useful as a
 * generic connectivity check.
 */
import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agent/auth";

export async function POST(request: Request) {
  const server = await authenticateAgent(request);
  if (!server) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }
  return NextResponse.json({
    valid: true,
    serverId: server.id,
    serverName: server.name,
  });
}
