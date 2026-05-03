/**
 * Reproduce the user's "Connect button does nothing" path against the live
 * Pi dashboard:
 *   1. Login via /api/auth/callback/credentials, capture session cookie.
 *   2. Hit /api/servers, dump the actual order + IDs.
 *   3. Open a real WebSocket to /api/ws with the cookie, send a
 *      `session:create` message for the Mac Mini, see if the server
 *      crashes or replies. This is exactly what TerminalPane.tsx does
 *      after createTab() runs.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import WebSocket from "ws";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const BASE = "http://192.168.100.82:3000";

async function curlLocal(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("close", () => resolve(out));
  });
}

async function main() {
  const jar = `/tmp/managet-test-jar-${process.pid}.txt`;
  writeFileSync(jar, "");
  const flags = ["-sS", "-m", "10", "-c", jar, "-b", jar];

  console.log("=== 1. login flow ===");
  const csrfRaw = await curlLocal([...flags, `${BASE}/api/auth/csrf`]);
  const tok = csrfRaw.match(/"csrfToken":"([^"]+)"/)?.[1];
  console.log(`csrf: ${tok?.slice(0, 12)}...`);
  const login = await curlLocal([
    ...flags,
    "-i",
    "-X",
    "POST",
    "-H",
    "Content-Type: application/x-www-form-urlencoded",
    "-H",
    `Origin: ${BASE}`,
    "--data-urlencode",
    "email=admin@managet.local",
    "--data-urlencode",
    "password=admin",
    "--data-urlencode",
    `csrfToken=${tok}`,
    "--data-urlencode",
    `callbackUrl=${BASE}/`,
    "--data-urlencode",
    "json=true",
    `${BASE}/api/auth/callback/credentials`,
  ]);
  console.log(`login first line: ${login.split("\n")[0]}`);

  // Pull the session cookie out of the jar to use with the WebSocket.
  const jarBody = readFileSync(jar, "utf8");
  const sessionTokenLine = jarBody
    .split("\n")
    .find((l) => l.includes("authjs.session-token"));
  const sessionToken = sessionTokenLine?.split("\t").pop()?.trim();
  console.log(`session-token cookie: ${sessionToken ? sessionToken.slice(0, 24) + "..." : "MISSING"}`);
  if (!sessionToken) throw new Error("no session-token cookie");

  console.log("\n=== 2. /api/servers ===");
  const servers = await curlLocal([...flags, `${BASE}/api/servers`]);
  console.log(servers.slice(0, 800));
  // Pull names + ids in display order
  const m = servers.match(/"data":\s*\[([\s\S]+)\]/);
  if (m) {
    const idMatches = [...m[1].matchAll(/"id":"([^"]+)"[^}]*"name":"([^"]+)"/g)];
    console.log("\nServers in API order:");
    for (const im of idMatches) console.log(`  ${im[2]}: ${im[1]}`);
  }

  console.log("\n=== 3. WebSocket flow ===");
  const ws = new WebSocket(`ws://192.168.100.82:3000/api/ws`, {
    headers: { Cookie: `authjs.session-token=${sessionToken}` },
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WS open timeout")), 8000);
    ws.on("open", () => {
      clearTimeout(timeout);
      console.log("WS open");
      resolve();
    });
    ws.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    ws.on("unexpected-response", (req, res) => {
      console.log(`WS unexpected-response: HTTP ${res.statusCode}`);
      reject(new Error(`upgrade got HTTP ${res.statusCode}`));
    });
  });

  console.log("Sending session:create for Mac Mini ...");
  ws.send(
    JSON.stringify({
      type: "session:create",
      serverId: "cfab293b-8571-4422-b57e-dca44c1f6b79",
    })
  );

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.log("(no message in 12s — server didn't respond)");
      resolve();
    }, 12000);
    let count = 0;
    ws.on("message", (raw) => {
      count++;
      const text = raw.toString().slice(0, 800);
      console.log(`[ws msg ${count}]: ${text}`);
      // After session:state arrives, give it 2s for any followup output, then end.
      setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, 3000);
    });
  });

  ws.close();
  console.log("\n=== done ===");
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
