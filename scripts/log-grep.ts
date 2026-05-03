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

  console.log("=== non-heartbeat traffic in dashboard log ===");
  console.log((await exec("grep -vE '/api/agent/heartbeat|^$' /tmp/managet-dev.log | tail -100")).trimEnd());

  console.log("\n=== all GET /xxx and POST /xxx (browser traffic), last 100 ===");
  console.log((await exec("grep -E '^[ ]*(GET|POST|PATCH|DELETE) ' /tmp/managet-dev.log | grep -v heartbeat | tail -100")).trimEnd());

  console.log("\n=== compile / error / warning lines ===");
  console.log((await exec("grep -iE 'error|warning|fail|fatal|unhandled|exception|compil' /tmp/managet-dev.log | tail -50")).trimEnd());

  console.log("\n=== log file size + first 5 lines ===");
  console.log((await exec("wc -l /tmp/managet-dev.log; ls -la /tmp/managet-dev.log; head -5 /tmp/managet-dev.log")).trim());

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
