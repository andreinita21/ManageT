/**
 * SSH-push installer for the Rust agent.
 *
 * When a user adds a server to the dashboard, this module takes over in the
 * background:
 *   1. Generate a bearer token, persist its sha256 hash.
 *   2. Open an SSH connection using the user's credentials.
 *   3. Detect the remote OS/arch via `uname -sm`.
 *   4. Ensure a cached binary for that target exists on the dashboard host.
 *      If not, fall back to BUILDING the agent on the target itself
 *      (installs rustup if missing, ships the source, runs cargo build,
 *      downloads the binary back, caches it under data/agent-binaries/).
 *      Subsequent installs of the same arch reuse the cached result.
 *   5. SFTP-upload the (cached) binary to /tmp.
 *   6. Run `managet-agent install --non-interactive --token <tok>`. (We use a
 *      CLI flag rather than an env var because `sudo` with the default
 *      `env_reset` policy strips user-set env vars before exec.)
 *   7. Clean up the staging file and record the result in the `servers` row.
 *
 * Progress is written to `servers.agent_install_stage` as it goes so the
 * dashboard UI can render a live progress panel.
 */

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import type { Client as SshClient, SFTPWrapper } from "ssh2";

import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { rowToServer } from "@/lib/db/transform";
import { decryptPassword } from "@/lib/crypto";
import { connectionPool } from "@/lib/ssh/connection-pool";
import { executeCommand } from "@/lib/ssh/exec";
import { generateToken, hashToken } from "./token";
import { getAgentSourceTarball } from "./source-bundle";
import {
  binaryExists,
  binaryPath,
  cliBinaryExists,
  cliBinaryPath,
  targetFromUname,
  type AgentTarget,
} from "./targets";

/** Result of an SSH-push install attempt. */
export interface InstallResult {
  ok: boolean;
  error?: string;
  target?: AgentTarget;
}

/**
 * Per-target build locks. If two servers of the same arch are added at the
 * same time, the second one waits for the first to finish building instead
 * of wasting cycles on a duplicate `cargo build --release`.
 *
 * The lock stores the in-flight promise so the second caller can just await
 * it. If the first build fails, the lock is cleared and the second caller
 * retries on its own (which is fine — the failure may have been environmental
 * on the first target host).
 */
const buildLocks = new Map<AgentTarget, Promise<void>>();

/**
 * Install the agent on a server by ID. Caller should NOT await this in a
 * request handler — pass it to `void installAgent(id).catch(...)` so the
 * API can return a 201 immediately.
 */
