/**
 * @fileoverview SSH command execution module for ManageT.
 * Provides one-shot command execution on remote servers via the connection pool.
 * Supports both positional and object-style argument forms for backward compatibility.
 */
import { connectionPool } from "./connection-pool";
import type { ExecCommandRequest, ExecCommandResponse } from "@/types";

/** Default command timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Execute a command on a remote server via SSH (positional arguments form).
 * @param serverId - The server to execute on (must have an active connection)
 * @param command - The command string to execute
 * @param cwd - Optional working directory; the command is prefixed with `cd <cwd> &&`
 * @param timeout - Timeout in milliseconds (default 30s)
 * @param stdin - Optional string written to the remote process's stdin before
 *                the stream is closed. Intended for internal callers (e.g. the
 *                agent installer piping a sudo password). Not surfaced on the
 *                public `ExecCommandRequest` type on purpose — exposing stdin
 *                via the HTTP `/exec` route would be a footgun.
 */
export async function executeCommand(
  serverId: string,
  command: string,
  cwd?: string,
  timeout?: number,
  stdin?: string
): Promise<ExecCommandResponse>;

/**
 * Execute a command on a remote server via SSH (request object form).
 * @param serverId - The server to execute on (must have an active connection)
 * @param request - ExecCommandRequest with command, optional cwd, and optional timeout
 */
export async function executeCommand(
  serverId: string,
  request: ExecCommandRequest
): Promise<ExecCommandResponse>;

/**
 * Execute a command on a remote server via SSH.
 * Uses the connection pool to obtain a client, then runs `client.exec()`.
 * Collects stdout and stderr, enforces a timeout, and returns
 * the exit code and duration.
 */
export async function executeCommand(
  serverId: string,
  commandOrRequest: string | ExecCommandRequest,
  cwd?: string,
  timeout?: number,
  stdin?: string
): Promise<ExecCommandResponse> {
  let command: string;
  let effectiveCwd: string | undefined;
  let effectiveTimeout: number;
  const effectiveStdin: string | undefined = stdin;

  if (typeof commandOrRequest === "string") {
    command = commandOrRequest;
    effectiveCwd = cwd;
    effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS;
  } else {
    command = commandOrRequest.command;
    effectiveCwd = commandOrRequest.cwd;
    effectiveTimeout = commandOrRequest.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  const client = connectionPool.getConnection(serverId);
  if (!client) {
    throw new Error(`[SSH] No active connection for server ${serverId}`);
  }

  const fullCommand = effectiveCwd
    ? `cd ${escapeShellArg(effectiveCwd)} && ${command}`
    : command;

  const startTime = Date.now();

  return new Promise<ExecCommandResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `[SSH] Command timed out after ${effectiveTimeout}ms on server ${serverId}: ${command}`
        )
      );
    }, effectiveTimeout);

    client.exec(fullCommand, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(
          new Error(`[SSH] exec failed on server ${serverId}: ${err.message}`)
        );
        return;
      }

      // If the caller supplied stdin (e.g. a sudo password), write it to the
      // remote process before we close the stream. End() signals EOF so the
      // command finishes reading instead of blocking forever.
      if (effectiveStdin !== undefined) {
        stream.write(effectiveStdin);
        stream.end();
      }

      let stdout = "";
      let stderr = "";

      stream.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });

      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });

      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
          durationMs,
        });
      });

      stream.on("error", (streamErr: Error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `[SSH] Stream error on server ${serverId}: ${streamErr.message}`
          )
        );
      });
    });
  });
}

/**
 * Escape a string for safe use as a shell argument.
 */
function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
