/**
 * Restart classification module for ManageT.
 * Re-exports all public APIs from the restart subsystem.
 */

export { SAFE_PATTERNS, DANGEROUS_PATTERNS } from "./patterns";
export { matchGlob, matchRegex, matchExact, matchPattern } from "./matcher";
export {
  normalizeCommand,
  stripSudo,
  splitChain,
  getFirstPipeCommand,
  preprocessCommand,
} from "./preprocess";
export { evaluateHeuristics } from "./heuristics";
export type { HeuristicContext } from "./heuristics";
export { classifyCommand } from "./classify";
export { CrashLoopDetector, crashLoopDetector } from "./safety";
