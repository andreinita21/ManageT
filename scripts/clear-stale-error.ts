/**
 * Clear stale agent_install_error / agent_install_stage on rows that are
 * now healthy. The heartbeat handler doesn't auto-clear those fields when
 * a previously-failed install starts succeeding, so the dashboard would
 * keep showing the red banner forever.
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
c.on("ready", () => {
  c.exec(
    `sqlite3 /home/andrei/managet/data/managet.db "UPDATE servers SET agent_install_error=NULL, agent_install_stage=NULL WHERE agent_status='healthy' AND (agent_install_error IS NOT NULL OR agent_install_stage IS NOT NULL); SELECT name, agent_status, COALESCE(agent_install_error,'NULL') AS err FROM servers;"`,
    (err, s) => {
      if (err) throw err;
      let o = "";
      s.on("data", (d: Buffer) => (o += d.toString()));
      s.stderr.on("data", (d: Buffer) => (o += d.toString()));
      s.on("close", () => {
        console.log(o.trim());
        c.end();
      });
    }
  );
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
