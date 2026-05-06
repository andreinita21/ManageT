/**
 * Set up the Pi ↔ Mac peer demo:
 *
 *   1. Copy /home/andrei/managet-demo/peer.py from the Pi to the Mac
 *      at /Users/andrei/managet-demo/peer.py via SFTP.
 *   2. Log into the dashboard, find the Pi + Mac server ids.
 *   3. If a stack named "Pi ↔ Mac peer demo" already exists, replace
 *      its services. Otherwise create it.
 *   4. Launch the stack and report per-service status + the URLs to
 *      open in a browser.
 *
 *   MANAGET_DEV_PASSWORD='2006' npx tsx scripts/setup-peer-demo.ts
 */
import { readFileSync } from "node:fs";
import { Client, type SFTPWrapper } from "ssh2";

const BASE = "http://localhost:3000";
const ADMIN_EMAIL = "andrei@test.com";
const ADMIN_PASSWORD = "2006";
const PI_HOST = "192.168.100.82";
const MAC_HOST = "192.168.100.95";

const LOCAL_SCRIPT = "/home/andrei/managet-demo/peer.py";
const REMOTE_DIR_MAC = "/Users/andrei/managet-demo";
const REMOTE_SCRIPT_MAC = `${REMOTE_DIR_MAC}/peer.py`;

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
  const session = (await (
    await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: cookieHeader(c) } })
  ).json()) as { user?: { email?: string } };
  if (!session.user?.email) {
    throw new Error("login failed — wrong creds?");
  }
  console.log(`[login] signed in as ${session.user.email}`);
  return c;
}

interface Server { id: string; name: string; host: string }
async function getServers(c: Cookies): Promise<Server[]> {
  const r = await fetch(`${BASE}/api/servers`, { headers: { Cookie: cookieHeader(c) } });
  const j = (await r.json()) as { data: Server[] };
  return j.data;
}

interface Stack {
  id: string;
  name: string;
  services: Array<{ id: string; name: string; serverId: string; command?: string }>;
}
async function getStacks(c: Cookies): Promise<Stack[]> {
  const r = await fetch(`${BASE}/api/stacks`, { headers: { Cookie: cookieHeader(c) } });
  const j = (await r.json()) as { data: Stack[] };
  return j.data;
}

async function uploadToMac(): Promise<void> {
  const password = process.env.MANAGET_DEV_PASSWORD;
  if (!password) throw new Error("MANAGET_DEV_PASSWORD must be set");
  const content = readFileSync(LOCAL_SCRIPT);

  return new Promise<void>((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => {
      // mkdir -p REMOTE_DIR_MAC, then SFTP upload.
      c.exec(`mkdir -p ${REMOTE_DIR_MAC}`, { pty: false }, (err, stream) => {
        if (err) {
          c.end();
          reject(err);
          return;
        }
        stream.on("close", () => {
          c.sftp((sErr: Error | undefined, sftp: SFTPWrapper) => {
            if (sErr) {
              c.end();
              reject(sErr);
              return;
            }
            const ws = sftp.createWriteStream(REMOTE_SCRIPT_MAC, { mode: 0o755 });
            ws.on("close", () => {
              c.end();
              resolve();
            });
            ws.on("error", (e: Error) => {
              c.end();
              reject(e);
            });
            ws.end(content);
          });
        });
        // Drain stdout/stderr to avoid buffer-fill stalls.
        stream.on("data", () => {});
        stream.stderr.on("data", () => {});
      });
    })
      .on("error", reject)
      .connect({
        host: MAC_HOST,
        port: 22,
        username: "andrei",
        password,
        readyTimeout: 15000,
      });
  });
}

