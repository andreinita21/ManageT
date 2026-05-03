/**
 * The Pi can't `git fetch` from GitHub (no credentials), and a previous
 * `git reset --hard origin/main` rolled it back to a stale ref —
 * dropping the entire agent fleet (no /api/agent/heartbeat in the
 * current build).
 *
 * Fix: use `git bundle` to ship the missing commits over SFTP. A bundle
 * is a self-contained pack file. The Pi fetches from the bundle as if
 * it were a remote, no network auth required.
 *
 * Steps:
 *   1. Local: `git bundle create /tmp/managet.bundle origin/main` —
 *      produces a bundle containing every commit reachable from the
 *      latest origin/main.
 *   2. Upload bundle to Pi via SFTP.
 *   3. Pi: `git fetch <bundle> origin/main:refs/remotes/origin/main` —
 *      updates the local cached origin/main ref to point at the new tip.
 *   4. Pi: `git reset --hard origin/main` — moves HEAD + working tree
 *      to that tip.
 *   5. Pi: scrub `._*`, `npm run build`, `systemctl restart managet`.
 *   6. Probe csrf + servers list to confirm both auth and the agent
 *      endpoints are present.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
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

const BUNDLE_LOCAL = "/tmp/managet.bundle";
const BUNDLE_REMOTE = "/tmp/managet.bundle";

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

function sftpPut(c: Client, local: string, remote: string): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(local, remote, (e) => (e ? reject(e) : resolve()));
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
  step("0", "Connecting to Pi");
  const c = new Client();
  await new Promise<void>((res, rej) => {
    c.on("ready", () => res());
    c.on("error", rej);
    c.connect({ host: pi.host, port: pi.port, username: pi.username, password: piPwd, readyTimeout: 30000 });
  });

  step("1", "Creating git bundle on the laptop (origin/main)");
  await localExec("rm", ["-f", BUNDLE_LOCAL]);
  const bundle = await localExec("git", ["bundle", "create", BUNDLE_LOCAL, "origin/main"]);
  if (bundle.code !== 0) throw new Error("git bundle create failed: " + bundle.out);
  console.log(`  ${BUNDLE_LOCAL} (${(statSync(BUNDLE_LOCAL).size / 1024).toFixed(1)} KB)`);

  step("2", "Uploading bundle to the Pi via SFTP");
  await sftpPut(c, BUNDLE_LOCAL, BUNDLE_REMOTE);
  console.log("  uploaded");

  step("3", "Fetching from the bundle on the Pi");
  // git fetch from a bundle file: refspec maps bundle's `origin/main`
  // (which is what we packed) onto the Pi's `refs/remotes/origin/main`.
  // After this the Pi's cached origin/main points at the new tip.
  const fetch = await exec(
    c,
    `cd /home/andrei/managet && git fetch ${BUNDLE_REMOTE} origin/main:refs/remotes/origin/main 2>&1`
  );
  console.log(`  ${fetch.out.trim()}`);
  if (fetch.code !== 0) throw new Error("bundle fetch failed");

  step("4", "Resetting working tree to origin/main");
  const reset = await exec(c, "cd /home/andrei/managet && git reset --hard origin/main 2>&1");
  require0(reset, "reset");
  console.log(`  ${reset.out.trim()}`);
  await exec(c, `rm -f ${BUNDLE_REMOTE}`);

  step("5", "Scrubbing any AppleDouble (._*) files left behind");
  const scrub = await exec(
    c,
    `cd /home/andrei/managet && find . -name '._*' -not -path './node_modules/*' -not -path './.next/*' -print -delete | wc -l`
  );
  console.log(`  removed ${scrub.out.trim()} files`);

  step("6", "npm run build");
  const build = await exec(c, "cd /home/andrei/managet && npm run build 2>&1 | tail -30", { print: true });
  if (build.code !== 0) throw new Error("npm run build failed");

  step("7", "systemctl restart managet");
  const restart = await sudo(c, "systemctl restart managet && sleep 1 && systemctl is-active managet");
  require0(restart, "restart");
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

  step("8", "Verifying agent endpoints + auth flow");
  // /api/agent/validate-token should return 401 (route exists; no auth header sent).
  // If the build is missing the route entirely, Next returns 404 instead.
  const probeVT = await exec(
    c,
    `curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code}' -X POST http://127.0.0.1:3000/api/agent/validate-token`
  );
  console.log(`  /api/agent/validate-token -> ${probeVT.out.trim()} (expect 401)`);
  if (probeVT.out !== "HTTP 401") {
    throw new Error("agent route missing — build is wrong");
  }
  // /api/agent/heartbeat should return 401 too with no auth header.
  const probeHB = await exec(
    c,
    `curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3000/api/agent/heartbeat`
  );
  console.log(`  /api/agent/heartbeat   -> ${probeHB.out.trim()} (expect 401)`);

  // Login + /api/servers
  const jar = `/tmp/cj-${Date.now()}.txt`;
  const flags = `-sS -m 10 -c ${jar} -b ${jar}`;
  const csrf = await exec(c, `curl ${flags} http://${pi.host}:3000/api/auth/csrf`);
  const tok = csrf.out.match(/"csrfToken":"([^"]+)"/)?.[1];
  await exec(
    c,
    `curl ${flags} -X POST -H 'Content-Type: application/x-www-form-urlencoded' ` +
      `-H 'Origin: http://${pi.host}:3000' ` +
      `--data-urlencode 'email=admin@managet.local' --data-urlencode 'password=admin' ` +
      `--data-urlencode 'csrfToken=${tok}' --data-urlencode 'callbackUrl=http://${pi.host}:3000/' ` +
      `--data-urlencode 'json=true' http://${pi.host}:3000/api/auth/callback/credentials > /dev/null`
  );
  const list = await exec(c, `curl ${flags} -o /dev/null -w 'HTTP %{http_code}' http://${pi.host}:3000/api/servers`);
  console.log(`  /api/servers (with cookie) -> ${list.out.trim()}`);
  await exec(c, `rm -f ${jar}`);

  step("9", "Final state on Pi (git log)");
  const log = await exec(c, "cd /home/andrei/managet && git log --oneline -3 && echo --- && git status -s");
  console.log("  " + log.out.trim().split("\n").join("\n  "));

  step("10", "Heartbeats from agents (wait 12s, then read DB)");
  await new Promise((r) => setTimeout(r, 12000));
  const hb = await exec(
    c,
    `sqlite3 /home/andrei/managet/data/managet.db "SELECT name, agent_status, COALESCE(agent_last_heartbeat_at, 0) FROM servers;"`
  );
  console.log(`  ${hb.out.trim().split("\n").join("\n  ")}`);
  const now = Date.now();
  for (const line of hb.out.trim().split("\n")) {
    const [name, st, last] = line.split("|");
    const ago = Math.round((now - parseInt(last, 10)) / 1000);
    if (parseInt(last, 10) > 0) {
      console.log(`    ${name}: ${st}, last heartbeat ${ago}s ago ${ago < 30 ? "✓" : "✗"}`);
    } else {
      console.log(`    ${name}: ${st}, NO heartbeat`);
    }
  }

  c.end();
  console.log(`\n\x1b[1;32m✓ Pi is back on origin/main with the agent fleet, prod build, systemd.\x1b[0m`);
  console.log(`  Open http://${pi.host}:3000 in a fresh browser tab. Login: admin@managet.local / admin`);
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
