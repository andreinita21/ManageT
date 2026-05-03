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
  console.log("=== last 50 non-heartbeat lines ===");
  console.log((await exec("grep -vE 'heartbeat|^$' /tmp/managet-dev.log | tail -50")).trimEnd());
  console.log("\n=== count of each route ===");
  console.log((await exec("grep -oE '(GET|POST) /[^ ]+' /tmp/managet-dev.log | sort | uniq -c | sort -rn | head -25")).trimEnd());

  console.log("\n=== now: triggering a /dashboard fetch from the laptop, then waiting + tailing ===");
  // Move the cursor: copy current line count for diff.
  const before = (await exec("wc -l < /tmp/managet-dev.log")).trim();
  console.log(`baseline lines: ${before}`);

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
