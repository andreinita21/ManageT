/**
 * Inspect what the Pi dashboard is actually doing — log tail, what it
 * answers on each /api endpoint, what's in the DB, browser-visible
 * fetches. Goal: figure out what "the backend doesn't load" means.
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

const c = new Client();
c.on("ready", async () => {
  const exec = (cmd: string) =>
    new Promise<string>((r) => {
      c.exec(cmd, (err, s) => {
        if (err) return r("ERR " + err.message);
        let o = "";
        s.on("data", (d: Buffer) => (o += d.toString()));
        s.stderr.on("data", (d: Buffer) => (o += d.toString()));
        s.on("close", () => r(o));
      });
    });

  console.log("=== last 80 lines of dashboard log ===");
  console.log((await exec("tail -n 80 /tmp/managet-dev.log")).trimEnd());

  console.log("\n=== tmux session running? ===");
  console.log((await exec("tmux ls 2>&1; ps -ef | grep -E 'tsx|next' | grep -v grep | head -5")).trim());

  console.log("\n=== curl GET / (UI shell) ===");
  console.log((await exec("curl -sS -m 10 -o /dev/null -w 'HTTP %{http_code} time=%{time_total}s len=%{size_download}\\n' http://127.0.0.1:3000/")).trim());

  console.log("\n=== curl GET /api/auth/session (next-auth probe) ===");
  console.log((await exec("curl -sS -m 10 -i http://127.0.0.1:3000/api/auth/session 2>&1 | head -30")).trim());

  console.log("\n=== curl GET /api/servers (should require auth → expect 401) ===");
  console.log((await exec("curl -sS -m 10 -i http://127.0.0.1:3000/api/servers 2>&1 | head -25")).trim());

  console.log("\n=== curl GET /api/auth/csrf ===");
  console.log((await exec("curl -sS -m 10 -i http://127.0.0.1:3000/api/auth/csrf 2>&1 | head -15")).trim());

  console.log("\n=== users table ===");
  console.log((await exec(`sqlite3 /home/andrei/managet/data/managet.db ".schema users" 2>&1`)).trim());
  console.log((await exec(`sqlite3 /home/andrei/managet/data/managet.db "SELECT id, email, role FROM users;" 2>&1`)).trim());

  console.log("\n=== schema diff: drizzle journal vs DB ===");
  console.log((await exec("ls -la /home/andrei/managet/drizzle/ 2>&1; echo ---; cat /home/andrei/managet/drizzle/meta/_journal.json 2>&1")).trim());

  console.log("\n=== .env.local ===");
  console.log((await exec("cat /home/andrei/managet/.env.local")).trim());

  console.log("\n=== node + npm versions ===");
  console.log((await exec("node --version; npm --version")).trim());

  console.log("\n=== package versions of next/next-auth ===");
  console.log((await exec("cd /home/andrei/managet && node -e 'const p=require(\"./package.json\"); console.log(JSON.stringify(p.dependencies, null, 2))' 2>&1 | head -20")).trim());

  console.log("\n=== running open ports on the Pi ===");
  console.log((await exec("ss -ltn 2>&1 | head -10")).trim());

  c.end();
});
c.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
c.connect({
  host: pi.host,
  port: pi.port,
  username: pi.username,
  password: decryptPassword(pi.password_encrypted),
  readyTimeout: 20000,
});
