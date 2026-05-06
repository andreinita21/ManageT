/**
 * Ad-hoc SSH helper for dev. Used by the assistant during cleanup +
 * install operations on 192.168.100.95 and 192.168.100.82.
 *
 *   npx tsx scripts/dev-ssh.ts <host> '<command>'
 *
 * Reads the password from MANAGET_DEV_PASSWORD (so it never lands in
 * shell history). Streams stdout + stderr; exits with the remote
 * command's exit code.
 */
import { Client } from "ssh2";

async function run(host: string, command: string): Promise<number> {
  const password = process.env.MANAGET_DEV_PASSWORD;
  if (!password) {
    throw new Error("MANAGET_DEV_PASSWORD must be set");
  }
  return new Promise<number>((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => {
      c.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          c.end();
          reject(err);
          return;
        }
        let exitCode = 0;
        stream
          .on("close", (code: number | null) => {
            exitCode = code ?? 0;
            c.end();
            resolve(exitCode);
          })
          .on("data", (d: Buffer) => process.stdout.write(d))
          .stderr.on("data", (d: Buffer) => process.stderr.write(d));
      });
    })
      .on("error", reject)
      .connect({
        host,
        port: 22,
        username: "andrei",
        password,
        readyTimeout: 15000,
      });
  });
}

async function main() {
  const [host, ...cmdParts] = process.argv.slice(2);
  if (!host || cmdParts.length === 0) {
    console.error("usage: dev-ssh.ts <host> <command>");
    process.exit(2);
  }
  const command = cmdParts.join(" ");
  const code = await run(host, command);
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
