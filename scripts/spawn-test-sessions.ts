/** Spawn 3 fresh sessions on the Pi + reconcile so groups-smoke can run. */
import { readFileSync, existsSync } from "node:fs";
import { Client } from "ssh2";
import Database from "better-sqlite3";
import { decryptPassword } from "../src/lib/crypto";
import { reconcileServer } from "../src/lib/ssh/session-manager";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const db = new Database("data/managet.db", { readonly: true });
const row = db
  .prepare(
    "SELECT id, host, port, username, password_encrypted FROM servers WHERE name = ?"
  )
  .get("markI (Pi)") as {
  id: string;
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
};
db.close();

const c = new Client();
const pwd = decryptPassword(row.password_encrypted);
c.on("ready", async () => {
  for (let i = 1; i <= 3; i++) {
    await new Promise<void>((resolve, reject) => {
      c.exec(`/usr/local/bin/managet new -n smoke-${i} 2>&1`, (e, s) => {
        if (e) return reject(e);
        s.on("data", (d: Buffer) => process.stdout.write(d.toString()));
        s.on("close", () => resolve());
      });
    });
  }
  c.end();
  console.log("\nreconciling…");
  await reconcileServer(row.id);
  console.log("done");
});
c.connect({
  host: row.host,
  port: row.port,
  username: row.username,
  password: pwd,
});
