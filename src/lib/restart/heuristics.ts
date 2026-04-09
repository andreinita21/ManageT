/**
 * Tier 3 runtime heuristics for command classification.
 * Used when built-in patterns don't match a command.
 */

import type { RestartAction } from "@/types";

/**
 * Context information available for heuristic evaluation.
 */
export interface HeuristicContext {
  /** Number of times this exact command has been executed in recent history */
  executionCount?: number;
  /** Average duration (ms) of previous executions of this command */
  avgDurationMs?: number;
  /** Whether the command previously exited with code 0 */
  previousSuccess?: boolean;
  /** The working directory where the command runs */
  cwd?: string;
  /** Port numbers known to be in use on the server */
  portsInUse?: number[];
}

/**
 * Result of a single heuristic check.
 */
interface HeuristicSignal {
  name: string;
  triggered: boolean;
  suggestedAction: RestartAction;
  weight: number;
}

/**
 * Check if a command appears to bind a network port.
 *
 * @param command - The preprocessed command string
 * @returns A heuristic signal
 */
function checkBindsPort(command: string): HeuristicSignal {
  const portPatterns = [
    /--port\s+\d+/i,
    /-p\s+\d+/i,
    /:\d{4,5}/,
    /listen\s+\d+/i,
    /PORT=\d+/i,
    /--bind\s+/i,
    /0\.0\.0\.0/,
    /127\.0\.0\.1/,
    /localhost:\d+/i,
  ];

  const triggered = portPatterns.some((pattern) => pattern.test(command));

  return {
    name: "binds_port",
    triggered,
    suggestedAction: "auto",
    weight: 3,
  };
}

/**
 * Check if a command has been executed repeatedly (indicating it's a routine operation).
 *
 * @param command - The preprocessed command string
 * @param context - Runtime context
 * @returns A heuristic signal
 */
function checkRepeatedExecution(
  command: string,
  context: HeuristicContext
): HeuristicSignal {
  const count = context.executionCount ?? 0;
  const triggered = count >= 3 && (context.previousSuccess ?? false);

  return {
    name: "repeated_execution",
    triggered,
    suggestedAction: "auto",
    weight: 2,
  };
}

/**
 * Check if a command is likely a long-running process based on indicators.
 *
 * @param command - The preprocessed command string
 * @param context - Runtime context
 * @returns A heuristic signal
 */
function checkLongRunningProcess(
  command: string,
  context: HeuristicContext
): HeuristicSignal {
  const longRunningIndicators = [
    /\bserve\b/i,
    /\bserver\b/i,
    /\bwatch\b/i,
    /\bdev\b/i,
    /\bdaemon\b/i,
    /\blisten\b/i,
    /--watch/i,
    /-w\b/,
    /\bstart\b/i,
    /\brun\b/i,
  ];

  const patternMatch = longRunningIndicators.some((pattern) =>
    pattern.test(command)
  );
  const durationMatch = (context.avgDurationMs ?? 0) > 30_000;
  const triggered = patternMatch || durationMatch;

  return {
    name: "long_running_process",
    triggered,
    suggestedAction: "auto",
    weight: 2,
  };
}

/**
 * Check if a command writes to the filesystem (potentially non-idempotent).
 *
 * @param command - The preprocessed command string
 * @returns A heuristic signal
 */
function checkWritesToFilesystem(command: string): HeuristicSignal {
  const writePatterns = [
    /\s*>\s+/,   // redirect output
    /\s*>>\s+/,  // append output
    /\btee\b/i,
    /\bmkdir\b/i,
    /\btouch\b/i,
    /\bwrite\b/i,
    /\bsave\b/i,
    /--output\b/i,
    /-o\s+\S+/i,
  ];

  const triggered = writePatterns.some((pattern) => pattern.test(command));

  return {
    name: "writes_to_filesystem",
    triggered,
    suggestedAction: "ask",
    weight: 2,
  };
}

/**
 * Evaluate all heuristics against a command and its runtime context.
 * Returns a suggested action based on weighted signals.
 *
 * @param command - The preprocessed command string
 * @param context - Runtime context for heuristic evaluation
 * @returns Object with the suggested action, confidence, and list of triggered heuristic names
 */
export function evaluateHeuristics(
  command: string,
  context: HeuristicContext
): {
  action: RestartAction;
  confidence: "medium" | "low";
  triggeredHeuristics: string[];
} {
  const signals: HeuristicSignal[] = [
    checkBindsPort(command),
    checkRepeatedExecution(command, context),
    checkLongRunningProcess(command, context),
    checkWritesToFilesystem(command),
  ];

  const triggered = signals.filter((s) => s.triggered);
  const triggeredNames = triggered.map((s) => s.name);

  if (triggered.length === 0) {
    return { action: "ask", confidence: "low", triggeredHeuristics: [] };
  }

  // Compute weighted vote
  let autoWeight = 0;
  let askWeight = 0;
  let neverWeight = 0;

  for (const signal of triggered) {
    switch (signal.suggestedAction) {
      case "auto":
        autoWeight += signal.weight;
        break;
      case "ask":
        askWeight += signal.weight;
        break;
      case "never":
        neverWeight += signal.weight;
        break;
    }
  }

  // "never" takes precedence, then "ask" over "auto" unless auto is significantly higher
  let action: RestartAction;
  if (neverWeight > 0) {
    action = "never";
  } else if (autoWeight > askWeight) {
    action = "auto";
  } else if (askWeight > 0) {
    action = "ask";
  } else {
    action = "auto";
  }

  const confidence = triggered.length >= 2 ? "medium" as const : "low" as const;

  return { action, confidence, triggeredHeuristics: triggeredNames };
}
