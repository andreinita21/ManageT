/**
 * Pattern matching engine for command classification.
 * Implements glob, regex, and exact matching without external dependencies.
 */

import type { RestartRule } from "@/types";

/**
 * Match a command against a glob pattern (fnmatch-style).
 * Supports `*` as a wildcard matching any sequence of characters.
 * Matching is case-insensitive.
 *
 * @param command - The command string to test
 * @param pattern - The glob pattern (supports `*` wildcard)
 * @returns True if the command matches the pattern
 */
export function matchGlob(command: string, pattern: string): boolean {
  const cmd = command.toLowerCase();
  const pat = pattern.toLowerCase();

  // Convert glob pattern to regex
  let regexStr = "^";
  for (let i = 0; i < pat.length; i++) {
    const char = pat[i];
    if (char === "*") {
      regexStr += ".*";
    } else if (char === "?") {
      regexStr += ".";
    } else if (".+^${}()|[]\\".includes(char)) {
      regexStr += "\\" + char;
    } else {
      regexStr += char;
    }
  }
  regexStr += "$";

  try {
    return new RegExp(regexStr).test(cmd);
  } catch {
    return false;
  }
}

/**
 * Match a command against a regular expression pattern.
 * The regex is tested case-insensitively.
 *
 * @param command - The command string to test
 * @param pattern - The regex pattern string
 * @returns True if the command matches the regex
 */
export function matchRegex(command: string, pattern: string): boolean {
  try {
    const regex = new RegExp(pattern, "i");
    return regex.test(command);
  } catch {
    return false;
  }
}

/**
 * Match a command against an exact string (case-insensitive).
 *
 * @param command - The command string to test
 * @param pattern - The exact string to match
 * @returns True if the command equals the pattern (case-insensitive)
 */
export function matchExact(command: string, pattern: string): boolean {
  return command.toLowerCase() === pattern.toLowerCase();
}

/**
 * Match a command against a pattern using the specified matching type.
 *
 * @param command - The command string to test
 * @param pattern - The pattern to match against
 * @param type - The type of matching: "glob", "regex", or "exact"
 * @returns True if the command matches the pattern
 */
export function matchPattern(
  command: string,
  pattern: string,
  type: RestartRule["patternType"]
): boolean {
  switch (type) {
    case "glob":
      return matchGlob(command, pattern);
    case "regex":
      return matchRegex(command, pattern);
    case "exact":
      return matchExact(command, pattern);
    default:
      return false;
  }
}
