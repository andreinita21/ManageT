/**
 * Main command classification pipeline for ManageT.
 * Implements a three-tier system:
 *   Tier 1: Session override + user rules (from DB)
 *   Tier 2: Built-in safe/dangerous patterns
 *   Tier 3: Runtime heuristics
 *   Default: "ask"
 */

import type {
  ClassificationResult,
  RestartRule,
  RestartAction,
  Session,
} from "@/types";
import { SAFE_PATTERNS, DANGEROUS_PATTERNS } from "./patterns";
import { matchGlob, matchPattern } from "./matcher";
import { preprocessCommand } from "./preprocess";
import { evaluateHeuristics, type HeuristicContext } from "./heuristics";

/**
 * Fetch the session's restart policy from the database.
 * Returns null if no session override exists or if the module is unavailable.
 *
 * @param sessionId - The session identifier
 * @returns The session's restart policy or null
 */
async function getSessionOverride(
  sessionId: string
): Promise<RestartAction | null> {
  try {
    const { db } = await import("@/lib/db");
    const { sessions } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    const rows = await db
      .select({ restartPolicy: sessions.restartPolicy })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (rows.length > 0 && rows[0].restartPolicy !== "ask") {
      return rows[0].restartPolicy as RestartAction;
    }
  } catch {
    // DB unavailable — fall through to other tiers
  }

  return null;
}

/**
 * Fetch user-defined restart rules from the database, ordered by priority descending.
 * Filters rules by scope: session-specific, then server-specific, then global.
 *
 * @param serverId - Optional server identifier for scoping
 * @param sessionId - Optional session identifier for scoping
 * @returns Array of matching restart rules, highest priority first
 */
async function getUserRules(
  serverId?: string,
  sessionId?: string
): Promise<RestartRule[]> {
  try {
    const { db } = await import("@/lib/db");
    const { restartRules } = await import("@/lib/db/schema");
    const { desc, or, and, eq, isNull } = await import("drizzle-orm");

    const conditions = [eq(restartRules.scope, "global")];

    if (serverId) {
      conditions.push(
        and(
          eq(restartRules.scope, "server"),
          eq(restartRules.scopeId, serverId)
        )!
      );
    }

    if (sessionId) {
      conditions.push(
        and(
          eq(restartRules.scope, "session"),
          eq(restartRules.scopeId, sessionId)
        )!
      );
    }

    const rules = await db
      .select()
      .from(restartRules)
      .where(or(...conditions))
      .orderBy(desc(restartRules.priority));

    return rules as RestartRule[];
  } catch {
    // DB unavailable — fall through
    return [];
  }
}

/**
 * Check a single command against built-in dangerous patterns.
 *
 * @param command - The preprocessed command string
 * @returns True if the command matches any dangerous pattern
 */
function isDangerousBuiltin(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => matchGlob(command, pattern));
}

/**
 * Check a single command against built-in safe patterns.
 *
 * @param command - The preprocessed command string
 * @returns True if the command matches any safe pattern
 */
function isSafeBuiltin(command: string): boolean {
  return SAFE_PATTERNS.some((pattern) => matchGlob(command, pattern));
}

/**
 * Classify a command to determine its restart behavior.
 *
 * Pipeline order:
 *   1. Session override (if sessionId provided and session has explicit policy)
 *   2. User-defined rules from DB (matched by priority)
 *   3. Preprocess command, then check built-in dangerous patterns
 *   4. Check built-in safe patterns
 *   5. Runtime heuristics
 *   6. Default: "ask"
 *
 * @param command - The raw command string to classify
 * @param serverId - Optional server identifier for scoped rule lookup
 * @param sessionId - Optional session identifier for override and scoped rule lookup
 * @param heuristicContext - Optional runtime context for heuristic evaluation
 * @returns The classification result with action, source, and confidence
 */
export async function classifyCommand(
  command: string,
  serverId?: string,
  sessionId?: string,
  heuristicContext?: HeuristicContext
): Promise<ClassificationResult> {
  // Tier 1a: Session override
  if (sessionId) {
    const override = await getSessionOverride(sessionId);
    if (override && override !== "ask") {
      return {
        command,
        action: override,
        matchedBy: "session-override",
        confidence: "high",
      };
    }
  }

  // Tier 1b: User-defined rules
  const rules = await getUserRules(serverId, sessionId);
  const { commands } = preprocessCommand(command);

  for (const rule of rules) {
    for (const cmd of commands) {
      if (matchPattern(cmd, rule.pattern, rule.patternType)) {
        return {
          command,
          action: rule.action,
          matchedBy: "user-rule",
          ruleName: rule.pattern,
          confidence: "high",
        };
      }
    }
  }

  // Tier 2a: Built-in dangerous patterns
  for (const cmd of commands) {
    if (isDangerousBuiltin(cmd)) {
      return {
        command,
        action: "never",
        matchedBy: "builtin-dangerous",
        confidence: "high",
      };
    }
  }

  // Tier 2b: Built-in safe patterns
  // All commands in the chain must be safe for the overall classification to be safe.
  // If any single command is safe and none are dangerous, classify as safe.
  let anySafe = false;
  for (const cmd of commands) {
    if (isSafeBuiltin(cmd)) {
      anySafe = true;
    }
  }

  if (anySafe) {
    return {
      command,
      action: "auto",
      matchedBy: "builtin-safe",
      confidence: "high",
    };
  }

  // Tier 3: Runtime heuristics
  const context: HeuristicContext = heuristicContext ?? {};
  // Evaluate heuristics against the first (primary) command
  const primaryCommand = commands[0] ?? command;
  const heuristicResult = evaluateHeuristics(primaryCommand, context);

  if (heuristicResult.triggeredHeuristics.length > 0 && heuristicResult.action !== "ask") {
    return {
      command,
      action: heuristicResult.action,
      matchedBy: "heuristic",
      ruleName: heuristicResult.triggeredHeuristics.join(", "),
      confidence: heuristicResult.confidence,
    };
  }

  // Default: ask the user
  return {
    command,
    action: "ask",
    matchedBy: "default",
    confidence: "low",
  };
}
