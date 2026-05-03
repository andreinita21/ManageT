/** Inventory the Pi so we know what's there before migrating. */
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
const row = db
  .prepare("SELECT host, port, username, password_encrypted FROM servers WHERE id = ?")
  .get(process.argv[2]) as
  | { host: string; port: number; username: string; password_encrypted: string }
  | undefined;
if (!row) process.exit(1);

const c = new Client();
c.on("ready", async () => {
  const exec = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      c.exec(cmd, (err, s) => {
        if (err) return resolve(`ERR ${err.message}`);
        let o = "";
        s.on("data", (d: Buffer) => (o += d.toString()));
        s.stderr.on("data", (d: Buffer) => (o += d.toString()));
        s.on("close", () => resolve(o));
      });
    });
  const sudo = (cmd: string) =>
    exec(
      `echo ${JSON.stringify(decryptPassword(row.password_encrypted))} | sudo -S -p '' bash -c ${JSON.stringify(cmd)} 2>&1`
    );

  const sections: Array<[string, string, "exec" | "sudo"]> = [
    ["uname / OS / arch", "uname -a; cat /etc/os-release 2>/dev/null | head -5", "exec"],
    ["cpu / memory / disk", "nproc; free -h; df -h / 2>&1 | head -3", "exec"],
    ["whoami / home", "whoami; echo \"HOME=$HOME\"; pwd", "exec"],
    ["git", "git --version 2>&1", "exec"],
    ["node / npm / npx", "node --version 2>&1; npm --version 2>&1; which npx 2>&1", "exec"],
    ["other useful tools", "for t in tsx tmux rsync curl jq sqlite3 build-essential gcc cargo rustc; do printf '%-20s ' $t; command -v $t >/dev/null 2>&1 && command -v $t || echo MISSING; done", "exec"],
    ["python (sometimes needed for sqlite3 native build)", "python3 --version 2>&1; which python3", "exec"],
    ["what's on port 3000?", "ss -ltnp 'sport = :3000' 2>&1; echo ---; lsof -nP -iTCP:3000 -sTCP:LISTEN 2>&1 || true", "sudo"],
    ["nginx config + sites", "ls -la /etc/nginx/ 2>/dev/null; echo ---; ls -la /etc/nginx/sites-enabled/ 2>/dev/null; echo ---; grep -rE 'listen|proxy_pass|server_name' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | head -40", "sudo"],
    ["nginx process", "systemctl status nginx --no-pager 2>&1 | head -10", "sudo"],
    ["existing managet-agent on the pi", "ls -la /etc/managet-agent/config.toml 2>&1; cat /etc/managet-agent/config.toml 2>&1; echo ---; systemctl status managet-agent --no-pager 2>&1 | head -10", "sudo"],
    ["existing dashboard processes / pm2 / docker", "ps -ef | grep -E 'node|managet|next|dashboard' | grep -v grep; echo ---; docker ps 2>/dev/null | head -5; echo ---; pm2 list 2>/dev/null | head -10", "exec"],
    ["home dir contents", "ls -la $HOME | head -30", "exec"],
    ["common dev dirs", "ls -la /opt 2>/dev/null; ls -la /srv 2>/dev/null", "exec"],
    ["IP / hostname", "hostname; ip -4 addr 2>&1 | grep -E 'inet |UP' | head -10", "exec"],
  ];

  for (const [label, cmd, mode] of sections) {
    console.log(`\n=== ${label} ===`);
    const out = mode === "sudo" ? await sudo(cmd) : await exec(cmd);
    console.log(out.trimEnd() || "(no output)");
  }
  c.end();
});
c.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
c.connect({
  host: row.host,
  port: row.port,
  username: row.username,
  password: decryptPassword(row.password_encrypted),
  readyTimeout: 20000,
});
