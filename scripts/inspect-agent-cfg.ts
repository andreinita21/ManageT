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
  .prepare("SELECT host, port, username, password_encrypted, agent_token_hash FROM servers WHERE id = ?")
  .get("98ec98f1-5157-40b5-bb46-07f5b13948c0") as
  | { host: string; port: number; username: string; password_encrypted: string; agent_token_hash: string }
  | undefined;
const mini = db
  .prepare("SELECT host, port, username, password_encrypted, agent_token_hash FROM servers WHERE id = ?")
  .get("cfab293b-8571-4422-b57e-dca44c1f6b79") as
  | { host: string; port: number; username: string; password_encrypted: string; agent_token_hash: string }
  | undefined;
if (!pi || !mini) process.exit(1);

console.log(`Pi token hash:   ${pi.agent_token_hash}`);
console.log(`Mini token hash: ${mini.agent_token_hash}`);

const c = new Client();
c.on("ready", async () => {
  const exec = (cmd: string) =>
    new Promise<string>((res) => {
      c.exec(cmd, (err, s) => {
        if (err) return res(`ERR ${err.message}`);
        let o = "";
        s.on("data", (d: Buffer) => (o += d.toString()));
        s.stderr.on("data", (d: Buffer) => (o += d.toString()));
        s.on("close", () => res(o));
      });
    });
  const sudo = (cmd: string) =>
    exec(
      `echo ${JSON.stringify(decryptPassword(pi.password_encrypted))} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`
    );
  console.log("\n# /etc/managet-agent/config.toml on Pi:");
  console.log(await sudo("ls -la /etc/managet-agent/config.toml; echo ---; cat -A /etc/managet-agent/config.toml; echo ---END"));
  console.log("\n# pi agent log:");
  console.log(await sudo("journalctl -u managet-agent --no-pager -n 20"));
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
