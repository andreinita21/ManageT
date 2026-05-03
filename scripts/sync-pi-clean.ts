/**
 * Clean up the Pi after my botched commit (which included ~800 macOS
 * `._*` AppleDouble metadata files from the migration tarball) and align
 * it to origin/main, which now has the clean version.
 *
 * Steps on the Pi:
 *   1. `git fetch origin`.
 *   2. `git reset --hard origin/main` — drops the local pollution commit.
 *   3. `find . -name '._*' -delete` — scrub any AppleDouble files still
 *      sitting in the working tree (gitignored now, but still ugly).
 *   4. `npm run build` — the trustHost source code change is in
 *      origin/main, so the build now matches the laptop.
 *   5. `systemctl restart managet`, wait for "ManageT running on".
 *   6. Verify /api/auth/csrf via 127.0.0.1 + LAN IP.
 */
import { readFileSync, existsSync } from "node:fs";
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

function require0(r: { code: number; out: string; err: string }, label: string) {
  if (r.code !== 0) {
    throw new Error(`${label} failed (exit ${r.code})\nSTDOUT: ${r.out.trimEnd()}\nSTDERR: ${r.err.trimEnd()}`);
  }
}

async function main() {
  const c = new Client();
  await new Promise<void>((res, rej) => {
    c.on("ready", () => res());
    c.on("error", rej);
    c.connect({
      host: pi.host,
      port: pi.port,
      username: pi.username,
      password: piPwd,
      readyTimeout: 30000,
    });
  });

  step("1", "git fetch origin + reset --hard origin/main");
  const fetch = await exec(c, "cd /home/andrei/managet && git fetch origin 2>&1");
  console.log("  " + fetch.out.trim().split("\n").slice(-3).join(" | "));
  // Ensure NEXT/turbopack hasn't taken a lock on tracked files; the reset
  // only touches the working tree, so this should be safe.
  const reset = await exec(c, "cd /home/andrei/managet && git reset --hard origin/main 2>&1");
  require0(reset, "git reset --hard");
  console.log(`  ${reset.out.trim()}`);

  step("2", "Scrubbing remaining ._* AppleDouble files from working tree");
  // -print so we can count what we removed.
  const scrub = await exec(
    c,
    `cd /home/andrei/managet && find . -name '._*' -not -path './node_modules/*' -not -path './.next/*' -print -delete | wc -l`
  );
  console.log(`  removed ${scrub.out.trim()} files`);

  step("3", "Verifying .env.local still has the secrets we wrote during migration");
  const env = await exec(c, "cat /home/andrei/managet/.env.local");
  const have = (k: string) => env.out.includes(`${k}=`) ? "✓" : "✗";
  console.log(
    `  PORT=${have("PORT")} | NEXTAUTH_URL=${have("NEXTAUTH_URL")} | NEXTAUTH_SECRET=${have(
      "NEXTAUTH_SECRET"
    )} | MANAGET_ENCRYPTION_KEY=${have("MANAGET_ENCRYPTION_KEY")} | MANAGET_DASHBOARD_URL=${have(
      "MANAGET_DASHBOARD_URL"
    )} | AUTH_TRUST_HOST=${have("AUTH_TRUST_HOST")}`
  );
  if (!env.out.includes("MANAGET_ENCRYPTION_KEY=")) {
    throw new Error(".env.local lost MANAGET_ENCRYPTION_KEY; refusing to proceed");
  }

  step("4", "npm run build (trustHost source is now in HEAD)");
  const build = await exec(
    c,
    "cd /home/andrei/managet && npm run build 2>&1 | tail -25",
    { print: true }
  );
  if (build.code !== 0) throw new Error("npm run build failed");

  step("5", "Restarting managet.service");
  const restart = await sudo(c, "systemctl restart managet && sleep 1 && systemctl is-active managet");
  require0(restart, "systemctl restart");
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
  console.log("  service is running");

  step("6", "Probing the dashboard");
  for (const host of ["127.0.0.1", pi.host]) {
    const r = await exec(
      c,
      `curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code} time=%{time_total}s\\n' http://${host}:3000/api/auth/csrf`
    );
    console.log(`  ${host}:3000/api/auth/csrf -> ${r.out.trim()}`);
    if (!r.out.startsWith("HTTP 200")) {
      const j = await sudo(c, "journalctl -u managet --no-pager -n 40");
      throw new Error(`probe via ${host} failed.\n${j.out}`);
    }
  }
  // Full login flow
  const jar = `/tmp/cj-${Date.now()}.txt`;
  const flags = `-sS -m 10 -c ${jar} -b ${jar}`;
  const csrf = await exec(c, `curl ${flags} http://${pi.host}:3000/api/auth/csrf`);
  const tok = csrf.out.match(/"csrfToken":"([^"]+)"/)?.[1];
  await exec(
    c,
    `curl ${flags} -X POST -H 'Content-Type: application/x-www-form-urlencoded' ` +
      `-H 'Origin: http://${pi.host}:3000' ` +
      `--data-urlencode 'email=admin@managet.local' ` +
      `--data-urlencode 'password=admin' ` +
      `--data-urlencode 'csrfToken=${tok}' ` +
      `--data-urlencode 'callbackUrl=http://${pi.host}:3000/' ` +
      `--data-urlencode 'json=true' ` +
      `http://${pi.host}:3000/api/auth/callback/credentials > /dev/null`
  );
  const list = await exec(c, `curl ${flags} -o /dev/null -w 'HTTP %{http_code}' http://${pi.host}:3000/api/servers`);
  console.log(`  /api/servers (with cookie): ${list.out.trim()}`);
  await exec(c, `rm -f ${jar}`);
  if (!list.out.startsWith("HTTP 200")) throw new Error("/api/servers still not 200");

  step("7", "git status on Pi (sanity)");
  const status = await exec(c, "cd /home/andrei/managet && git status -s; echo ---; git log --oneline -2");
  console.log(`  ${status.out.trim()}`);

  c.end();
  console.log(`\n\x1b[1;32m✓ Pi is on origin/main, clean, and serving.\x1b[0m`);
  console.log(`  Open http://${pi.host}:3000 in your browser, login: admin@managet.local / admin`);
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
