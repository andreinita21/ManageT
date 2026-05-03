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
    exec(`echo ${JSON.stringify(piPwd)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`);

  console.log("=== last 60 lines of journal (no heartbeats) ===");
  console.log(
    (await sudo("journalctl -u managet --no-pager -n 200 | grep -vE 'POST /api/agent/heartbeat' | tail -60")).trim()
  );

  console.log("\n=== count of hits per route in last 200 lines ===");
  console.log(
    (await sudo("journalctl -u managet --no-pager -n 500 | grep -oE '(GET|POST) /[^ ]+' | sort | uniq -c | sort -rn | head -20")).trim()
  );

  console.log("\n=== anything matching session/terminal/ws in journal ===");
  console.log(
    (await sudo("journalctl -u managet --no-pager -n 500 | grep -iE 'session|terminal|websocket|\\\\[WS\\\\]|api/ws|api/sessions' | tail -30")).trim() || "(nothing)"
  );

  console.log("\n=== sessions table ===");
  console.log(
    (await exec(`sqlite3 /home/andrei/managet/data/managet.db ".schema sessions" 2>&1; echo ---; sqlite3 /home/andrei/managet/data/managet.db "SELECT id, server_id, status, command, created_at FROM sessions ORDER BY created_at DESC LIMIT 10;"`)).trim()
  );

  console.log("\n=== test WebSocket upgrade via curl ===");
  // -i shows headers; --include shows status; we want the 101 / 401 result.
  console.log(
    (await exec(
      "curl -i -sS -m 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' http://127.0.0.1:3000/api/ws 2>&1 | head -10"
    )).trim()
  );

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
  password: piPwd,
  readyTimeout: 20000,
});
