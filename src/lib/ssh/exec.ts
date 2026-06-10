/**
 * @fileoverview SSH command execution module for ManageT.
 * Provides one-shot command execution on remote servers via the connection pool.
 * Supports both positional and object-style argument forms for backward compatibility.
 */
import type { ClientChannel } from "ssh2";
import { connectionPool } from "./connection-pool";
import type { ExecCommandRequest, ExecCommandResponse } from "@/types";

/** Default command timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Cap on captured stdout/stderr per stream. A verbose command (or a hostile
 * one) could otherwise balloon the dashboard's heap before the timeout fires.
 * Output past this is dropped and flagged with a truncation marker.
 */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

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
    let channel: ClientChannel | undefined;
    let settled = false;
    // Single exit point so timeout / close / error can't double-settle, and
    // so we always clear the timer.
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      // Close the channel so the remote command doesn't keep running and the
      // SSH channel doesn't leak for the command's lifetime. Note: the
      // command string is deliberately NOT included in the message — it can
      // carry sensitive arguments (e.g. an installer's sudo invocation).
      try {
        channel?.close();
      } catch {
        /* already torn down */
      }
      settle(() =>
        reject(
          new Error(
            `[SSH] Command timed out after ${effectiveTimeout}ms on server ${serverId}`
          )
        )
      );
    }, effectiveTimeout);

    client.exec(fullCommand, (err, stream) => {
      if (err) {
        settle(() =>
          reject(
            new Error(`[SSH] exec failed on server ${serverId}: ${err.message}`)
          )
        );
        return;
      }
      channel = stream;

      // If the caller supplied stdin (e.g. a sudo password), write it to the
      // remote process before we close the stream. End() signals EOF so the
      // command finishes reading instead of blocking forever.
      if (effectiveStdin !== undefined) {
        stream.write(effectiveStdin);
        stream.end();
      }

      let stdout = "";
      let stderr = "";
      let truncated = false;

      stream.on("data", (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += data.toString("utf-8");
        } else {
          truncated = true;
        }
      });

      stream.stderr.on("data", (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += data.toString("utf-8");
        } else {
          truncated = true;
        }
      });

      stream.on("close", (code: number | null) => {
        const durationMs = Date.now() - startTime;
        const marker = "\n[managet] output truncated]";
        settle(() =>
          resolve({
            stdout: truncated ? stdout + marker : stdout,
            stderr,
            exitCode: code ?? -1,
            durationMs,
          })
        );
      });

      stream.on("error", (streamErr: Error) => {
        settle(() =>
          reject(
            new Error(
              `[SSH] Stream error on server ${serverId}: ${streamErr.message}`
            )
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
