/**
 * @fileoverview Current working directory tracker for ManageT SSH sessions.
 * Injects PROMPT_COMMAND into remote shells to track CWD changes
 * and provides a fallback periodic polling mechanism.
 */
import type { ClientChannel } from "ssh2";

/** Start marker for CWD extraction from terminal output */
const CWD_MARKER_START = "__MANAGET_CWD__";

/** End marker for CWD extraction from terminal output */
const CWD_MARKER_END = "__MANAGET_CWD__";

/** Regex to match CWD markers in terminal output, including the surrounding newlines */
const CWD_PATTERN = new RegExp(
  `${CWD_MARKER_START}(.+?)${CWD_MARKER_END}\\r?\\n?`,
  "g"
);

/** Result of extracting CWD from terminal data */
interface CwdExtractResult {
  /** Terminal data with CWD markers stripped */
  cleanData: string;
  /** Extracted CWD path, if found (last occurrence wins) */
  cwd?: string;
}

/**
 * Tracks the current working directory for remote SSH sessions.
 * Uses PROMPT_COMMAND injection and periodic fallback polling.
 */
export class CwdTracker {
  private readonly fallbackTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Inject a PROMPT_COMMAND into the remote shell that echoes the CWD
   * wrapped in markers after every command.
   * @param stream - The SSH channel to write to
   */
  injectPromptCommand(stream: ClientChannel): void {
    const cmd =
      `export PROMPT_COMMAND='echo ${CWD_MARKER_START}$(pwd)${CWD_MARKER_END}'\n`;
    if (!stream.write(cmd)) {
      stream.once("drain", () => {
        // Backpressure resolved, command was already queued
      });
    }
  }

  /**
   * Extract the CWD from terminal output data and strip the markers.
   * If multiple CWD markers appear, the last one is used.
   * @param data - Raw terminal output string
   * @returns Object with cleaned data and optionally extracted cwd
   */
  extractCwd(data: string): CwdExtractResult {
    let cwd: string | undefined;
    const cleanData = data.replace(CWD_PATTERN, (_match, cwdPath: string) => {
      cwd = cwdPath.trim();
      return "";
    });
    return { cleanData, cwd };
  }

  /**
   * Start a periodic fallback that runs `pwd` on the remote shell
   * to detect CWD changes when PROMPT_COMMAND is unavailable.
   * @param sessionId - Session ID for tracking the timer
   * @param stream - The SSH channel to write to
   * @param interval - Polling interval in milliseconds (default 10000)
   * @returns The timer reference
   */
  startPeriodicFallback(
    sessionId: string,
    stream: ClientChannel,
    interval = 10000
  ): NodeJS.Timeout {
    this.stopPeriodicFallback(sessionId);

    const timer = setInterval(() => {
      const cmd = `echo ${CWD_MARKER_START}$(pwd)${CWD_MARKER_END}\n`;
      if (!stream.writable) {
        this.stopPeriodicFallback(sessionId);
        return;
      }
      if (!stream.write(cmd)) {
        stream.once("drain", () => {
          // Backpressure resolved
        });
      }
    }, interval);

    this.fallbackTimers.set(sessionId, timer);
    return timer;
  }

  /**
   * Stop the periodic fallback polling for a session.
   * @param sessionId - Session ID whose timer should be cleared
   */
  stopPeriodicFallback(sessionId: string): void {
    const timer = this.fallbackTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.fallbackTimers.delete(sessionId);
    }
  }
}

/** Singleton CWD tracker instance */
export const cwdTracker = new CwdTracker();
