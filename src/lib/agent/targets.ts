/**
 * Agent target triple mapping.
 *
 * The dashboard's SSH-push installer runs `uname -sm` on the remote host to
 * discover what binary to upload. This module defines the allowlist and the
 * mapping.
 *
 * Cache semantics — important caveat for the build-on-target fallback:
 * ---------------------------------------------------------------------
 * The `aarch64-unknown-linux-musl` and `x86_64-unknown-linux-musl` entries
 * are the Rust target triples used by the pre-built path
 * (`npm run build:agent` with rustup + cross-compiled musl toolchains).
 *
 * When the dashboard falls back to compiling the agent on the remote host,
 * it runs a plain `cargo build --release` with whatever default toolchain
 * rustup bootstrapped — which on a typical Linux box is glibc, not musl.
 * The resulting binary still gets cached under the `-musl` directory
 * because that's the bucket we picked from `uname -sm`.
 *
 * This is fine in practice because:
 *   1. The cached binary is only reused on hosts with the same uname
 *      output, i.e. the same CPU arch + kernel family.
 *   2. A glibc binary built on Pi A will run on Pi B if they share a
 *      similar glibc version, which is the common case for a fleet of
 *      identically-provisioned servers.
 *
 * It's NOT fine if your fleet mixes glibc versions wildly or mixes
 * musl-only environments (Alpine) with glibc. In that case, either
 * pre-build proper musl binaries via `npm run build:agent`, or clear the
 * `data/agent-binaries/` cache between installs so each host builds
 * fresh for itself.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Rust target triples the build script produces. */
export const AGENT_TARGETS = [
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
] as const;

export type AgentTarget = (typeof AGENT_TARGETS)[number];

export function isAgentTarget(s: string): s is AgentTarget {
  return (AGENT_TARGETS as readonly string[]).includes(s);
}

/**
 * Translate the output of `uname -sm` (e.g. `Linux x86_64`, `Darwin arm64`)
 * into a Rust target triple. Returns null for unsupported combinations.
 */
export function targetFromUname(uname: string): AgentTarget | null {
  const normalized = uname.trim().toLowerCase();
  // Accept either "os arch" (uname -sm) or just reasonable fragments.
  const [os, arch] = normalized.split(/\s+/);
  if (!os || !arch) return null;

  if (os === "linux") {
    if (arch === "x86_64" || arch === "amd64") return "x86_64-unknown-linux-musl";
    if (arch === "aarch64" || arch === "arm64") return "aarch64-unknown-linux-musl";
    return null;
  }
  if (os === "darwin") {
    if (arch === "arm64" || arch === "aarch64") return "aarch64-apple-darwin";
    if (arch === "x86_64") return "x86_64-apple-darwin";
    return null;
  }
  return null;
}

/** Directory on the dashboard host where built binaries live. */
export function binariesDir(): string {
  return join(process.cwd(), "data", "agent-binaries");
}

/** Full filesystem path for a given target's binary. */
export function binaryPath(target: AgentTarget): string {
  return join(binariesDir(), target, "managet-agent");
}

/** Returns true iff `npm run build:agent` has produced this target. */
export function binaryExists(target: AgentTarget): boolean {
  try {
    return existsSync(binaryPath(target)) && statSync(binaryPath(target)).isFile();
  } catch {
    return false;
  }
}
