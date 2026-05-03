/**
 * Promote the Pi-hosted dashboard from `npm run dev` (slow on Pi hardware,
 * recompiles every request) to a real production build under systemd.
 *
 * Theory of the bug we're fixing: dev mode on a Pi is choking on JIT
 * compilation when the page is also being hammered by external probes
 * (the old Excalidraw Cloudflare ingress rule still routes to :3000).
 * Once requests pile up, fetches stall in the browser and the user sees
 * "UI loads but the data never arrives." A production build serves
 * pre-compiled chunks and is dramatically faster on constrained ARM.
 *
 * Steps:
 *   1. Pi: `npm run build` (Next prod compile; ~5 min on a Pi 4/5).
 *   2. Pi: write /etc/systemd/system/managet.service.
 *   3. Pi: stop the tmux dev server, kill any leftover node, free :3000.
 *   4. Pi: systemctl enable --now managet, wait for "ManageT running on".
 *   5. Pi: verify /api/auth/csrf returns 200 from 127.0.0.1:3000 and
 *      from the LAN IP. If the LAN IP fails, abort.
 *   6. Pi: write the unit file into infra/managet.service in the repo so
 *      future fresh installs can recreate it.
 *   7. Pi: git add -A, commit, push to origin main.
 *   8. Locally: hard-reset to origin/main so the laptop matches the Pi.
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

const PI_ID = "98ec98f1-5157-40b5-bb46-07f5b13948c0";
const db = new Database("data/managet.db", { readonly: true });
const pi = db
  .prepare("SELECT host, port, username, password_encrypted FROM servers WHERE id = ?")
  .get(PI_ID) as any;
db.close();
const piPwd = decryptPassword(pi.password_encrypted);

const SYSTEMD_UNIT = `[Unit]
Description=ManageT dashboard (Next.js + custom server)
Documentation=https://github.com/andreinita21/ManageT
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=andrei
Group=andrei
WorkingDirectory=/home/andrei/managet
EnvironmentFile=/home/andrei/managet/.env.local
Environment=NODE_ENV=production
Environment=HOME=/home/andrei
# tsx is fine in production: it just registers a TS loader in front of
# Node so we can keep server.ts authored as TypeScript. The Next.js side
# uses pre-built .next/ output because NODE_ENV=production.
ExecStart=/usr/bin/npx tsx server.ts
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
# Give the build artifacts time to be served before systemd's "started
# but not ready" watchdog fires. Default 90s is fine; bumping to 120s
# in case Pi I/O is slow on cold boot.
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
`;

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

function sudo(c: Client, cmd: string, print = false) {
  return exec(c, `echo ${JSON.stringify(piPwd)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`, { print });
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
  const c = await sshConnect();
  console.log(`  connected to ${pi.host}`);

  step("1", "Running `npm run build` on Pi (production compile, ~3-5 min)");
  const build = await exec(
    c,
    "cd /home/andrei/managet && npm run build 2>&1 | tail -40",
    { print: true }
  );
  if (build.code !== 0) throw new Error("npm run build failed");

  step("2", "Writing /etc/systemd/system/managet.service");
  // Stage in /tmp first, then sudo-mv into place.
  const tmpUnit = `/tmp/managet.service.${process.pid}`;
  await sftpPutBuffer(c, Buffer.from(SYSTEMD_UNIT, "utf8"), tmpUnit);
  const moveUnit = await sudo(
    c,
    `cp ${tmpUnit} /etc/systemd/system/managet.service && chown root:root /etc/systemd/system/managet.service && chmod 644 /etc/systemd/system/managet.service && rm -f ${tmpUnit} && systemctl daemon-reload`
  );
  require0(moveUnit, "install systemd unit");
  console.log("  unit installed + daemon-reload");

  step("3", "Stopping the tmux dev server (frees :3000)");
  await exec(c, "tmux kill-session -t managet 2>/dev/null; true");
  // Belt and suspenders: kill any lingering node holding port 3000 from the
  // previous run; the systemd unit can't bind otherwise.
  await sudo(
    c,
    `fuser -k 3000/tcp 2>/dev/null; pkill -f 'tsx server.ts' 2>/dev/null; sleep 2; ss -ltn 'sport = :3000'`
  );
  const portCheck = await sudo(c, "ss -ltn 'sport = :3000' | tail -n +2");
  if (portCheck.out.trim()) {
    console.log(`  WARN: port 3000 still occupied:\n${portCheck.out}`);
  } else {
    console.log("  port 3000 is free");
  }

  step("4", "Enabling + starting managet.service via systemd");
  const enable = await sudo(c, "systemctl enable --now managet.service");
  require0(enable, "systemctl enable --now");
  // Wait until either a "ManageT running on" line appears in the journal,
  // or systemd reports failure.
  let started = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const j = await sudo(c, "journalctl -u managet --no-pager -n 50 --since '2 minutes ago'");
    if (j.out.includes("ManageT running on")) {
      started = true;
      break;
    }
    if (j.out.includes("Failed to start")) break;
  }
  if (!started) {
    const j = await sudo(c, "journalctl -u managet --no-pager -n 80");
    throw new Error(`managet.service didn't come up. Journal:\n${j.out}`);
  }
  console.log(`  service is running`);

  step("5", "Probing dashboard from 127.0.0.1 and the LAN IP");
  for (const host of ["127.0.0.1", pi.host]) {
    const r = await exec(
      c,
      `curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code} time=%{time_total}s\\n' http://${host}:3000/api/auth/csrf`
    );
    console.log(`  ${host}:3000/api/auth/csrf -> ${r.out.trim()}`);
    if (!r.out.startsWith("HTTP 200")) {
      throw new Error(`probe via ${host} failed: ${r.out}`);
    }
  }

  step("6", "Writing infra/managet.service into the repo");
  await exec(c, "mkdir -p /home/andrei/managet/infra");
  // Use sftp through the same connection.
  await sftpPutBuffer(
    c,
    Buffer.from(SYSTEMD_UNIT, "utf8"),
    "/home/andrei/managet/infra/managet.service"
  );
  // Also drop a tiny README explaining how to install it.
  const infraReadme = `# managet systemd unit

Copy \`managet.service\` into place to run the dashboard as a long-lived
service:

\`\`\`bash
sudo cp infra/managet.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now managet
\`\`\`

Tail logs with:

\`\`\`bash
journalctl -u managet -f
\`\`\`

The unit assumes the project lives at \`/home/andrei/managet\` and runs as
the \`andrei\` user. The dashboard listens on the port set in
\`.env.local\` (\`PORT=3000\` by default) and reads its other env from the
same file.
`;
  await sftpPutBuffer(
    c,
    Buffer.from(infraReadme, "utf8"),
    "/home/andrei/managet/infra/README.md"
  );

  step("7", "Committing + pushing from the Pi to origin/main");
  // Stage everything tracked + new (the .gitignore should already exclude
  // node_modules, .next, data/, agent/target).
  const gitStatus = await exec(c, "cd /home/andrei/managet && git status --porcelain | head -40");
  console.log(`  pre-commit status (head):\n${gitStatus.out.trim()}`);
  // The Pi clone never had user.email/user.name configured; set them once.
  await exec(
    c,
    `cd /home/andrei/managet && git config user.email 'andreisebastian.nita@gmail.com' && git config user.name 'Andrei Nita'`
  );
  // GitHub HTTPS push needs credentials. Try without first; if it fails
  // we'll surface a useful hint.
  const add = await exec(c, "cd /home/andrei/managet && git add -A");
  require0(add, "git add");
  const commit = await exec(
    c,
    `cd /home/andrei/managet && git commit -m 'Migrate dashboard to Pi: prod build, systemd unit, agent fixes' -m 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>' 2>&1`
  );
  // commit may exit non-zero if there's nothing to commit; treat that as ok.
  console.log(`  ${commit.out.trim()}`);
  const push = await exec(c, "cd /home/andrei/managet && git push origin main 2>&1");
  console.log(`  ${push.out.trim()}`);
  if (push.code !== 0) {
    if (push.out.includes("Authentication") || push.out.includes("could not read")) {
      console.log(
        `\n  ⚠ git push failed with auth — set up a token on the Pi:\n` +
          `      gh auth login         # or paste a GH PAT into ~/.git-credentials\n` +
          `  Then re-run from the Pi:  cd ~/managet && git push origin main`
      );
    } else {
      throw new Error("git push failed: " + push.out);
    }
  }

  step("8", "Resetting the laptop's working tree to match origin/main");
  await localExec("git", ["fetch", "origin"]);
  const localStatus = await localExec("git", ["status", "-s"]);
  console.log(`  local status before reset:\n${localStatus.out.trim() || "  (clean)"}`);
  // Stash any untracked/uncommitted to be safe (we can drop later if it
  // overlaps with what the Pi just pushed).
  await localExec("git", ["stash", "push", "--include-untracked", "-m", "pre-pi-sync"]);
  const reset = await localExec("git", ["reset", "--hard", "origin/main"]);
  console.log(`  reset: ${reset.out.trim()}`);
  console.log(`  (laptop changes are in 'git stash list' — drop with 'git stash drop' if redundant)`);

  c.end();

  console.log("\n\x1b[1;32m✓ Production deployment complete.\x1b[0m");
  console.log(`  Dashboard:  http://${pi.host}:3000`);
  console.log(`  Service:    sudo systemctl status managet  (on the Pi)`);
  console.log(`  Logs:       journalctl -u managet -f       (on the Pi)`);
  console.log(`  Agent:      sudo systemctl status managet-agent`);
}

main().catch((err) => {
  console.error(`\n\x1b[1;31mFAILED:\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
