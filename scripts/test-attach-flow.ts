/**
 * End-to-end attach test against the Pi:
 *   1. SSH in
 *   2. `managet-agent new -n test` → capture id
 *   3. SSH in again with a real PTY, run `managet-agent attach <id>`
 *   4. Type `echo MANAGET_OK_$$\n` (PID expansion proves it's a fresh shell)
 *   5. Read output, verify MANAGET_OK_<some pid> appears
 *   6. Send Ctrl-A d (detach)
 *   7. SSH in again, verify the session is still listed (PROOF that
 *      the session survived the client disconnect)
 *   8. Reattach via a new connection, type `echo SECOND\n`, see SECOND
 *   9. `managet-agent kill <id>` to clean up
 */
import { readFileSync, existsSync } from "node:fs";
import { Client, ClientChannel } from "ssh2";
import Database from "better-sqlite3";
import { decryptPassword } from "../src/lib/crypto";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const db = new Database("data/managet.db", { readonly: true });
const pi = db
  .prepare("SELECT host, port, username, password_encrypted FROM servers WHERE id = ?")
  .get("98ec98f1-5157-40b5-bb46-07f5b13948c0") as any;
db.close();
const pwd = decryptPassword(pi.password_encrypted);

function ssh(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({
      host: pi.host,
      port: pi.port,
      username: pi.username,
      password: pwd,
      readyTimeout: 20000,
    });
  });
}

function execOnce(c: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, s) => {
      if (err) return reject(err);
      let out = "";
      s.on("data", (d: Buffer) => (out += d.toString()));
      s.stderr.on("data", (d: Buffer) => (out += d.toString()));
      s.on("close", () => resolve(out));
    });
  });
}

function shellWithPty(c: Client): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    c.exec(
      "/usr/local/bin/managet-agent attach " + (global as any).__sessionId,
      { pty: { rows: 24, cols: 80, term: "xterm-256color" } },
      (err, s) => {
        if (err) return reject(err);
        resolve(s);
      }
    );
  });
}

function attach(c: Client, sessionId: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    c.exec(`/usr/local/bin/managet-agent attach ${sessionId}`, {
      pty: { rows: 24, cols: 80, term: "xterm-256color" },
    }, (err, s) => {
      if (err) return reject(err);
      resolve(s);
    });
  });
}

async function readUntil(stream: ClientChannel, predicate: (buf: string) => boolean, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      stream.removeAllListeners("data");
      reject(new Error(`timed out (${timeoutMs}ms) waiting; got so far:\n${buf}`));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (predicate(buf)) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve(buf);
      }
    };
    stream.on("data", onData);
  });
}

async function main() {
  // ------------------------------------------------------------------
  console.log("[1] SSH connection 1: spawn a fresh session");
  const c1 = await ssh();
  const newOut = await execOnce(c1, "/usr/local/bin/managet-agent new -n test 2>&1");
  // Created session 54da9738 (test)
  const idMatch = newOut.match(/Created session (\S+) \(/);
  if (!idMatch) throw new Error(`couldn't parse new output:\n${newOut}`);
  const sessionId = idMatch[1];
  console.log(`  sessionId = ${sessionId}`);

  // ------------------------------------------------------------------
  console.log("[2] SSH connection 2 with PTY: attach + send a marker");
  const c2 = await ssh();
  const ch2 = await attach(c2, sessionId);
  // Wait for the agent's [managet] attached banner (sent on stderr). On
  // ssh2, stderr is multiplexed with data unless we listen to it
  // separately.
  ch2.stderr.on("data", () => {});  // drain
  // Wait for the shell prompt to repaint after attach. The PTY shell
  // (bash) will print something like "user@host:/dir$ ".
  await readUntil(ch2, (s) => /\$\s*$/.test(s) || /#\s*$/.test(s) || /managet\] attached/.test(s), 5000);

  const marker = `MARKER_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  ch2.write(`echo ${marker}\n`);
  await readUntil(ch2, (s) => s.includes(marker), 5000);
  console.log(`  saw "${marker}" in attached session ✓`);

  // Detach: Ctrl-A then 'd'
  console.log("  sending Ctrl-A d to detach");
  ch2.write(Buffer.from([0x01]));  // Ctrl-A
  ch2.write("d");
  // Wait for the channel to close.
  await new Promise<void>((res) => {
    ch2.once("close", () => res());
    setTimeout(() => res(), 3000);
  });
  c2.end();

  // ------------------------------------------------------------------
  console.log("[3] Verify session is still listed AFTER detach");
  const c3 = await ssh();
  const lsOut = await execOnce(c3, "/usr/local/bin/managet-agent ls 2>&1");
  console.log(lsOut.split("\n").map((l) => `  ${l}`).join("\n"));
  if (!lsOut.includes(sessionId.slice(0, 8))) {
    throw new Error("session disappeared after detach!");
  }
  console.log("  session survived disconnect ✓");

  // ------------------------------------------------------------------
  console.log("[4] Reattach + verify the prompt is the SAME shell");
  // The marker we echoed earlier should be in the scrollback replay.
  const ch4 = await attach(c3, sessionId);
  ch4.stderr.on("data", () => {});
  await readUntil(ch4, (s) => s.includes(marker), 5000);
  console.log(`  scrollback still contains "${marker}" — same shell ✓`);

  // Send a new command; the shell should remember its history.
  const marker2 = `SECOND_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  ch4.write(`echo ${marker2}\n`);
  await readUntil(ch4, (s) => s.includes(marker2), 5000);
  console.log(`  fresh command "${marker2}" worked ✓`);

  ch4.write(Buffer.from([0x01]));
  ch4.write("d");
  await new Promise<void>((res) => {
    ch4.once("close", () => res());
    setTimeout(() => res(), 3000);
  });

  // ------------------------------------------------------------------
  console.log("[5] Cleanup");
  await execOnce(c3, `/usr/local/bin/managet-agent kill ${sessionId}`);
  c3.end();

  console.log("\n\x1b[1;32m✓ attach / detach / re-attach round trip works.\x1b[0m");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
