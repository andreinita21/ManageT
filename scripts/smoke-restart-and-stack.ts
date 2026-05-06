/**
 * Two further smoke tests:
 *
 *   A. Dashboard-restart survival: create a session, kill the Node
 *      dashboard process entirely, restart it, verify the session is
 *      still attachable and a *new* WS-issued command produces output.
 *
 *   B. Stack fan-out: build a 2-service stack across the Pi and the Mac
 *      mini, launch it, verify both sessions appear in the dashboard's
 *      session list with stackId set, and confirm the agent on each
 *      box sees the matching session id.
 */
import { exec, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

const BASE = "http://localhost:3000";
const PI_HOST = "192.168.100.82";
const MAC_HOST = "192.168.100.95";

interface Cookies { jar: Map<string, string> }
const cookieHeader = (c: Cookies) =>
  Array.from(c.jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
const ingest = (c: Cookies, headers: Headers) => {
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
};

async function login(): Promise<Cookies> {
  const c: Cookies = { jar: new Map() };
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  ingest(c, csrfRes.headers);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(c),
    },
    body: new URLSearchParams({
      csrfToken,
      email: "admin@managet.local",
      password: "admin",
      callbackUrl: `${BASE}/dashboard`,
      json: "true",
    }),
    redirect: "manual",
  }).then((r) => ingest(c, r.headers));
  return c;
}

async function findServerId(c: Cookies, host: string): Promise<string> {
  const r = await fetch(`${BASE}/api/servers`, {
    headers: { Cookie: cookieHeader(c) },
  });
  const j = (await r.json()) as { data: Array<{ id: string; host: string }> };
  const m = j.data.find((s) => s.host === host);
  if (!m) throw new Error(`server ${host} not in /api/servers`);
  return m.id;
}

const sh = (cmd: string) =>
  new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve({ stdout, stderr, code: err?.code ?? 0 });
    });
  });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attachAndExpect(
  c: Cookies,
  serverId: string,
  sessionId: string,
  marker: string
): Promise<boolean> {
  const sessionToken =
    c.jar.get("authjs.session-token") ?? c.jar.get("next-auth.session-token");
  if (!sessionToken) throw new Error("no session token");
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(
      `ws://localhost:3000/api/ws?token=${encodeURIComponent(sessionToken)}`
    );
    w.once("open", () => resolve(w));
    w.once("error", reject);
  });
  const out = { value: "" };
  let stateSeen = false;
  ws.on("message", (raw: Buffer) => {
    try {
      const m = JSON.parse(raw.toString("utf-8")) as {
        type: string;
        data?: string;
        reason?: string;
      };
      if (m.type === "terminal:output" && m.data) out.value += m.data;
      else if (m.type === "session:state") stateSeen = true;
      else if (m.type === "session:lost") console.log(`    [lost] ${m.reason}`);
    } catch {
      /* ignore */
    }
  });
  ws.send(JSON.stringify({ type: "session:attach", sessionId, serverId }));
  // Wait for session:state before sending input — first attach after a
  // dashboard restart needs SSH to establish.
  const stateStart = Date.now();
  while (!stateSeen && Date.now() - stateStart < 15_000) {
    await delay(150);
  }
  if (!stateSeen) {
    console.log("    [no session:state within 15s]");
  }
  ws.send(
    JSON.stringify({
      type: "terminal:input",
      sessionId,
      data: `echo ${marker}\n`,
    })
  );
  const start = Date.now();
  while (Date.now() - start < 12_000) {
    if (out.value.includes(marker)) {
      ws.close();
      return true;
    }
    await delay(200);
  }
  console.log(
    `    [timeout, output bytes=${out.value.length}, tail=${JSON.stringify(out.value.slice(-200))}]`
  );
  ws.close();
  return false;
}