async function ensureStack(
  c: Cookies,
  piId: string,
  macId: string
): Promise<string> {
  const piCmd =
    `python3 /home/andrei/managet-demo/peer.py ` +
    `--port 8080 --peer http://${MAC_HOST}:8080 --label Raspberry-Pi`;
  const macCmd =
    `python3 ${REMOTE_SCRIPT_MAC} ` +
    `--port 8080 --peer http://${PI_HOST}:8080 --label Mac-Mini`;

  const services = [
    { name: "pi-peer", serverId: piId, command: piCmd },
    { name: "mac-peer", serverId: macId, command: macCmd },
  ];

  const existing = (await getStacks(c)).find((s) => s.name === "Pi ↔ Mac peer demo");
  if (existing) {
    console.log(`[stack] reusing existing stack ${existing.id.slice(0, 8)} — replacing services`);
    const r = await fetch(`${BASE}/api/stacks/${existing.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(c),
      },
      body: JSON.stringify({
        name: "Pi ↔ Mac peer demo",
        description: "Two python HTTP servers that ping each other across the LAN.",
        services,
      }),
    });
    if (!r.ok) throw new Error(`PUT stack: HTTP ${r.status}: ${await r.text()}`);
    return existing.id;
  }

  const r = await fetch(`${BASE}/api/stacks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(c),
    },
    body: JSON.stringify({
      name: "Pi ↔ Mac peer demo",
      description: "Two python HTTP servers that ping each other across the LAN.",
      services,
    }),
  });
  if (!r.ok) throw new Error(`POST stack: HTTP ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { data: { id: string } };
  console.log(`[stack] created ${j.data.id.slice(0, 8)}`);
  return j.data.id;
}

async function stopAndLaunch(c: Cookies, stackId: string): Promise<void> {
  // Stop first so a re-run replaces any stale sessions cleanly.
  const stopRes = await fetch(`${BASE}/api/stacks/${stackId}/stop`, {
    method: "POST",
    headers: { Cookie: cookieHeader(c) },
  });
  if (stopRes.ok) {
    const sj = (await stopRes.json()) as { data: { stopped: number } };
    if (sj.data.stopped > 0) console.log(`[launch] stopped ${sj.data.stopped} existing session(s)`);
  }
  // Brief pause so the agent finishes releasing the port.
  await new Promise((r) => setTimeout(r, 1500));

  const launchRes = await fetch(`${BASE}/api/stacks/${stackId}/launch`, {
    method: "POST",
    headers: { Cookie: cookieHeader(c) },
  });
  const lj = (await launchRes.json()) as {
    data: {
      launched: Array<{ serviceId: string; sessionId: string; sessionName: string; serverId: string }>;
      failed: Array<{ serviceId: string; serverId: string; error: string }>;
    };
  };
  for (const ok of lj.data.launched) {
    console.log(
      `[launch] ✓ ${ok.sessionName} (${ok.sessionId.slice(0, 8)}) on server ${ok.serverId.slice(0, 8)}`
    );
  }
  for (const f of lj.data.failed) {
    console.log(`[launch] ✗ server ${f.serverId.slice(0, 8)}: ${f.error}`);
  }
}

async function main() {
  console.log("[1] uploading peer.py to Mac mini…");
  await uploadToMac();
  console.log(`    wrote ${REMOTE_SCRIPT_MAC}`);

  console.log("\n[2] dashboard login…");
  const c = await login();

  const servers = await getServers(c);
  const pi = servers.find((s) => s.host === PI_HOST);
  const mac = servers.find((s) => s.host === MAC_HOST);
  if (!pi || !mac) {
    throw new Error(`could not find both servers in /api/servers (pi=${!!pi}, mac=${!!mac})`);
  }
  console.log(`    pi=${pi.id.slice(0, 8)}  mac=${mac.id.slice(0, 8)}`);

  console.log("\n[3] creating/updating stack…");
  const stackId = await ensureStack(c, pi.id, mac.id);

  console.log("\n[4] launching stack…");
  await stopAndLaunch(c, stackId);

  console.log("\n[5] waiting 6s for servers to come up + first peer poll…");
  await new Promise((r) => setTimeout(r, 6000));

  // Probe the demo pages from the Pi side to confirm they're live.
  for (const [label, url] of [
    ["Pi", `http://${PI_HOST}:8080/health`],
    ["Mac", `http://${MAC_HOST}:8080/health`],
  ] as const) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = (await r.json()) as { label: string; hostname: string; uptime_s: number };
        console.log(`    ${label} OK  → label=${j.label} host=${j.hostname} uptime=${j.uptime_s}s`);
      } else {
        console.log(`    ${label} FAIL HTTP ${r.status}`);
      }
    } catch (e) {
      console.log(`    ${label} FAIL ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(
    "\nopen the dashboard:   http://192.168.100.82:3000/stacks  (look for 'Pi ↔ Mac peer demo')"
  );
  console.log(
    `open the demo pages:  http://${PI_HOST}:8080/   and   http://${MAC_HOST}:8080/`
  );
  console.log(
    `tail logs:            managet attach pi-peer    (or mac-peer via Mac terminal)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
