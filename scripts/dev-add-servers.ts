/**
 * Dev helper: log in via NextAuth and POST the two LAN test servers
 * (192.168.100.82 + 192.168.100.95). Triggers the SSH-push agent install
 * and polls each server until it reaches `agent_status === 'healthy'` or
 * fails.
 *
 * Usage:
 *   MANAGET_DEV_PASSWORD='2006' npx tsx scripts/dev-add-servers.ts
 */
const BASE = process.env.MANAGET_BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = "admin@managet.local";
const ADMIN_PASSWORD = "admin";
const DEV_PASSWORD = process.env.MANAGET_DEV_PASSWORD;
if (!DEV_PASSWORD) {
  console.error("MANAGET_DEV_PASSWORD must be set");
  process.exit(2);
}

interface Cookies {
  jar: Map<string, string>;
}

function cookieHeader(c: Cookies): string {
  return Array.from(c.jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function ingestSetCookie(c: Cookies, headers: Headers): void {
  // Node fetch returns multiple Set-Cookie via getSetCookie() on newer
  // runtimes; fall back to .get for compat.
  const all =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : ([headers.get("set-cookie")].filter(Boolean) as string[]);
  for (const sc of all) {
    const [pair] = sc.split(";");
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1);
    c.jar.set(name, value);
  }
}

async function login(): Promise<Cookies> {
  const c: Cookies = { jar: new Map() };

  // 1. CSRF
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  ingestSetCookie(c, csrfRes.headers);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  // 2. Credentials sign-in (form-urlencoded as required by next-auth credentials)
  const body = new URLSearchParams({
    csrfToken,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    callbackUrl: `${BASE}/dashboard`,
    json: "true",
  });
  const signInRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(c),
    },
    body,
    redirect: "manual",
  });
  ingestSetCookie(c, signInRes.headers);

  // Verify
  const sessionRes = await fetch(`${BASE}/api/auth/session`, {
    headers: { Cookie: cookieHeader(c) },
  });
  const session = (await sessionRes.json()) as { user?: { email?: string } };
  if (!session?.user?.email) {
    throw new Error(
      `login failed (no session). HTTP ${signInRes.status}, body=${await signInRes.text().catch(() => "")}`
    );
  }
  console.log(`[login] signed in as ${session.user.email}`);
  return c;
}

async function listServers(c: Cookies) {
  const res = await fetch(`${BASE}/api/servers`, {
    headers: { Cookie: cookieHeader(c) },
  });
  const j = (await res.json()) as { data?: Array<{ id: string; name: string; host: string; agentStatus: string; agentInstallStage?: string; agentInstallError?: string }> };
  return j.data ?? [];
}

async function createServer(
  c: Cookies,
  payload: { name: string; host: string; username: string; password: string }
) {
  const res = await fetch(`${BASE}/api/servers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader(c),
    },
    body: JSON.stringify({
      name: payload.name,
      host: payload.host,
      port: 22,
      username: payload.username,
      authMethod: "password",
      password: payload.password,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createServer ${payload.name} failed: HTTP ${res.status}: ${text}`);
  }
  const j = (await res.json()) as { data: { id: string; name: string } };
  console.log(`[create] ${payload.name} → id=${j.data.id.slice(0, 8)}`);
  return j.data.id;
}

async function pollUntilHealthy(c: Cookies, serverId: string, timeoutMs = 600_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/api/servers/${serverId}`, {
      headers: { Cookie: cookieHeader(c) },
    });
    const j = (await res.json()) as { data?: { agentStatus: string; agentInstallStage?: string; agentInstallError?: string } };
    const data = j.data;
    if (!data) {
      console.log(`[poll ${serverId.slice(0, 8)}] (no data yet)`);
    } else {
      const line = `${data.agentStatus} ${data.agentInstallStage ? `(${data.agentInstallStage})` : ""}`;
      if (line !== last) {
        console.log(`[poll ${serverId.slice(0, 8)}] ${line}`);
        last = line;
      }
      if (data.agentStatus === "healthy") return "healthy";
      if (data.agentStatus === "install_failed") {
        throw new Error(`install failed: ${data.agentInstallError ?? "(no error)"}`);
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function main() {
  const c = await login();
  const existing = await listServers(c);
  if (existing.length > 0) {
    console.log(`[main] ${existing.length} server(s) already in DB:`);
    for (const s of existing) {
      console.log(`  - ${s.name} (${s.host}) → ${s.agentStatus}`);
    }
    console.log(
      "[main] not adding duplicates. Re-run after `rm data/managet.db && npx tsx scripts/seed.ts` if you want a clean install."
    );
    return;
  }

  const targets = [
    {
      name: "markI (Pi)",
      host: "192.168.100.82",
      username: "andrei",
      password: DEV_PASSWORD!,
    },
    {
      name: "Mac mini",
      host: "192.168.100.95",
      username: "andrei",
      password: DEV_PASSWORD!,
    },
  ];

  for (const t of targets) {
    const id = await createServer(c, t);
    try {
      await pollUntilHealthy(c, id);
      console.log(`[main] ${t.name} healthy ✓`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[main] ${t.name} did not become healthy: ${msg}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
