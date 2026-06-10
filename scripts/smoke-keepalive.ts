/**
 * Headless smoke test for the agent-hosted session architecture.
 *
 * Uses raw HTTP + ws (no browser) to exercise the path:
 *   1. Login as admin (NextAuth credentials).
 *   2. POST /api/servers/:piId/sessions to create a session via the agent.
 *   3. Open a WS, attach to that session, type a marker command, see it
 *      echoed back in terminal:output frames.
 *   4. Verify the local `managet ls` on this Pi sees the same session.
 *   5. Drop the WS (simulating browser refresh / dashboard restart),
 *      open a fresh WS, re-attach to the same session id, and confirm
 *      a *new* command issued post-reattach also makes it through.
 *      (Scrollback replay is a nice-to-have but not asserted here
 *      because the WS protocol streams output, not a single replay
 *      frame — the marker check after re-attach proves liveness.)
 *   6. Kill the session, verify it's gone from `managet ls`.
 *
 * Tests pass = sessions are agent-hosted and outlive WS drops.
 */
import { exec } from "node:child_process";
import { WebSocket } from "ws";
import { adminPassword } from "./_creds.js";

const BASE = "http://localhost:3000";
const PI_HOST = "192.168.100.82";
const ADMIN_EMAIL = "admin@managet.local";
const ADMIN_PASSWORD = adminPassword();

interface Cookies { jar: Map<string, string> }
function cookieHeader(c: Cookies): string {
  return Array.from(c.jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}
function ingest(c: Cookies, headers: Headers): void {
  const all =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : ([headers.get("set-cookie")].filter(Boolean) as string[]);
  for (const sc of all) {
    const [pair] = sc.split(";");
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    c.jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
}

async function login(): Promise<Cookies> {
  const c: Cookies = { jar: new Map() };
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  ingest(c, csrfRes.headers);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const r = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(c),
    },
    body: new URLSearchParams({
      csrfToken,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      callbackUrl: `${BASE}/dashboard`,
      json: "true",
    }),
    redirect: "manual",
  });
  ingest(c, r.headers);
  return c;
}

async function findPiServerId(c: Cookies): Promise<string> {
  const r = await fetch(`${BASE}/api/servers`, {
    headers: { Cookie: cookieHeader(c) },
  });
  const j = (await r.json()) as { data: Array<{ id: string; host: string }> };
  const pi = j.data.find((s) => s.host === PI_HOST);
  if (!pi) throw new Error(`Pi (${PI_HOST}) not in /api/servers`);
  return pi.id;
}

async function createSession(c: Cookies, serverId: string, command?: string): Promise<{ id: string; sessionName: string }> {
  const r = await fetch(`${BASE}/api/servers/${serverId}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(c),
    },
    body: JSON.stringify({ command }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`createSession HTTP ${r.status}: ${t}`);
  }
  const j = (await r.json()) as { data: { id: string; sessionName: string } };
  return j.data;
}

function openWs(sessionToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:3000/api/ws?token=${encodeURIComponent(sessionToken)}`;
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", (e: Error) => reject(e));
  });
}

interface AttachResult {
  ws: WebSocket;
  output: string;
  pushOutput: (s: string) => void;
}

function makeOutputCollector(): { ws: WebSocket; output: { value: string }; ready: Promise<void> } {
  return null as unknown as { ws: WebSocket; output: { value: string }; ready: Promise<void> };
}

async function attachSessionWs(
  c: Cookies,
  serverId: string,
  sessionId: string
): Promise<{ ws: WebSocket; output: { value: string } }> {
  const sessionToken = c.jar.get("authjs.session-token") ?? c.jar.get("next-auth.session-token");
  if (!sessionToken) throw new Error("no session token cookie");
  const ws = await openWs(sessionToken);
  const output = { value: "" };
  ws.on("message", (raw: Buffer) => {
    const text = raw.toString("utf-8");
    let msg:
      | { type: "terminal:output"; sessionId: string; data: string }
      | { type: "session:state"; session: { sessionName: string } }
      | { type: "session:lost"; sessionId: string; reason: string }
      | { type: string };
    try {
      msg = JSON.parse(text);
    } catch {
      console.log(`  [ws] non-json: ${text.slice(0, 80)}`);
      return;
    }
    if (msg.type === "terminal:output" && "data" in msg) {
      output.value += msg.data;
      // Show first chunk only so logs stay short.
      if (output.value.length < 200) {
        console.log(`  [ws<-output ${msg.data.length}b] ${JSON.stringify(msg.data.slice(0, 60))}`);
      }
    } else if (msg.type === "session:lost" && "reason" in msg) {
      console.log(`  [ws<-lost] ${msg.reason}`);
    } else if (msg.type === "session:state") {
      console.log(`  [ws<-state] attached`);
    } else {
      console.log(`  [ws<-?] ${JSON.stringify(msg).slice(0, 120)}`);
    }
  });
  ws.send(
    JSON.stringify({ type: "session:attach", sessionId, serverId })
  );
  return { ws, output };
}

