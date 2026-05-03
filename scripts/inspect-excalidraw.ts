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

  console.log("=== docker ps (full) ===");
  console.log(await sudo("docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Command}}'"));

  console.log("\n=== ~/excalidraw contents ===");
  console.log(await exec("ls -la ~/excalidraw 2>&1; echo ---; ls -la ~/excalidraw/* 2>&1 | head -40"));

  console.log("\n=== ~/excalidraw/docker-compose.yml ===");
  console.log(await exec("cat ~/excalidraw/docker-compose.yml 2>&1; echo ---; cat ~/excalidraw/compose.yaml 2>&1"));

  console.log("\n=== cloudflared inspect (cloudflared) ===");
  console.log(await sudo("docker inspect cloudflared --format '{{json .Config.Cmd}} ARGS={{json .Args}} ENV={{range .Config.Env}}{{println .}}{{end}}'"));

  console.log("\n=== cloudflared-tunnel inspect ===");
  console.log(await sudo("docker inspect cloudflared-tunnel --format '{{json .Config.Cmd}} ARGS={{json .Args}} ENV={{range .Config.Env}}{{println .}}{{end}}'"));

  console.log("\n=== cloudflared logs (last 5 lines each) ===");
  console.log(await sudo("docker logs --tail 5 cloudflared 2>&1; echo ---; docker logs --tail 5 cloudflared-tunnel 2>&1"));

  console.log("\n=== cloudflared compose files? ===");
  console.log(await exec("find ~/ -maxdepth 3 -name 'docker-compose*' -o -name 'compose*.yaml' -o -name 'compose*.yml' 2>/dev/null | head -20"));

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
