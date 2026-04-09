/**
 * Restart classification module for ManageT.
 * Placeholder — will be implemented by the restart-policy agent.
 */
import type { ClassificationResult } from "@/types";

/**
 * Classify a command to determine restart behavior.
 * Currently returns a default "ask" classification.
 */
export function classifyCommand(command: string): ClassificationResult {
  return {
    command,
    action: "ask",
    matchedBy: "default",
    confidence: "low",
  };
}
