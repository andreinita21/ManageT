/**
 * SSH command execution module for ManageT.
 * Placeholder — will be implemented by the SSH/session agent.
 */
import type { ExecCommandRequest, ExecCommandResponse } from "@/types";

/**
 * Execute a command on a remote server via SSH.
 * @throws Error — not yet implemented
 */
export async function executeCommand(
  _serverId: string,
  _request: ExecCommandRequest
): Promise<ExecCommandResponse> {
  throw new Error("executeCommand is not implemented");
}
