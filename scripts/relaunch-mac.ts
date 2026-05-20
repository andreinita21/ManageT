/** Retry launchctl bootstrap of the mac mini agent. */
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
  .get("Mac mini") as {
  host: string;
  port: number;
  username: string;
  password_encrypted: string;
};
db.close();
const pwd = decryptPassword(row.password_encrypted);

function exec(c: Client, cmd: string) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    c.exec(cmd, (err, s) => {
      if (err) return resolve({ code: -1, out: "", err: err.message });
      let out = "";
      let er = "";
      s.on("data", (d: Buffer) => (out += d.toString()));
      s.stderr.on("data", (d: Buffer) => (er += d.toString()));
      s.on("close", (code: number | null) =>
        resolve({ code: code ?? -1, out, err: er })
      );
    });
  });
}
function sudo(c: Client, cmd: string) {
  return exec(c, `echo ${JSON.stringify(pwd)} | sudo -S -p '' bash -c ${JSON.stringify(cmd)}`);
}

const c = new Client();
c.on("ready", async () => {
  console.log("[1] Inspecting current state");
  const state = await sudo(
    c,
    "launchctl print system/com.managet.agent 2>&1 | grep -E 'state =|pid =|program =' | head -5; echo ---; ls -la /Library/LaunchDaemons/com.managet.agent.plist"
  );
  console.log(state.out);

  console.log("\n[2] Force boot-out (idempotent)");
  await sudo(c, "launchctl bootout system/com.managet.agent 2>&1; true");
  await new Promise((r) => setTimeout(r, 2000));

  console.log("\n[3] Bootstrap again");
  const boot = await sudo(
    c,
    "launchctl bootstrap system /Library/LaunchDaemons/com.managet.agent.plist 2>&1; echo exit=$?"
  );
  console.log(boot.out, boot.err);

  console.log("\n[4] Wait + verify");
  await new Promise((r) => setTimeout(r, 3000));
  const after = await sudo(
    c,
    "launchctl print system/com.managet.agent 2>&1 | grep -E 'state =|pid =' | head -3"
  );
  console.log(after.out);

  console.log("\n[5] managet ls");
  const ls = await exec(c, "/usr/local/bin/managet ls 2>&1");
  console.log(ls.out);

  c.end();
});
c.on("error", (e) => {
  console.error("ssh error:", e.message);
  process.exit(1);
});
c.connect({
  host: row.host,
  port: row.port,
  username: row.username,
  password: pwd,
});
