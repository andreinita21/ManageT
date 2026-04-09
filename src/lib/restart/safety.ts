/**
 * Crash loop detection and auto-restart rate limiter.
 * Prevents runaway restart loops for commands that keep crashing.
 */

/**
 * Record of a single restart attempt.
 */
interface RestartAttempt {
  timestamp: number;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Configuration for crash loop detection.
 */
interface CrashLoopConfig {
  /** Maximum number of restarts allowed within the time window */
  maxRestarts: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Minimum duration (ms) a process must run to not be considered a crash */
  minRunDurationMs: number;
  /** Cooldown period (ms) after a crash loop is detected */
  cooldownMs: number;
}

const DEFAULT_CONFIG: CrashLoopConfig = {
  maxRestarts: 5,
  windowMs: 300_000, // 5 minutes
  minRunDurationMs: 5_000, // 5 seconds
  cooldownMs: 60_000, // 1 minute
};

/**
 * Tracks restart attempts per session-command pair and detects crash loops.
 */
export class CrashLoopDetector {
  private attempts: Map<string, RestartAttempt[]> = new Map();
  private cooldowns: Map<string, number> = new Map();
  private config: CrashLoopConfig;

  /**
   * Create a new CrashLoopDetector.
   *
   * @param config - Optional configuration overrides
   */
  constructor(config?: Partial<CrashLoopConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate a key for the session-command pair.
   *
   * @param sessionId - The session identifier
   * @param command - The command string
   * @returns A unique key string
   */
  private key(sessionId: string, command: string): string {
    return `${sessionId}::${command}`;
  }

  /**
   * Record a restart attempt for a given session and command.
   *
   * @param sessionId - The session identifier
   * @param command - The command that was restarted
   * @param exitCode - The exit code of the process (null if unknown)
   * @param durationMs - How long the process ran before exiting
   */
  recordAttempt(
    sessionId: string,
    command: string,
    exitCode: number | null,
    durationMs: number
  ): void {
    const k = this.key(sessionId, command);
    const attempts = this.attempts.get(k) ?? [];

    attempts.push({
      timestamp: Date.now(),
      exitCode,
      durationMs,
    });

    // Prune old attempts outside the window
    const cutoff = Date.now() - this.config.windowMs;
    const pruned = attempts.filter((a) => a.timestamp >= cutoff);

    this.attempts.set(k, pruned);
  }

  /**
   * Check if a command is in a crash loop for the given session.
   * A crash loop is detected when there are too many restarts within the
   * time window and the process keeps exiting quickly.
   *
   * @param sessionId - The session identifier
   * @param command - The command to check
   * @returns True if the command appears to be in a crash loop
   */
  isCrashLooping(sessionId: string, command: string): boolean {
    const k = this.key(sessionId, command);

    // Check cooldown
    const cooldownUntil = this.cooldowns.get(k) ?? 0;
    if (Date.now() < cooldownUntil) {
      return true;
    }

    const attempts = this.attempts.get(k) ?? [];
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const recent = attempts.filter((a) => a.timestamp >= cutoff);

    if (recent.length < this.config.maxRestarts) {
      return false;
    }

    // Count crashes: short-lived processes with non-zero exit codes
    const crashes = recent.filter(
      (a) =>
        a.durationMs < this.config.minRunDurationMs &&
        a.exitCode !== null &&
        a.exitCode !== 0
    );

    if (crashes.length >= this.config.maxRestarts) {
      // Enter cooldown
      this.cooldowns.set(k, now + this.config.cooldownMs);
      return true;
    }

    return false;
  }

  /**
   * Check whether restarting a command is allowed (not crash-looping
   * and under the rate limit).
   *
   * @param sessionId - The session identifier
   * @param command - The command to check
   * @returns Whether the restart should be allowed
   */
  canRestart(sessionId: string, command: string): boolean {
    return !this.isCrashLooping(sessionId, command);
  }

  /**
   * Reset tracking state for a specific session and command.
   *
   * @param sessionId - The session identifier
   * @param command - The command to reset
   */
  reset(sessionId: string, command: string): void {
    const k = this.key(sessionId, command);
    this.attempts.delete(k);
    this.cooldowns.delete(k);
  }

  /**
   * Clear all tracking state.
   */
  clearAll(): void {
    this.attempts.clear();
    this.cooldowns.clear();
  }
}

/** Singleton crash loop detector instance. */
export const crashLoopDetector = new CrashLoopDetector();
