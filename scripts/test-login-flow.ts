/**
 * From the Pi itself, drive the full Auth.js v5 credentials flow against
 * the dashboard to see what the browser would see. Steps:
 *   1. GET /api/auth/csrf to obtain a csrfToken + cookie jar
 *   2. POST /api/auth/callback/credentials with email/password/csrfToken
 *   3. GET /api/servers with the resulting session cookie
 *   4. Test from the LAN IP too, in case the host header changes things
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

  // Drive both via 127.0.0.1 (loopback, what the Pi itself sees) and via
  // 192.168.100.82 (what a browser on the LAN would use). The Auth.js v5
  // CSRF check is sensitive to the Origin/Host header; if the loopback
  // works but the LAN IP doesn't, that's the signal.
  for (const base of ["http://127.0.0.1:3000", "http://192.168.100.82:3000"]) {
    console.log(`\n=== via ${base} ===`);

    const jarFile = `/tmp/cj-${Date.now()}.txt`;
    const flags = `-sS -m 10 -c ${jarFile} -b ${jarFile}`;

    // Step 1: csrf
    const csrfRes = await exec(`curl ${flags} -i ${base}/api/auth/csrf`);
    const csrfToken = csrfRes.match(/"csrfToken":"([^"]+)"/)?.[1];
    console.log(`csrf: token=${csrfToken?.slice(0, 12)}...`);

    // Step 2: credentials POST. Auth.js v5 expects:
    //   - x-www-form-urlencoded body with email, password, csrfToken,
    //     callbackUrl, json=true
    //   - Origin header matching the host (default trustHost behaviour)
    //   - cookie jar carrying the csrf cookie issued in step 1
    const loginCmd =
      `curl ${flags} -i -X POST ` +
      `-H 'Content-Type: application/x-www-form-urlencoded' ` +
      `-H 'Origin: ${base}' ` +
      `--data-urlencode 'email=admin@managet.local' ` +
      `--data-urlencode 'password=admin' ` +
      `--data-urlencode 'csrfToken=${csrfToken}' ` +
      `--data-urlencode 'callbackUrl=${base}/' ` +
      `--data-urlencode 'json=true' ` +
      `${base}/api/auth/callback/credentials`;
    const login = await exec(loginCmd);
    console.log(`login response (first 25 lines):`);
    console.log(login.split("\n").slice(0, 25).join("\n"));

    // Step 3: try /api/servers with the (hopefully populated) cookie jar
    const list = await exec(`curl ${flags} -i ${base}/api/servers`);
    console.log(`\n/api/servers response (first 12 lines):`);
    console.log(list.split("\n").slice(0, 12).join("\n"));

    // Show what's in the jar
    console.log(`\ncookie jar:`);
    console.log((await exec(`cat ${jarFile} | grep -v '^#' | grep -v '^$'`)).trim());
    await exec(`rm -f ${jarFile}`);
  }

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
