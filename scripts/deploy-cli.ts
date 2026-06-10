/**
 * scripts/deploy-cli.ts — push an updated `managet` CLI binary to every
 * managed host WITHOUT reinstalling or restarting the agent daemon
 * (a daemon restart would kill every live PTY session).
 *
 * Per host:
 *   - Linux: SFTP-upload the locally built release binary, then
 *     `sudo install` it over /usr/local/bin/managet.
 *   - Darwin: no cross-toolchain on the dashboard host, so ship the
 *     agent source tarball and `cargo build --release --bin managet`
 *     on the host itself (same approach as the installer's
 *     remote-build path), then `sudo install` the result.
 *
 * sudo strategy mirrors src/lib/agent/installer.ts: root → plain,
 * stored password → `sudo -S`, key-auth → `sudo -n`.
 *
 * Usage (from the repo root, with .env.local loaded for the password
 * decryption key):
 *   npx tsx scripts/deploy-cli.ts <path-to-linux-aarch64-binary>
 */
import { execSync } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Client as SshClient, SFTPWrapper } from "ssh2";

import { decryptPassword } from "@/lib/crypto";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { rowToServer } from "@/lib/db/transform";
import { connectionPool } from "@/lib/ssh/connection-pool";
import { executeCommand } from "@/lib/ssh/exec";

const REMOTE_BIN_STAGE = "/tmp/managet-cli-update";
const REMOTE_SRC_TGZ = "/tmp/managet-cli-src.tgz";
const REMOTE_BUILD_DIR = "/tmp/managet-cli-build";

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sftpUpload(
  client: SshClient,
  localPath: string,
  remotePath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
      if (err) return reject(new Error(`sftp channel: ${err.message}`));
      sftp.fastPut(localPath, remotePath, (e?: Error) =>
        e ? reject(new Error(`sftp put ${remotePath}: ${e.message}`)) : resolve()
      );
    });
  });
}

async function main() {
  const linuxBin = process.argv[2];
  if (!linuxBin) {
    console.error("usage: npx tsx scripts/deploy-cli.ts <linux-aarch64-managet-binary>");
    process.exit(1);
  }
  await stat(linuxBin);

  const rows = await db.select().from(servers);
  let failures = 0;

  for (const row of rows) {
    const server = rowToServer(row);
    console.log(`\n=== ${server.name} (${server.host}) ===`);
    try {
      const client = await connectionPool.connect(server);

      // Same sudo strategy as the installer.
      const who = await executeCommand(server.id, "id -u", undefined, 10_000);
      const isRoot = who.stdout.trim() === "0";
      let sudoPrefix = "";
      let sudoStdin: string | undefined;
      if (!isRoot) {
        const enc = (row as { passwordEncrypted?: string | null }).passwordEncrypted;
        if (enc) {
          sudoPrefix = "sudo -S -p '' ";
          sudoStdin = decryptPassword(enc) + "\n";
        } else {
          sudoPrefix = "sudo -n ";
        }
      }

      const uname = await executeCommand(server.id, "uname -s", undefined, 10_000);
      const os = uname.stdout.trim();

      if (os === "Linux") {
        console.log("  uploading prebuilt binary…");
        await sftpUpload(client, linuxBin, REMOTE_BIN_STAGE);
      } else if (os === "Darwin") {
        console.log("  darwin host — building on the host (this takes a few minutes)…");
        // Fresh tarball of the agent source, minus build artifacts.
        execSync(
          `tar czf /tmp/managet-agent-src.tgz --exclude agent/target -C ${shellEscape(process.cwd())} agent`,
          { stdio: "inherit" }
        );
        await sftpUpload(client, "/tmp/managet-agent-src.tgz", REMOTE_SRC_TGZ);
        const build = await executeCommand(
          server.id,
          `export PATH="$HOME/.cargo/bin:$PATH" && ` +
            `rm -rf ${REMOTE_BUILD_DIR} && mkdir -p ${REMOTE_BUILD_DIR} && ` +
            `tar xzf ${REMOTE_SRC_TGZ} -C ${REMOTE_BUILD_DIR} && ` +
            `cd ${REMOTE_BUILD_DIR}/agent && cargo build --release --bin managet`,
          undefined,
          20 * 60_000
        );
        if (build.exitCode !== 0) {
          throw new Error(`remote build failed: ${build.stderr.slice(-2000)}`);
        }
        const cp = await executeCommand(
          server.id,
          `cp ${REMOTE_BUILD_DIR}/agent/target/release/managet ${REMOTE_BIN_STAGE}`,
          undefined,
          30_000
        );
        if (cp.exitCode !== 0) throw new Error(`stage copy failed: ${cp.stderr}`);
      } else {
        throw new Error(`unsupported OS: ${os}`);
      }

      console.log("  installing to /usr/local/bin/managet…");
      const install = await executeCommand(
        server.id,
        `${sudoPrefix}install -m 0755 ${shellEscape(REMOTE_BIN_STAGE)} /usr/local/bin/managet && ` +
          `rm -f ${shellEscape(REMOTE_BIN_STAGE)} ${shellEscape(REMOTE_SRC_TGZ)}`,
        undefined,
        60_000,
        sudoStdin
      );
      if (install.exitCode !== 0) {
        throw new Error(`install failed: ${install.stderr || install.stdout}`);
      }
      console.log("  ✓ deployed");
    } catch (err) {
      failures++;
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      connectionPool.disconnect(server.id);
    }
  }

  // Drizzle's better-sqlite3 handle keeps the process alive otherwise.
  process.exit(failures > 0 ? 1 : 0);
}

void main();
