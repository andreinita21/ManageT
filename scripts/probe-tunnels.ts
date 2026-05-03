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
  const exec = (cmd: string) =>
    new Promise<string>((resolve) => {
      c.exec(cmd, (err, s) => {
        if (err) return resolve(`ERR ${err.message}`);
        let o = "";
        s.on("data", (d: Buffer) => (o += d.toString()));
        s.stderr.on("data", (d: Buffer) => (o += d.toString()));
        s.on("close", () => resolve(o));
      });
    });
  console.log("# tailscale?");
  console.log(await exec("which tailscale; /Applications/Tailscale.app/Contents/MacOS/Tailscale --version 2>/dev/null; tailscale status 2>/dev/null | head -10"));
  console.log("\n# mDNS resolution of host names?");
  console.log(await exec("scutil --dns 2>/dev/null | head -10; echo ---; dns-sd -G v4v6 host.docker.internal 2>&1 & sleep 1; kill %1 2>/dev/null"));
  console.log("\n# what's the laptop's mDNS name? Try common ones:");
  console.log(await exec("for n in andreis-MacBook-Pro.local andreis-MBP.local Andreis-MacBook-Pro.local; do echo \"-- $n --\"; ping -c 1 -W 1000 $n 2>&1 | head -2; done"));
  console.log("\n# IPv6 reachability test");
  console.log(await exec("ping6 -c 1 -h 2 2a02:2f01:7915:bc00::1 2>&1 | head -3"));
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