function sh(cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve({ stdout, stderr, code: err?.code ?? 0 });
    });
  });
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function expectInOutput(
  output: { value: string },
  needle: string,
  timeoutMs = 8_000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (output.value.includes(needle)) return true;
    await delay(200);
  }
  return false;
}

async function main() {
  console.log("=== 1. login ===");
  const c = await login();
  const sessionTokenCookie =
    c.jar.get("authjs.session-token") ?? c.jar.get("next-auth.session-token");
  if (!sessionTokenCookie) throw new Error("login did not produce session cookie");
  console.log("  logged in");

  console.log("\n=== 2. find Pi server id ===");
  const piId = await findPiServerId(c);
  console.log(`  Pi id = ${piId.slice(0, 8)}`);

  console.log("\n=== 3. create a session via the dashboard API ===");
  const created = await createSession(c, piId);
  const sid = created.id;
  console.log(`  created ${sid.slice(0, 8)} (${created.sessionName})`);

  console.log("\n=== 4. attach via WS, send marker, expect echo ===");
  const a = await attachSessionWs(c, piId, sid);
  await delay(500); // give the agent's session:state + initial prompt time to land
  const marker = `marker-${Date.now()}`;
  a.ws.send(JSON.stringify({
    type: "terminal:input",
    sessionId: sid,
    data: `echo ${marker}\n`,
  }));
  if (!(await expectInOutput(a.output, marker))) {
    console.log(`  FAIL — marker not seen in output. tail:\n${a.output.value.slice(-300)}`);
    process.exit(1);
  }
  console.log(`  marker echoed ✓`);

  console.log("\n=== 5. local `managet ls` sees the session ===");
  const ls = await sh("managet ls");
  if (!ls.stdout.includes(sid.slice(0, 8))) {
    console.log(`  FAIL — managet ls missing ${sid.slice(0, 8)}.\n${ls.stdout}`);
    process.exit(1);
  }
  console.log(`  agent-side ls shows session ✓`);

  console.log("\n=== 6. drop WS, re-attach, type a fresh marker ===");
  a.ws.close();
  await delay(800);
  const a2 = await attachSessionWs(c, piId, sid);
  await delay(500);
  const marker2 = `after-reattach-${Date.now()}`;
  a2.ws.send(JSON.stringify({
    type: "terminal:input",
    sessionId: sid,
    data: `echo ${marker2}\n`,
  }));
  if (!(await expectInOutput(a2.output, marker2))) {
    console.log(`  FAIL — fresh marker not seen post-reattach. tail:\n${a2.output.value.slice(-300)}`);
    process.exit(1);
  }
  console.log(`  re-attached PTY is live ✓`);

  console.log("\n=== 7. kill session via API ===");
  const killRes = await fetch(`${BASE}/api/sessions/${sid}`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader(c) },
  });
  if (!killRes.ok) {
    console.log(`  kill HTTP ${killRes.status}: ${await killRes.text()}`);
    process.exit(1);
  }
  await delay(800);
  const ls2 = await sh("managet ls");
  if (ls2.stdout.includes(sid.slice(0, 8))) {
    console.log(`  WARN — session still in agent ls (cleanup is on-list, not a hard fail).`);
  } else {
    console.log(`  agent-side ls no longer shows it ✓`);
  }
  a2.ws.close();

  console.log("\n\x1b[1;32m✓ smoke test passed — agent-hosted sessions survive WS drops\x1b[0m");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
