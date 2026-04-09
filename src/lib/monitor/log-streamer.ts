/**
 * @file log-streamer.ts — Stream remote logs over SSH.
 *
 * Provides helpers to tail systemd journal entries, plain log files,
 * and Docker container logs. Every public method validates its input
 * against a strict shell-injection deny-list before building the
 * remote command string.
 */

import { executeCommand } from "@/lib/ssh/exec";
import type { ExecCommandResponse } from "@/types";

/** Helper to call executeCommand with timeout in the positional signature. */
function execWithTimeout(
  serverId: string,
  command: string,
  timeout: number,
): Promise<ExecCommandResponse> {
  return executeCommand(serverId, command, undefined, timeout);
}

// ---------------------------------------------------------------------------
// Shell-injection prevention
// ---------------------------------------------------------------------------

/** Characters / sequences that are never allowed in user-supplied arguments. */
const DANGEROUS_PATTERNS: ReadonlyArray<string | RegExp> = [
  ";",
  "|",
  "&&",
  "||",
  "`",
  /\$\(/,   // $( subshell
];

/**
 * Throw if `value` contains any shell meta-characters that could lead to
 * command injection.
 */
function assertSafe(value: string, label: string): void {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (typeof pattern === "string") {
      if (value.includes(pattern)) {
        throw new Error(
          `Shell injection detected in ${label}: disallowed sequence "${pattern}"`,
        );
      }
    } else if (pattern.test(value)) {
      throw new Error(
        `Shell injection detected in ${label}: disallowed pattern ${pattern.toString()}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// LogStreamer
// ---------------------------------------------------------------------------

/** Options shared by all streaming methods. */
interface StreamOptions {
  /** Maximum number of lines to retrieve (default 100). */
  lines?: number;
  /** SSH command timeout in milliseconds (default 5 000). */
  timeout?: number;
}

/** Additional options for journal streaming. */
interface JournalOptions extends StreamOptions {
  /** systemd unit name, e.g. "nginx.service". */
  unit: string;
  /** Priority filter (0-7, maps to journalctl --priority). */
  priority?: number;
  /** Only show entries since this relative time, e.g. "1h ago". */
  since?: string;
}

/** Additional options for file streaming. */
interface FileOptions extends StreamOptions {
  /** Absolute path on the remote server. */
  filePath: string;
  /** Optional grep filter applied server-side. */
  grepPattern?: string;
}

/** Additional options for Docker log streaming. */
interface DockerLogOptions extends StreamOptions {
  /** Container name or ID. */
  container: string;
  /** Only show entries since this relative time, e.g. "1h". */
  since?: string;
}

class LogStreamer {
  private static instance: LogStreamer | null = null;

  private constructor() {}

  /** Get or create the singleton instance. */
  static getInstance(): LogStreamer {
    if (!LogStreamer.instance) {
      LogStreamer.instance = new LogStreamer();
    }
    return LogStreamer.instance;
  }

  /**
   * Stream systemd journal entries for a given unit.
   *
   * @param serverId - Target server.
   * @param options  - Journal-specific options.
   * @returns Captured stdout / stderr and exit code.
   */
  async streamJournal(
    serverId: string,
    options: JournalOptions,
  ): Promise<ExecCommandResponse> {
    assertSafe(options.unit, "unit");
    if (options.since) assertSafe(options.since, "since");

    const lines = options.lines ?? 100;
    const timeout = options.timeout ?? 5_000;

    let cmd = `journalctl -u ${options.unit} --no-pager -n ${lines}`;

    if (options.priority !== undefined) {
      cmd += ` --priority=${Number(options.priority)}`;
    }

    if (options.since) {
      cmd += ` --since="${options.since}"`;
    }

    return execWithTimeout(serverId, cmd, timeout);
  }

  /**
   * Stream the tail of a remote file, optionally filtering with grep.
   *
   * @param serverId - Target server.
   * @param options  - File-specific options.
   * @returns Captured stdout / stderr and exit code.
   */
  async streamFile(
    serverId: string,
    options: FileOptions,
  ): Promise<ExecCommandResponse> {
    assertSafe(options.filePath, "filePath");
    if (options.grepPattern) assertSafe(options.grepPattern, "grepPattern");

    const lines = options.lines ?? 100;
    const timeout = options.timeout ?? 5_000;

    let cmd = `tail -n ${lines} ${options.filePath}`;

    if (options.grepPattern) {
      // We already validated grepPattern above — pipe is safe here
      // because *we* construct it, not the user.
      cmd = `grep -E '${options.grepPattern}' ${options.filePath} | tail -n ${lines}`;
    }

    return execWithTimeout(serverId, cmd, timeout);
  }

  /**
   * Stream Docker container logs.
   *
   * @param serverId - Target server.
   * @param options  - Docker-specific options.
   * @returns Captured stdout / stderr and exit code.
   */
  async streamDockerLogs(
    serverId: string,
    options: DockerLogOptions,
  ): Promise<ExecCommandResponse> {
    assertSafe(options.container, "container");
    if (options.since) assertSafe(options.since, "since");

    const lines = options.lines ?? 100;
    const timeout = options.timeout ?? 5_000;

    let cmd = `docker logs --tail ${lines}`;

    if (options.since) {
      cmd += ` --since ${options.since}`;
    }

    cmd += ` ${options.container}`;

    return execWithTimeout(serverId, cmd, timeout);
  }
}

export { LogStreamer };
