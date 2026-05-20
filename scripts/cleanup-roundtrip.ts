/** One-shot: kill any leftover roundtrip-* test sessions on the Pi. */
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
  .prepare(
    "SELECT host, port, username, password_encrypted FROM servers WHERE name = ?"
  )
  .get("markI (Pi)") as {
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
};
db.close();
const c = new Client();
c.on("ready", () => {
  c.exec(
    `for n in $(/usr/local/bin/managet ls 2>/dev/null | awk '$2 ~ /^roundtrip-/ {print $1}'); do /usr/local/bin/managet kill $n 2>&1; done`,
    (err, s) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      s.on("data", (d: Buffer) => process.stdout.write(d.toString()));
      s.on("close", () => {
        c.end();
        process.exit(0);
      });
    }
  );
});
c.connect({
  host: row.host,
  port: row.port,
  username: row.username,
  password: decryptPassword(row.password_encrypted),
});
