/**
 * Shared credential resolution for dev/ops scripts.
 *
 * Secrets must never be hardcoded in committed scripts. Each helper reads
 * from an environment variable and fails loudly if it's missing, so a
 * forgotten export surfaces immediately instead of silently falling back
 * to a baked-in default that then ends up in git history.
 */

export function requireEnv(name: string, hint?: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}.` +
        (hint ? ` ${hint}` : "") +
        ` e.g. ${name}='…' npx tsx scripts/<script>.ts`
    );
  }
  return v;
}

/** Admin / dashboard login password used by the login-flow scripts. */
export const adminPassword = (): string =>
  requireEnv("MANAGET_ADMIN_PASSWORD", "Set it to the dashboard admin password.");

/** SSH password for the dev test hosts. */
export const devSshPassword = (): string =>
  requireEnv("MANAGET_DEV_PASSWORD", "Set it to the dev host SSH password.");
