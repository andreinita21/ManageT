/**
 * Fix the production-mode UntrustedHost crash, on the Pi, then commit
 * and push.
 *
 * Auth.js v5 in production refuses requests whose Host header isn't
 * explicitly trusted. With our custom server.ts setup it doesn't auto-
 * detect a Vercel-style trusted environment, so login + every protected
 * API call returns 500 ("There was a problem with the server
 * configuration"). Adding `trustHost: true` to the NextAuth config tells
 * it to trust whatever host the request arrived on. We also set
 * `AUTH_TRUST_HOST=true` in .env.local as a redundant safety net.
 *
 * Steps run on the Pi:
 *   1. Patch src/lib/auth/index.ts: insert `trustHost: true`.
 *   2. Append `AUTH_TRUST_HOST=true` to .env.local.
 *   3. `npm run build`.
 *   4. `systemctl restart managet` and wait for healthy /api/auth/csrf.
 *   5. Probe full auth flow (csrf → credentials → /api/servers).
 *   6. git add/commit/push.
 *   7. Locally: stash + reset --hard origin/main so the laptop matches.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Client } from "ssh2";
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
const piPwd = decryptPassword(pi.password_encrypted);

function step(n: string, msg: string) {
  console.log(`\n\x1b[1;36m[${n}] ${msg}\x1b[0m`);
}

function sshConnect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({
      host: pi.host,
      port: pi.port,
      username: pi.username,
      password: piPwd,
      readyTimeout: 30000,
    });
  });
}

function exec(c: Client, cmd: string, opts: { print?: boolean } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, s) => {
      if (err) return reject(err);
      let out = "";
      let er = "";
      s.on("data", (d: Buffer) => {
        const t = d.toString();
        out += t;
        if (opts.print) process.stdout.write(t);
      });
      s.stderr.on("data", (d: Buffer) => {
        const t = d.toString();
        er += t;
        if (opts.print) process.stderr.write(t);
      });
      s.on("close", (code: number | null) => resolve({ code: code ?? -1, out, err: er }));
    });
  });
}

function sudo(c: Client, cmd: string) {
  return exec(c, `echo ${JSON.stringify(piPwd)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`);
}

function sftpPutBuffer(c: Client, buf: Buffer, remote: string, mode = 0o644): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remote, { mode });
      ws.on("close", () => resolve());
      ws.on("error", reject);
      ws.end(buf);
    });
  });
}

function sftpReadBuffer(c: Client, remote: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      const rs = sftp.createReadStream(remote);
      rs.on("data", (d: Buffer) => chunks.push(d));
      rs.on("end", () => resolve(Buffer.concat(chunks)));
      rs.on("error", reject);
    });
  });
}

function localExec(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

function require0(r: { code: number; out: string; err: string }, label: string) {
  if (r.code !== 0) {
    throw new Error(`${label} failed (exit ${r.code})\nSTDOUT: ${r.out.trimEnd()}\nSTDERR: ${r.err.trimEnd()}`);
  }
}

async function main() {
  const c = await sshConnect();

  step("1", "Patching src/lib/auth/index.ts on the Pi (trustHost: true)");
  const authPath = "/home/andrei/managet/src/lib/auth/index.ts";
  const orig = (await sftpReadBuffer(c, authPath)).toString("utf8");
  if (orig.includes("trustHost")) {
    console.log("  already has trustHost — skipping patch");
  } else {
    // Insert trustHost: true alongside session/callbacks/pages. We anchor
    // on `session: { strategy: "jwt" },` because it's a stable, unique line.
    const anchor = `  session: { strategy: "jwt" },`;
    if (!orig.includes(anchor)) {
      throw new Error(`anchor line not found in ${authPath}; refusing to patch`);
    }
    const patched = orig.replace(
      anchor,
      `  // Auth.js v5 refuses requests with an unfamiliar Host header in\n` +
      `  // production by default. Our custom server.ts setup doesn't trip the\n` +
      `  // Vercel-style auto-trust path, so login + every protected route\n` +
      `  // crashes with UntrustedHost. Trust whatever host the proxy/server\n` +
      `  // gives us — we're behind our own LAN.\n` +
      `  trustHost: true,\n` +
      anchor
    );
    if (patched === orig) throw new Error("patch produced no change");
    await sftpPutBuffer(c, Buffer.from(patched, "utf8"), authPath);
    console.log("  patched");
  }

  step("2", "Appending AUTH_TRUST_HOST=true to .env.local (belt + suspenders)");
  const envPath = "/home/andrei/managet/.env.local";
  const env = (await sftpReadBuffer(c, envPath)).toString("utf8");
  if (!/^AUTH_TRUST_HOST=/m.test(env)) {
    const updated = env.endsWith("\n") ? env + "AUTH_TRUST_HOST=true\n" : env + "\nAUTH_TRUST_HOST=true\n";
    await sftpPutBuffer(c, Buffer.from(updated, "utf8"), envPath, 0o600);
    console.log("  added");
  } else {
    console.log("  already present");
  }

  step("3", "Rebuilding (npm run build)");
  const build = await exec(
    c,
    "cd /home/andrei/managet && npm run build 2>&1 | tail -30",
    { print: true }
  );
  if (build.code !== 0) throw new Error("npm run build failed");

  step("4", "Restarting managet.service");
  const restart = await sudo(c, "systemctl restart managet && sleep 1 && systemctl is-active managet");
  require0(restart, "systemctl restart");
  console.log(`  state: ${restart.out.trim()}`);
  // Wait for the listen line in the journal.
  let started = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const j = await sudo(c, "journalctl -u managet --no-pager --since '90 seconds ago'");
    if (j.out.includes("ManageT running on")) {
      started = true;
      break;
    }
  }
  if (!started) {
    const j = await sudo(c, "journalctl -u managet --no-pager -n 80");
    throw new Error(`service didn't come up. Journal:\n${j.out}`);
  }

  step("5", "Probing /api/auth/csrf and the full login flow");
  for (const host of ["127.0.0.1", pi.host]) {
    const r = await exec(
      c,
      `curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code}' http://${host}:3000/api/auth/csrf`
    );
    console.log(`  ${host}:3000/api/auth/csrf -> ${r.out.trim()}`);
    if (!r.out.startsWith("HTTP 200")) {
      const j = await sudo(c, "journalctl -u managet --no-pager -n 40");
      throw new Error(`probe via ${host} still failing.\n${j.out}`);
    }
  }
  // Full login flow against LAN IP
  const jar = `/tmp/cj-${Date.now()}.txt`;
  const flags = `-sS -m 10 -c ${jar} -b ${jar}`;
  const csrf = await exec(c, `curl ${flags} http://${pi.host}:3000/api/auth/csrf`);
  const tok = csrf.out.match(/"csrfToken":"([^"]+)"/)?.[1];
  const login = await exec(
    c,
    `curl ${flags} -i -X POST -H 'Content-Type: application/x-www-form-urlencoded' ` +
      `-H 'Origin: http://${pi.host}:3000' ` +
      `--data-urlencode 'email=admin@managet.local' ` +
      `--data-urlencode 'password=admin' ` +
      `--data-urlencode 'csrfToken=${tok}' ` +
      `--data-urlencode 'callbackUrl=http://${pi.host}:3000/' ` +
      `--data-urlencode 'json=true' ` +
      `http://${pi.host}:3000/api/auth/callback/credentials | head -10`
  );
  const ok = /HTTP\/1\.1 (302|200)/.test(login.out);
  console.log(`  login: ${ok ? "ok" : "FAIL"}`);
  if (!ok) console.log(login.out);
  const list = await exec(c, `curl ${flags} -o /dev/null -w 'HTTP %{http_code}' http://${pi.host}:3000/api/servers`);
  console.log(`  /api/servers (with cookie): ${list.out.trim()}`);
  await exec(c, `rm -f ${jar}`);
  if (!list.out.startsWith("HTTP 200")) throw new Error("/api/servers still not returning 200 with a session");

  step("6", "Committing + pushing from the Pi");
  await exec(
    c,
    `cd /home/andrei/managet && git config user.email 'andreisebastian.nita@gmail.com' && git config user.name 'Andrei Nita'`
  );
  await exec(c, "cd /home/andrei/managet && git add -A");
  const commit = await exec(
    c,
    `cd /home/andrei/managet && git commit -m 'Fix Auth.js UntrustedHost in production + add systemd unit' -m 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>' 2>&1`
  );
  console.log(`  ${commit.out.trim()}`);
  const push = await exec(c, "cd /home/andrei/managet && git push origin main 2>&1");
  console.log(`  ${push.out.trim().split("\n").slice(-6).join("\n")}`);
  if (push.code !== 0) {
    if (push.out.includes("Authentication") || push.out.includes("could not read")) {
      console.log(
        `\n  ⚠ git push failed with auth — set up a PAT/credential helper on the Pi, then:\n` +
          `      ssh andrei@${pi.host} 'cd ~/managet && git push origin main'`
      );
    } else {
      throw new Error("git push failed: " + push.out);
    }
  }

  step("7", "Syncing the laptop (fetch + hard-reset to origin/main)");
  await localExec("git", ["fetch", "origin"]);
  // Stash any non-trivial local state first so we don't lose work silently.
  const status = await localExec("git", ["status", "-s"]);
  if (status.out.trim()) {
    await localExec("git", ["stash", "push", "--include-untracked", "-m", `pre-pi-sync-${Date.now()}`]);
    console.log("  stashed local changes");
  }
  const reset = await localExec("git", ["reset", "--hard", "origin/main"]);
  console.log(`  ${reset.out.trim()}`);

  c.end();

  console.log(`\n\x1b[1;32m✓ Backend is up.\x1b[0m`);
  console.log(`  Dashboard: http://${pi.host}:3000`);
  console.log(`  Login:     admin@managet.local / admin`);
  console.log(`  Logs:      ssh andrei@${pi.host} 'journalctl -u managet -f'`);
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
