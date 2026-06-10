/**
 * Trigger an install-retry on the Mac mini (192.168.100.95). Used after
 * fixing agent source code so the dashboard rebuilds + redeploys.
 *
 *   MANAGET_ADMIN_PASSWORD='…' npx tsx scripts/dev-retry-mac.ts
 */
import { adminPassword } from "./_creds.js";

const BASE = "http://localhost:3000";

interface Cookies { jar: Map<string, string> }
function cookieHeader(c: Cookies): string {
  return Array.from(c.jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}
function ingest(c: Cookies, headers: Headers): void {
  const all = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : ([headers.get("set-cookie")].filter(Boolean) as string[]);
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
  const body = new URLSearchParams({
    csrfToken,
    email: "admin@managet.local",
    password: adminPassword(),
    callbackUrl: `${BASE}/dashboard`,
    json: "true",
  });
  const r = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader(c) },
    body,
    redirect: "manual",
  });
  ingest(c, r.headers);
  return c;
}

async function main() {
  const c = await login();
  const list = (await (await fetch(`${BASE}/api/servers`, { headers: { Cookie: cookieHeader(c) } })).json()) as { data?: { id: string; name: string; host: string }[] };
  const mac = list.data?.find((s) => s.host === "192.168.100.95");
  if (!mac) {
    console.error("Mac mini not found in /api/servers");
    process.exit(1);
  }
  console.log(`[retry] triggering install-retry for ${mac.name} (${mac.id.slice(0, 8)})`);
  const r = await fetch(`${BASE}/api/servers/${mac.id}/agent/install-retry`, {
    method: "POST",
    headers: { Cookie: cookieHeader(c) },
  });
  console.log(`[retry] HTTP ${r.status}`);

  // Poll
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 900_000) {
    const j = (await (await fetch(`${BASE}/api/servers/${mac.id}`, { headers: { Cookie: cookieHeader(c) } })).json()) as { data?: { agentStatus: string; agentInstallStage?: string; agentInstallError?: string } };
    if (j.data) {
      const line = `${j.data.agentStatus} ${j.data.agentInstallStage ? `(${j.data.agentInstallStage})` : ""}`;
      if (line !== last) {
        console.log(`[poll] ${line}`);
        last = line;
      }
      if (j.data.agentStatus === "healthy") return;
      if (j.data.agentStatus === "install_failed") {
        console.error(`[poll] failed: ${j.data.agentInstallError}`);
        process.exit(1);
      }
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.error("[poll] timed out");
  process.exit(1);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