export async function installAgent(serverId: string): Promise<InstallResult> {
  // Step 1 — mint a token.
  const token = generateToken();
  const tokenHash = hashToken(token);

  await setStage(serverId, "installing", "starting", { agentTokenHash: tokenHash });

  try {
    // Step 2 — load server row and open SSH.
    const rows = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("server not found");
    const server = rowToServer(row);

    await setStage(serverId, "installing", "connecting via SSH");
    const client = await connectionPool.connect(server);

    // Resolve the dashboard URL the agent should call back into. We do this
    // *after* the SSH connection is open so we can ask the target host which
    // IP it sees us coming from (via the SSH_CLIENT env var). That's the most
    // reliable way to get a usable callback URL on a LAN where mDNS hostname
    // resolution may be broken.
    const dashboardUrl = await resolveDashboardUrl(serverId);

    // Step 3 — detect remote OS/arch.
    await setStage(serverId, "installing", "detecting OS and architecture");
    const unameRes = await executeCommand(serverId, "uname -sm", undefined, 10_000);
    if (unameRes.exitCode !== 0) {
      throw new Error(`uname failed: ${unameRes.stderr || unameRes.stdout}`);
    }
    const target = targetFromUname(unameRes.stdout);
    if (!target) {
      throw new Error(
        `unsupported OS/arch: ${unameRes.stdout.trim()} — supported targets are Linux (x86_64/aarch64) and Darwin (arm64/x86_64)`
      );
    }
    // If no cached binary exists for this target, fall back to compiling the
    // agent on the remote host itself. The result is cached under
    // data/agent-binaries/<target>/ so subsequent installs of the same arch
    // are instant.
    await ensureBinaryForTarget(serverId, client, target);

    await db
      .update(servers)
      .set({ agentArch: target, updatedAt: Date.now() })
      .where(eq(servers.id, serverId));

    // Step 4 — SFTP upload to /tmp. Both binaries land in the same
    // staging dir so the agent's own installer can find the `managet`
    // CLI sibling and copy it into /usr/local/bin/managet.
    const stageDir = `/tmp/managet-install-${randomUUID()}`;
    const remotePath = `${stageDir}/managet-agent`;
    const remoteCliPath = `${stageDir}/managet`;
    const localPath = binaryPath(target);
    const localCliPath = cliBinaryPath(target);
    const haveCli = cliBinaryExists(target);

    const sizeMsg = haveCli
      ? `${formatBytes((await stat(localPath)).size + (await stat(localCliPath)).size)}`
      : `${formatBytes((await stat(localPath)).size)}`;
    await setStage(
      serverId,
      "installing",
      `uploading agent binaries (${sizeMsg})`
    );
    const mkdirRes = await executeCommand(
      serverId,
      `mkdir -p ${shellEscape(stageDir)}`,
      undefined,
      5_000
    );
    if (mkdirRes.exitCode !== 0) {
      throw new Error(`mkdir staging failed: ${mkdirRes.stderr || mkdirRes.stdout}`);
    }
    await sftpUpload(client, localPath, remotePath);
    if (haveCli) {
      await sftpUpload(client, localCliPath, remoteCliPath);
    }
    // If the cached CLI binary is missing, the agent installer's
    // fallback creates `/usr/local/bin/managet` as a symlink to the
    // service binary — `managet ls`, `managet attach` etc. still work
    // because the service binary's CLI tree includes those subcommands.

    // Step 5 — chmod + run install.
    await setStage(serverId, "installing", "installing service");
    const chmodRes = await executeCommand(
      serverId,
      `chmod +x ${shellEscape(remotePath)}` +
        (haveCli ? ` ${shellEscape(remoteCliPath)}` : ""),
      undefined,
      10_000
    );
    if (chmodRes.exitCode !== 0) {
      throw new Error(`chmod failed: ${chmodRes.stderr || chmodRes.stdout}`);
    }

    // Detect sudo strategy. Three cases:
    //   1. Session user is root → no sudo prefix at all.
    //   2. Session user isn't root and we have the password they entered
    //      when adding the server → use `sudo -S` and pipe the password
    //      to stdin. `-p ''` silences the prompt so it doesn't pollute
    //      stdout.
    //   3. Non-root and no stored password (key auth) → try `sudo -n`
    //      (non-interactive). Fails loud with a clear error if sudo
    //      requires a password, since we have no way to provide one.
    const whoRes = await executeCommand(serverId, "id -u", undefined, 5_000);
    const isRoot = whoRes.stdout.trim() === "0";

    let sudoPrefix = "";
    let sudoStdin: string | undefined;
    if (!isRoot) {
      if (server.passwordEncrypted) {
        const sudoPassword = decryptPassword(server.passwordEncrypted);
        sudoPrefix = "sudo -S -p '' ";
        // Trailing newline terminates sudo's read() of the password.
        sudoStdin = sudoPassword + "\n";
      } else {
        sudoPrefix = "sudo -n ";
      }
    }

    // Pass the token via `--token` rather than `MANAGET_AGENT_TOKEN` in the
    // environment: `sudo` with a restrictive `env_reset` policy (the Ubuntu
    // default) strips user-set env vars before execing the target, so the
    // env-based approach silently loses the token. The CLI flag is visible
    // in `ps` for the few seconds the install runs — acceptable, since the
    // token would be on the remote filesystem (`/etc/managet-agent/config.toml`)
    // immediately afterwards anyway.
    const installCmd =
      `${sudoPrefix}${shellEscape(remotePath)} install ` +
      `--non-interactive ` +
      `--api-url ${shellEscape(dashboardUrl)} ` +
      `--server-id ${shellEscape(serverId)} ` +
      `--token ${shellEscape(token)}`;
    const installRes = await executeCommand(
      serverId,
      installCmd,
      undefined,
      60_000,
      sudoStdin
    );
    if (installRes.exitCode !== 0) {
      throw new Error(
        `install command failed (exit ${installRes.exitCode}):\nSTDOUT: ${installRes.stdout}\nSTDERR: ${installRes.stderr}`
      );
    }

    // Step 6 — clean up staging dir.
    await executeCommand(
      serverId,
      `${sudoPrefix}rm -rf ${shellEscape(stageDir)}`,
      undefined,
      10_000,
      sudoStdin
    ).catch(() => {
      /* best-effort */
    });

    // Step 7 — Proactive connectivity probe.
    //
    // The install command succeeded, which means the agent binary is on
    // disk, the config file is written, and the service is registered with
    // systemd/launchd. But none of that proves the agent can actually reach
    // the dashboard from its perspective. The most painful failure mode here
    // is "install succeeded, but the URL we baked into config.toml isn't
    // reachable from the target" — wrong host, wrong port, firewall, etc.
    //
    // Rather than waiting 60s for the watchdog to trip, run a curl from the
    // target host *itself* against the validate-token endpoint. This proves
    // end-to-end:
    //   1. The api_url we computed is reachable from the target.
    //   2. The bearer token roundtrips correctly.
    //   3. There's no firewall / TLS / proxy weirdness in the middle.
    //
    // If the probe fails, we report curl's exit code and stderr, which is
    // dramatically more useful than the generic watchdog timeout.
    await setStage(serverId, "installing", "verifying agent → dashboard connectivity");
    const probeUrl = `${dashboardUrl}/api/agent/validate-token`;
    const probeCmd =
      `curl -fsS -m 8 -X POST ` +
      `-H ${shellEscape(`Authorization: Bearer ${token}`)} ` +
      `-H 'Content-Type: application/json' -d '{}' ` +
      `${shellEscape(probeUrl)}`;
    const probeRes = await executeCommand(serverId, probeCmd, undefined, 15_000);
    if (probeRes.exitCode !== 0) {
      throw new Error(
        `connectivity probe failed: agent installed but cannot reach the dashboard at ${dashboardUrl}.\n` +
          `curl exit ${probeRes.exitCode}\n` +
          `STDERR: ${probeRes.stderr.trim() || "(empty)"}\n` +
          `STDOUT: ${probeRes.stdout.trim() || "(empty)"}\n\n` +
          `Likely causes:\n` +
          `  • The dashboard host is not reachable from ${probeUrl} (try \`curl -v ${probeUrl}\` from the remote host)\n` +
          `  • macOS Application Firewall is blocking inbound on port ${process.env.PORT || "3000"} on the dashboard host\n` +
          `  • The dashboard is bound to localhost only\n` +
          `  • A network ACL between the target and the dashboard is dropping the connection`
      );
    }

    // Install command exited 0 AND the agent's network path to the dashboard
    // is verified working. We *still* don't flip agentStatus to "healthy"
    // here — we wait for the first real heartbeat to do that, so the
    // dashboard's "Healthy" badge can never lie. The heartbeat route is the
    // single source of truth (`src/app/api/agent/heartbeat/route.ts`).
    // Leaving the row in `installing` with stage "awaiting first heartbeat"
    // keeps the install progress panel visible until heartbeats actually
    // arrive (~10s). The status monitor's watchdog still acts as a backstop
    // in case the agent posts a probe successfully but then crashes or stops
    // posting heartbeats for some other reason.
    await db
      .update(servers)
      .set({
        agentStatus: "installing",
        agentInstallStage: "awaiting first heartbeat",
        agentInstallError: null,
        // Persist the URL we just baked into the agent's config so the
        // dashboard can show it in Settings → Servers and offer a
        // one-click repoint via the Reconfigure flow.
        apiUrl: dashboardUrl,
        updatedAt: Date.now(),
      })
      .where(eq(servers.id, serverId));

    console.log(`[agent] install ok for ${serverId} (${target}) — awaiting first heartbeat`);
    return { ok: true, target };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] install failed for ${serverId}:`, message);
    await db
      .update(servers)
      .set({
        agentStatus: "install_failed",
        agentInstallError: message,
        agentInstallStage: null,
        updatedAt: Date.now(),
      })
      .where(eq(servers.id, serverId));
    return { ok: false, error: message };
  }
}

/** Convenience for the retry button. Re-runs `installAgent`. */
export async function retryInstall(serverId: string): Promise<InstallResult> {
  return installAgent(serverId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist a progress stage so the UI poll loop can render it.
 * `extra` lets the caller write additional fields in the same UPDATE.
 */
async function setStage(
  serverId: string,
  agentStatus: "installing" | "install_failed" | "healthy",
  stage: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await db
    .update(servers)
    .set({
      agentStatus,
      agentInstallStage: stage,
      updatedAt: Date.now(),
      ...extra,
    })
    .where(eq(servers.id, serverId));
}

/**
 * Upload a local file to a remote path using the existing ssh2 client's
 * SFTP channel. `ssh2` exposes `client.sftp()` which gives us a stream API.
 */
function sftpUpload(
  client: SshClient,
  localPath: string,
  remotePath: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
      if (err) {
        reject(new Error(`sftp channel: ${err.message}`));
        return;
      }
      const writeStream = sftp.createWriteStream(remotePath, { mode: 0o755 });
      const readStream = createReadStream(localPath);

      writeStream.on("close", () => resolve());
      writeStream.on("error", (e: Error) =>
        reject(new Error(`sftp write: ${e.message}`))
      );
      readStream.on("error", (e: Error) =>
        reject(new Error(`local read: ${e.message}`))
      );

      readStream.pipe(writeStream);
    });
  });
}

/**
 * Escape a value for safe interpolation into a shell command. Single-quote
 * wrapping avoids any expansion; embedded single quotes are handled by the
 * standard `'\''` trick.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Ensure a cached binary exists on the dashboard host for the given target.
 *
 * Fast path: `data/agent-binaries/<target>/managet-agent` already exists,
 * return immediately.
 *
 * Slow path: build the agent on the remote host itself (Rust source over
 * SSH, cargo build, download result). Serialised per target via `buildLocks`
 * so concurrent installs of the same arch share the first build's output.
 */
async function ensureBinaryForTarget(
  serverId: string,
  client: SshClient,
  target: AgentTarget
): Promise<void> {
  if (binaryExists(target)) return;

  // If another install is already building this target, await it. If it
  // succeeds we're done; if it throws we fall through and build ourselves.
  const inFlight = buildLocks.get(target);
  if (inFlight) {
    await setStage(
      serverId,
      "installing",
      `waiting for another install to finish building ${target}`
    );
    try {
      await inFlight;
      if (binaryExists(target)) return;
    } catch {
      // previous build failed — we'll try again below
    }
  }

  const buildPromise = buildAgentOnTarget(serverId, client, target).finally(
    () => {
      // Only clear the lock if *this* promise is still the one stored.
      if (buildLocks.get(target) === buildPromise) {
        buildLocks.delete(target);
      }
    }
  );
  buildLocks.set(target, buildPromise);
  await buildPromise;
}

/**
 * Compile the agent on the remote host and copy the resulting binary back
 * to the dashboard host's `data/agent-binaries/<target>/` cache.
 *
 * Steps:
 *   1. Check for `cargo` on PATH or in `$HOME/.cargo/bin`. If missing,
 *      bootstrap rustup via the official `sh.rustup.rs` installer (minimal
 *      profile, unattended).
 *   2. Upload the cached agent source tarball via SFTP.
 *   3. Extract + `cargo build --release` with a generous timeout.
 *   4. SFTP-download the resulting `target/release/managet-agent` binary
 *      into the cache directory on the dashboard host.
 *   5. Clean up the staging directory on the remote.
 */
async function buildAgentOnTarget(
  serverId: string,
  client: SshClient,
  target: AgentTarget
): Promise<void> {
  await setStage(serverId, "installing", "checking for rust toolchain");
  const cargoCheck = await executeCommand(
    serverId,
    `if command -v cargo >/dev/null 2>&1; then echo have; elif [ -x "$HOME/.cargo/bin/cargo" ]; then echo have; else echo missing; fi`,
    undefined,
    10_000
  );
  const hasCargo = cargoCheck.stdout.trim() === "have";

  if (!hasCargo) {
    await setStage(
      serverId,
      "installing",
      "installing rust toolchain (first-time build, may take a few minutes)"
    );
    // Official rustup installer: https://sh.rustup.rs
    // -y unattended, --profile minimal keeps it small (no docs/rust-src),
    // --default-toolchain stable picks the latest stable release.
    const rustupCmd =
      `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | ` +
      `sh -s -- -y --profile minimal --default-toolchain stable`;
    const rustupRes = await executeCommand(serverId, rustupCmd, undefined, 600_000);
    if (rustupRes.exitCode !== 0) {
      throw new Error(
        `rustup install failed (exit ${rustupRes.exitCode}):\nSTDOUT: ${rustupRes.stdout}\nSTDERR: ${rustupRes.stderr}`
      );
    }
  }

  // Stage directory on the remote host. Each build gets its own dir so
  // concurrent builds (of different targets, on different hosts) can't
  // clobber each other.
  const stageDir = `/tmp/managet-agent-build-${randomUUID()}`;
  const remoteTarball = `${stageDir}/agent-src.tar.gz`;

  try {
    await executeCommand(
      serverId,
      `mkdir -p ${shellEscape(stageDir)}`,
      undefined,
      5_000
    );

    await setStage(serverId, "installing", "uploading agent source");
    const localTarball = await getAgentSourceTarball();
    await sftpUpload(client, localTarball, remoteTarball);

    // Extract into the stage dir. `tar` is present on every supported target.
    const extractRes = await executeCommand(
      serverId,
      `tar -xzf ${shellEscape(remoteTarball)} -C ${shellEscape(stageDir)}`,
      undefined,
      30_000
    );
    if (extractRes.exitCode !== 0) {
      throw new Error(
        `tar extract failed: ${extractRes.stderr || extractRes.stdout}`
      );
    }

    await setStage(
      serverId,
      "installing",
      `compiling agent on target (${target}, this can take several minutes)`
    );
    // Ensure cargo is on PATH for non-interactive shells — rustup installs
    // to $HOME/.cargo/bin but that isn't always sourced in non-login shells.
    const buildCmd =
      `export PATH="$HOME/.cargo/bin:$PATH" && ` +
      `cd ${shellEscape(stageDir)} && ` +
      `cargo build --release`;
    const buildRes = await executeCommand(serverId, buildCmd, undefined, 1_800_000);
    if (buildRes.exitCode !== 0) {
      throw new Error(
        `cargo build failed (exit ${buildRes.exitCode}):\nSTDOUT: ${buildRes.stdout}\nSTDERR: ${buildRes.stderr}`
      );
    }

    await setStage(serverId, "installing", "caching compiled binaries on dashboard");
    const remoteBinary = `${stageDir}/target/release/managet-agent`;
    const remoteCliBinary = `${stageDir}/target/release/managet`;
    const localDest = binaryPath(target);
    const localCliDest = cliBinaryPath(target);
    mkdirSync(dirname(localDest), { recursive: true });
    await sftpDownload(client, remoteBinary, localDest);
    await chmod(localDest, 0o755);
    // Best-effort download of the second binary. If `cargo build` didn't
    // produce it (older source tree, missing [[bin]] entry, etc.), fall
    // through silently — the agent's installer falls back to a symlink.
    try {
      await sftpDownload(client, remoteCliBinary, localCliDest);
      await chmod(localCliDest, 0o755);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[agent] no managet CLI in target/release (${msg}) — symlink fallback will be used`
      );
    }
  } finally {
    // Best-effort cleanup of the staging directory.
    await executeCommand(
      serverId,
      `rm -rf ${shellEscape(stageDir)}`,
      undefined,
      30_000
    ).catch(() => {
      /* best-effort */
    });
  }
}

