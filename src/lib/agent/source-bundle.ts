/**
 * Agent source tarball builder.
 *
 * When the dashboard's SSH-push installer can't find a pre-built binary
 * for a target architecture, it falls back to compiling the agent on the
 * target itself. To do that it needs to ship the Rust source over SSH.
 * This module produces a gzipped tarball of `agent/` (just Cargo.toml,
 * Cargo.lock, and src/ — no build artifacts) and caches it in memory
 * for the lifetime of the process.
 *
 * The tarball is built lazily on first request and invalidated only by a
 * process restart. That's fine in practice because editing agent source
 * requires a dashboard restart to pick up UI / backend changes anyway.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Absolute path to the agent source directory on the dashboard host. */
const SOURCE_DIR = join(process.cwd(), "agent");

/** Where the cached tarball is written. Lives under data/ so it's gitignored. */
const CACHE_DIR = join(process.cwd(), "data", "agent-source");
const TARBALL_PATH = join(CACHE_DIR, "agent-src.tar.gz");

/** In-process cache of the tarball-building promise. */
let bundlePromise: Promise<string> | null = null;

/**
 * Resolve the path to a fresh tarball of the agent source. Subsequent
 * callers within the same process share the same tarball.
 */
export async function getAgentSourceTarball(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = buildTarball().catch((err) => {
      // Reset so the next caller can retry.
      bundlePromise = null;
      throw err;
    });
  }
  return bundlePromise;
}

/**
 * Invoke `tar` to bundle the agent source. Uses the system `tar` which
 * is present on both macOS (bsdtar) and Linux (gnu tar). We only include
 * the files cargo actually needs so the tarball stays small (<100 KB).
 */
async function buildTarball(): Promise<string> {
  if (!existsSync(SOURCE_DIR)) {
    throw new Error(`agent source directory not found: ${SOURCE_DIR}`);
  }
  if (!existsSync(join(SOURCE_DIR, "Cargo.toml"))) {
    throw new Error(
      `agent/Cargo.toml is missing — repo layout unexpected`
    );
  }
  mkdirSync(CACHE_DIR, { recursive: true });

  // Explicit file list avoids any platform differences around --exclude
  // flags. We include Cargo.lock so builds on the target are reproducible.
  const args = [
    "-czf",
    TARBALL_PATH,
    "-C",
    SOURCE_DIR,
    "Cargo.toml",
    "Cargo.lock",
    "src",
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      reject(new Error(`failed to spawn tar: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(TARBALL_PATH);
      } else {
        reject(new Error(`tar exited with ${code}: ${stderr.trim()}`));
      }
    });
  });
}
