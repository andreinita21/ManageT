/**
 * One-shot: from the Mac mini, probe what it can actually reach.
 */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";
import { decryptPassword } from "../src/lib/crypto";

const envPath = ".env.local";
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const serverId = process.argv[2];
const db = new Database("data/managet.db", { readonly: true });
const row = db
  .prepare("SELECT host, port, username, password_encrypted FROM servers WHERE id = ?")
  .get(serverId) as
  | { host: string; port: number; username: string; password_encrypted: string }
  | undefined;
if (!row) process.exit(1);

const client = new Client();
client.on("ready", async () => {
  const exec = (cmd: string) =>
    new Promise<string>((resolve) => {
      client.exec(cmd, (err, s) => {
        if (err) return resolve(`ERR: ${err.message}`);
        let out = "";
        s.on("data", (d: Buffer) => (out += d.toString()));
        s.stderr.on("data", (d: Buffer) => (out += d.toString()));
        s.on("close", (code: number | null) => resolve(`(exit ${code})\n${out}`));
      });
    });

  console.log("# routing/network info from the mini");
  console.log(await exec("netstat -rn | head -20"));
  console.log("# default route");
  console.log(await exec("route -n get default 2>&1 | head -10"));
  console.log("# ifconfig");
  console.log(await exec("ifconfig en0 2>&1 | head -10; echo ---; ifconfig | grep -E 'flags|inet ' | head -20"));
  console.log("# ping laptop LAN IP");
  console.log(await exec("ping -c 3 -W 1500 192.168.0.124 2>&1"));
  console.log("# traceroute to laptop");
  console.log(await exec("traceroute -m 5 -w 1 192.168.0.124 2>&1"));
  console.log("# can it reach the gateway 192.168.100.97?");
  console.log(await exec("curl -v -m 4 http://192.168.100.97:3000/ 2>&1 | head -20"));
  console.log("# nc test of laptop:3000");
  console.log(await exec("nc -zv -w 3 192.168.0.124 3000 2>&1"));
  client.end();
});
client.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
client.connect({
  host: row.host,
  port: row.port,
  username: row.username,
  password: decryptPassword(row.password_encrypted),
  readyTimeout: 20000,
});
