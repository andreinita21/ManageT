/**
 * Command preprocessing utilities.
 * Normalizes, strips, and splits commands before classification.
 */

/**
 * Normalize a command string by trimming whitespace and collapsing
 * multiple spaces into single spaces.
 *
 * @param command - The raw command string
 * @returns The normalized command string
 */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Strip `sudo` prefix (with optional flags) from a command.
 * Handles `sudo`, `sudo -u user`, `sudo -E`, etc.
 *
 * @param command - The command string, possibly prefixed with sudo
 * @returns The command without the sudo prefix
 */
export function stripSudo(command: string): string {
  // Match sudo followed by optional flags (-u user, -E, -H, etc.)
  // The -u flag with its argument must be checked before generic short flags
  const sudoPattern = /^sudo\s+(?:(?:-[A-Za-z]+\s+)*(?:-u\s+\S+\s+)(?:-[A-Za-z]+\s+)*|(?:-[A-Za-z]+\s+)*)/;
  return command.replace(sudoPattern, "").trim();
}

/**
 * Split a chained command string into individual commands.
 * Handles `&&`, `||`, and `;` separators.
 * Respects single and double quotes (does not split inside them).
 *
 * @param command - The command string possibly containing chains
 * @returns Array of individual command strings
 */
export function splitChain(command: string): string[] {
  const commands: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    // Handle escape sequences
    if (char === "\\" && i + 1 < command.length) {
      current += char + command[i + 1];
      i += 2;
      continue;
    }

    // Toggle quote states
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      i++;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += char;
      i++;
      continue;
    }

    // Outside quotes, check for chain operators
    if (!inSingle && !inDouble) {
      if (char === ";" || (char === "&" && command[i + 1] === "&") || (char === "|" && command[i + 1] === "|")) {
        const trimmed = current.trim();
        if (trimmed) {
          commands.push(trimmed);
        }
        current = "";
        // Skip the second character of && or ||
        if (char !== ";") {
          i++;
        }
        i++;
        continue;
      }
    }

    current += char;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) {
    commands.push(trimmed);
  }

  return commands;
}

/**
 * Extract the first command in a pipe chain.
 * For `cmd1 | cmd2 | cmd3`, returns `cmd1`.
 * Respects quotes.
 *
 * @param command - The command string possibly containing pipes
 * @returns The first command before any pipe
 */
export function getFirstPipeCommand(command: string): string {
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const char = command[i];

    if (char === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }

    // Pipe (single |, but not ||)
    if (char === "|" && !inSingle && !inDouble) {
      if (command[i + 1] === "|") {
        // This is ||, skip both characters
        i += 2;
        continue;
      }
      return command.slice(0, i).trim();
    }

    i++;
  }

  return command.trim();
}

/**
 * Full preprocessing pipeline for a command.
 * Normalizes, strips sudo, and splits chains.
 * Each resulting command also has its first pipe segment extracted.
 *
 * @param command - The raw command string
 * @returns Object with the normalized form and array of individual commands
 */
export function preprocessCommand(command: string): {
  normalized: string;
  commands: string[];
} {
  const normalized = normalizeCommand(command);
  const stripped = stripSudo(normalized);
  const chained = splitChain(stripped);

  const commands = chained.map((cmd) => {
    const withoutSudo = stripSudo(cmd);
    return getFirstPipeCommand(withoutSudo);
  });

  return { normalized, commands };
}
