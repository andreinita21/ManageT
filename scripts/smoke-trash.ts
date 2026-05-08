/**
 * Quick smoke for the stack trash:
 *   1. List active stacks
 *   2. Soft-delete one (the demo stack), verify it leaves the active
 *      list and shows up under ?trashed=1.
 *   3. Restore it, verify it's back in the active list.
 *   4. List trashed afterwards: should be empty (assuming nothing else
 *      was already in the trash).
 *
 *   npx tsx scripts/smoke-trash.ts
 */
const BASE = "http://localhost:3000";
const ADMIN_EMAIL = "andrei@test.com";
const ADMIN_PASSWORD = "2006";

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
  return c;
}

interface Stack { id: string; name: string; deletedAt?: number }

async function listActive(c: Cookies): Promise<Stack[]> {
  const r = await fetch(`${BASE}/api/stacks`, { headers: { Cookie: cookieHeader(c) } });
  return ((await r.json()) as { data: Stack[] }).data;
}
async function listTrash(c: Cookies): Promise<Stack[]> {
  const r = await fetch(`${BASE}/api/stacks?trashed=1`, { headers: { Cookie: cookieHeader(c) } });
  return ((await r.json()) as { data: Stack[] }).data;
}

async function main() {
  const c = await login();

  const before = await listActive(c);
  if (before.length === 0) {
    throw new Error("no active stacks to test against — run setup-peer-demo first");
  }
  const target = before[0];
  console.log(`[smoke] target stack: ${target.name} (${target.id.slice(0, 8)})`);

  console.log("[smoke] soft-delete...");
  const delRes = await fetch(`${BASE}/api/stacks/${target.id}`, {
    method: "DELETE",
    headers: { Cookie: cookieHeader(c) },
  });
  if (!delRes.ok) throw new Error(`delete failed HTTP ${delRes.status}`);
  const delBody = (await delRes.json()) as { force: boolean };
  if (delBody.force) throw new Error("expected soft-delete (force=false)");

  const activeAfter = await listActive(c);
  if (activeAfter.find((s) => s.id === target.id)) {
    throw new Error("FAIL — still in active list after soft delete");
  }
  console.log(`[smoke] active count went ${before.length} → ${activeAfter.length} ✓`);

  const trashAfter = await listTrash(c);
  const trashed = trashAfter.find((s) => s.id === target.id);
  if (!trashed) throw new Error("FAIL — not in trashed list");
  if (!trashed.deletedAt) throw new Error("FAIL — deletedAt missing");
  console.log(`[smoke] now in trash, deletedAt=${new Date(trashed.deletedAt).toISOString()} ✓`);

  console.log("[smoke] restore...");
  const restoreRes = await fetch(`${BASE}/api/stacks/${target.id}/restore`, {
    method: "POST",
    headers: { Cookie: cookieHeader(c) },
  });
  if (!restoreRes.ok) throw new Error(`restore failed HTTP ${restoreRes.status}`);

  const activeFinal = await listActive(c);
  if (!activeFinal.find((s) => s.id === target.id)) {
    throw new Error("FAIL — not back in active list after restore");
  }
  const trashFinal = await listTrash(c);
  if (trashFinal.find((s) => s.id === target.id)) {
    throw new Error("FAIL — still in trash after restore");
  }
  console.log(`[smoke] restored, active=${activeFinal.length}, trash=${trashFinal.length} ✓`);

  console.log("\n\x1b[1;32m✓ trash smoke passed\x1b[0m");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