async function createSession(c: Cookies, serverId: string): Promise<string> {
  const r = await fetch(`${BASE}/api/servers/${serverId}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(c),
    },
    body: JSON.stringify({}),
  });
  const j = (await r.json()) as { data: { id: string } };
  return j.data.id;
}

async function waitForDashboard(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      const r = await fetch(`${BASE}/login`);
      if (r.ok) return;
    } catch {
      /* ignore */
    }
    await delay(500);
  }
  throw new Error("dashboard did not come up within 60s");
}

async function partA() {
  console.log("=== A. dashboard restart survival ===");
  const c = await login();
  const piId = await findServerId(c, PI_HOST);
  const sid = await createSession(c, piId);
  console.log(`  created ${sid.slice(0, 8)}`);

  if (!(await attachAndExpect(c, piId, sid, `pre-restart-${Date.now()}`))) {
    console.log("  FAIL pre-restart attach");
    process.exit(1);
  }
  console.log("  pre-restart attach ✓");

  console.log("  killing dashboard...");
  await sh("pkill -f 'tsx server.ts'");
  await delay(2_000);
  // Confirm it's down.
  await sh("pkill -9 -f 'tsx server.ts' || true");
  await delay(1_000);

  console.log("  relaunching dashboard...");
  // Start detached; piping stdio to /dev/null keeps the parent free to exit.
  const child = spawn("npx", ["tsx", "server.ts"], {
    cwd: "/home/andrei/managet",
    env: {
      ...process.env,
      MANAGET_DASHBOARD_URL: "http://192.168.100.82:3000",
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await waitForDashboard();
  console.log("  dashboard back up");

  // New cookies — old session token MIGHT still work if the JWT is still valid
  // (NextAuth uses signed JWT cookies by default). But re-login is the safe move.
  const c2 = await login();
  const sessions = (await (
    await fetch(`${BASE}/api/servers/${piId}/sessions`, {
      headers: { Cookie: cookieHeader(c2) },
    })
  ).json()) as { data: Array<{ id: string; status: string }> };
  const survivor = sessions.data.find((s) => s.id === sid);
  if (!survivor) {
    console.log(`  FAIL — session ${sid.slice(0, 8)} not found after restart`);
    process.exit(1);
  }
  console.log(`  session is still listed (status=${survivor.status})`);

  if (!(await attachAndExpect(c2, piId, sid, `post-restart-${Date.now()}`))) {
    console.log("  FAIL post-restart attach");
    process.exit(1);
  }
  console.log("  post-restart attach ✓ — PTY survived dashboard restart");

  // Clean up.
  await fetch(`${BASE}/api/sessions/${sid}`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader(c2) },
  });
}

async function partB() {
  console.log("\n=== B. stack fan-out across Pi + Mac ===");
  const c = await login();
  const piId = await findServerId(c, PI_HOST);
  const macId = await findServerId(c, MAC_HOST);
  console.log(`  Pi=${piId.slice(0, 8)}  Mac=${macId.slice(0, 8)}`);

  // Create stack via API.
  const stackRes = await fetch(`${BASE}/api/stacks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(c),
    },
    body: JSON.stringify({
      name: "smoke-stack",
      description: "two-service smoke",
      services: [
        { name: "pi-task", serverId: piId, command: "echo PI_OK && sleep 5" },
        { name: "mac-task", serverId: macId, command: "echo MAC_OK && sleep 5" },
      ],
    }),
  });
  if (!stackRes.ok) {
    console.log(`  FAIL stack create HTTP ${stackRes.status}: ${await stackRes.text()}`);
    process.exit(1);
  }
  const { data: stack } = (await stackRes.json()) as { data: { id: string } };
  console.log(`  created stack ${stack.id.slice(0, 8)}`);

  // Launch.
  const launchRes = await fetch(`${BASE}/api/stacks/${stack.id}/launch`, {
    method: "POST",
    headers: { Cookie: cookieHeader(c) },
  });
  const launchBody = (await launchRes.json()) as {
    data: {
      launched: Array<{ serviceId: string; sessionId: string; serverId: string }>;
      failed: Array<{ serviceId: string; error: string }>;
    };
  };
  console.log(
    `  launched=${launchBody.data.launched.length} failed=${launchBody.data.failed.length}`
  );
  if (launchBody.data.failed.length > 0) {
    for (const f of launchBody.data.failed) {
      console.log(`    [fail] ${f.serviceId}: ${f.error}`);
    }
  }
  if (launchBody.data.launched.length !== 2) {
    console.log(`  FAIL: expected 2 launched, got ${launchBody.data.launched.length}`);
    process.exit(1);
  }

  // Verify both sessions appear in their respective server lists.
  for (const l of launchBody.data.launched) {
    const r = await fetch(`${BASE}/api/servers/${l.serverId}/sessions`, {
      headers: { Cookie: cookieHeader(c) },
    });
    const j = (await r.json()) as { data: Array<{ id: string; stackId?: string }> };
    const found = j.data.find((s) => s.id === l.sessionId);
    if (!found) {
      console.log(`  FAIL: launched session ${l.sessionId.slice(0, 8)} not in server list`);
      process.exit(1);
    }
    if (found.stackId !== stack.id) {
      console.log(
        `  FAIL: stackId mismatch on ${l.sessionId.slice(0, 8)}: ${found.stackId}`
      );
      process.exit(1);
    }
  }
  console.log("  both sessions tagged with stackId ✓");

  // Attach to the Pi service and confirm the command output appears.
  const piLaunch = launchBody.data.launched.find((l) => l.serverId === piId)!;
  if (!(await attachAndExpect(c, piId, piLaunch.sessionId, "PI_OK"))) {
    console.log("  FAIL: PI_OK not seen on Pi service");
    process.exit(1);
  }
  console.log("  Pi service produced its expected output ✓");

  // Stop the stack.
  const stopRes = await fetch(`${BASE}/api/stacks/${stack.id}/stop`, {
    method: "POST",
    headers: { Cookie: cookieHeader(c) },
  });
  const stopBody = (await stopRes.json()) as { data: { stopped: number } };
  console.log(`  stopped ${stopBody.data.stopped} session(s) ✓`);

  // Cleanup.
  await fetch(`${BASE}/api/stacks/${stack.id}`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader(c) },
  });
}

async function main() {
  if (!existsSync("/home/andrei/managet/data/managet.db")) {
    throw new Error("data/managet.db is missing — seed it first");
  }
  await partA();
  await partB();
  console.log("\n\x1b[1;32m✓ all smoke tests passed\x1b[0m");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
