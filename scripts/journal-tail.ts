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
  const sudo = (cmd: string) =>
    exec(`echo ${JSON.stringify(decryptPassword(pi.password_encrypted))} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`);

  console.log("=== systemctl status managet ===");
  console.log((await sudo("systemctl status managet --no-pager 2>&1 | head -30")).trim());

  console.log("\n=== last 100 journal lines ===");
  console.log((await sudo("journalctl -u managet --no-pager -n 100")).trim());

  console.log("\n=== /api/auth/csrf with -v ===");
  console.log((await exec("curl -sS -v -m 8 http://127.0.0.1:3000/api/auth/csrf 2>&1 | head -40")).trim());

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