/**
 * Download a remote file via the existing ssh2 client's SFTP channel.
 * Mirror of `sftpUpload` — uses the stream API so we don't buffer the whole
 * binary in memory.
 */
function sftpDownload(
  client: SshClient,
  remotePath: string,
  localPath: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
      if (err) {
        reject(new Error(`sftp channel: ${err.message}`));
        return;
      }
      const readStream = sftp.createReadStream(remotePath);
      const writeStream = createWriteStream(localPath, { mode: 0o755 });

      writeStream.on("close", () => resolve());
      writeStream.on("error", (e: Error) =>
        reject(new Error(`local write: ${e.message}`))
      );
      readStream.on("error", (e: Error) =>
        reject(new Error(`sftp read: ${e.message}`))
      );

      readStream.pipe(writeStream);
    });
  });
}

/**
 * Figure out what URL the agent should POST heartbeats to.
 *
 * In dev the dashboard listens on localhost:3000 but the agent runs on a
 * different machine, so `http://localhost:3000` is useless and `os.hostname()`
 * (e.g. `MyMac.local`) often isn't resolvable from a Pi or Linux box on the
 * same LAN.
 *
 * Resolution order:
 *   1. `MANAGET_DASHBOARD_URL` env var — explicit override always wins.
 *   2. Read `$SSH_CLIENT` on the *target* host (set by sshd to
 *      `<client_ip> <client_port> <server_port>`). The first field is the IP
 *      the target sees us connecting from, which is by definition reachable
 *      from the target. This is the most robust default for LAN setups.
 *   3. Fallback to `http://<os.hostname()>:PORT` — covers the case where
 *      `SSH_CLIENT` is unavailable (e.g. proxied / rare sshd configs).
 *
 * Requires the SSH connection for `serverId` to already be open.
 */
async function resolveDashboardUrl(serverId: string): Promise<string> {
  if (process.env.MANAGET_DASHBOARD_URL) {
    return process.env.MANAGET_DASHBOARD_URL.replace(/\/+$/, "");
  }
  const port = process.env.PORT || "3000";

  try {
    const res = await executeCommand(
      serverId,
      `echo "$SSH_CLIENT"`,
      undefined,
      5_000
    );
    if (res.exitCode === 0) {
      const clientIp = res.stdout.trim().split(/\s+/)[0];
      // Guard against an empty SSH_CLIENT (some restrictive sshd configs
      // strip it). Accept anything that looks vaguely like an address —
      // both IPv4 dotted-quad and IPv6 are fine, since both work in URLs
      // (IPv6 callers should already be wrapped in brackets, but in
      // practice on a LAN this will be IPv4).
      if (clientIp && clientIp.length > 0) {
        return `http://${clientIp}:${port}`;
      }
    }
  } catch {
    // Fall through to hostname fallback.
  }

  // Last-resort fallback. Production deployments should set
  // MANAGET_DASHBOARD_URL explicitly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os");
  const host = os.hostname() || "localhost";
  return `http://${host}:${port}`;
}
