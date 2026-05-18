# Project Review

_Reviewer: senior engineer pass. Scope: full repo at HEAD (branch `main`, uncommitted edits to `agent/`, `src/app/(dashboard)/stacks/*`, `src/lib/stacks/index.ts`, etc.). Project is self-described as in dev phase; some findings are scoped accordingly._

## 1. Executive Summary

ManageT is a self-hosted dashboard for a small fleet of SSH-accessible servers. The architecture is broadly sound: PTYs and metric collection live in a per-host Rust agent, the Next.js dashboard is a thin coordinator over SSH + bearer-token agent callbacks, and SQLite stores configuration. The agent-as-source-of-truth design is the right call and is mostly implemented cleanly.

The biggest risks are not architectural but **security and data-integrity**:

- The **WebSocket layer is effectively unauthenticated** — `extractUserId()` in `src/lib/ws/index.ts:365` reads the raw cookie value (or `?token=…` query parameter) and stores it without ever verifying that it's a valid NextAuth session. Any HTTP client with any non-empty cookie can open the upgrade, then create/attach/kill PTY sessions on any managed server.
- The **`sessions.stack_id` foreign key was added in migration 0002 without `ON DELETE SET NULL`**, contradicting both the schema declaration and the documented soft-delete/force-delete contract.
- The **metric pruner uses `MIN(id)` on UUID-v4 text columns** (`src/lib/monitor/pruner.ts:77`), so retention buckets keep an essentially random sample, not the earliest.
- The **heartbeat endpoint will update per-session stats without verifying that the session belongs to the authenticating server** (`src/app/api/agent/heartbeat/route.ts:141`).
- **Role-based authorization is unimplemented**: every authenticated user is treated as admin even though the schema declares an enum.

Code quality is generally good — types are tight, comments explain non-obvious decisions, and the agent's session model is well-thought-through. The main maintainability drag is `scripts/` (36 ad-hoc operational scripts, most one-shot, none under test) and the 1,160-line `stacks/page.tsx`.

**Overall recommendation**: ship-worthy for single-admin dev/LAN use as advertised, but the WS auth bypass and the FK action mismatch must be fixed before the product is exposed to any untrusted network or multi-user environment.

## 2. Project Structure

```
managet/
├── server.ts                # Custom Next.js server: HTTP + WS upgrade
├── src/
│   ├── app/                 # Next.js App Router (routes + UI pages)
│   │   ├── (dashboard)/     # Authenticated app shell
│   │   ├── (terminal)/      # Standalone /terminal route
│   │   └── api/             # REST + agent endpoints
│   ├── components/          # UI primitives + feature widgets
│   ├── lib/
│   │   ├── agent/           # SSH-push install/uninstall, status monitor
│   │   ├── ssh/             # connection pool, exec, agent socket helper
│   │   ├── monitor/         # alert engine, pruner, snapshot bus
│   │   ├── restart/         # command classifier (only tested module)
│   │   ├── stacks/          # stack CRUD + launch fan-out
│   │   ├── db/              # Drizzle schema + connection
│   │   └── ws/              # WebSocket handler (one giant file)
│   └── types/               # Shared TS interfaces
├── agent/                   # Rust agent crate (lib + 2 bins)
├── drizzle/                 # Migration SQL + journal
├── scripts/                 # 36 one-off operational scripts
└── data/                    # SQLite DB + cached agent binaries (gitignored)
```

The split between `app/api/*` (HTTP), `lib/agent/*` (install orchestration), `lib/ssh/*` (transport), `lib/monitor/*` (heartbeat-derived alerts), and the Rust agent (PTY + metrics) is sensible. Concerns:

- **`scripts/`** has grown into a graveyard of debugging scripts (`fix-auth-trust-host.ts`, `inspect-pi-runtime.ts`, `setup-peer-demo.ts`, `smoke-keepalive.ts`, `migrate-pi-resume.ts`, etc.). They are excluded from typecheck (`tsconfig.json:34`) and lint, hardcode server UUIDs, and decrypt production passwords. Most are dead. They should be moved out of the repo or into a `scripts/devtools/` folder with a README explaining what's still alive.
- **`src/lib/ws/index.ts`** (434 lines) mixes WS lifecycle, browser protocol, and the broken auth layer in one file. Splitting auth into its own module would have caught the bypass.
- **`src/app/(dashboard)/stacks/page.tsx`** is 1,160 lines containing the page, the editor modal, the active-stacks table, the runtime grid, and the bottom-split terminal. Splitting these into separate files would dramatically improve readability.

Otherwise the layout is clear and scales adequately.

## 3. Critical Issues

### C1. WebSocket authentication is bypassable
- **File**: `src/lib/ws/index.ts:365-435`
- **Problem**: `extractUserId(req)` returns the raw cookie value (`authjs.session-token`, `next-auth.session-token`, or `__Secure-authjs.session-token`) or the `?token=` query-string value — without verifying it's a valid signed session. `handleUpgrade()` only checks that the returned string is non-empty. The stored value is never used for authorization either; it just gates the upgrade.
- **Why it matters**: any HTTP client that supplies `Cookie: authjs.session-token=anything` can open a WS, then issue `{type:"session:attach", sessionId, serverId}` for any session, attach to PTYs running as root on every managed host, type into them, read their output, or kill them. This completely defeats the dashboard's authentication.
- **Suggested fix**: actually validate the cookie. NextAuth v5 provides server-side token decoding via `auth()` against the request, or you can use `getToken({ req, secret })` from `next-auth/jwt`. Reject when no valid session decodes. Optionally also require the WS message handlers to re-check authorization for each `serverId`.

```ts
// in extractUserId — sketch
import { getToken } from "next-auth/jwt";
const token = await getToken({
  req: req as unknown as NextRequest,
  secret: process.env.AUTH_SECRET,
});
return token?.id as string | null;
```

### C2. `sessions.stack_id` foreign key has the wrong ON DELETE action
- **Files**: `drizzle/0002_awesome_jackpot.sql:1`, `src/lib/db/schema.ts:102`
- **Problem**: Migration 0002 adds the column with bare `REFERENCES stacks(id)` (default = NO ACTION). The schema in `schema.ts:102` declares `{ onDelete: "set null" }`. SQLite doesn't recreate FK actions on `ALTER TABLE ADD COLUMN`. I verified this against the live DB:
  ```sql
  -- live sqlite_master for sessions:
  `stack_id` text REFERENCES stacks(id)        -- no ON DELETE
  ```
- **Why it matters**:
  - The `DELETE /api/stacks/[id]?force=true` route docstring promises "FK on `sessions.stackId` is `ON DELETE SET NULL` so launched sessions keep running but lose their stack link" — that is not what the database does. With foreign_keys enabled by better-sqlite3 (which is the default), a force-delete on a stack with any linked session will raise `FOREIGN KEY constraint failed` and roll back the row delete.
  - The soft-delete path works fine; the bug only triggers on force-delete with active sessions, but the contract is silently violated.
- **Suggested fix**: add a migration that rebuilds the table (SQLite-style: create new table with correct FK, copy rows, drop, rename). For example:

```sql
PRAGMA foreign_keys=OFF;
CREATE TABLE sessions_new ( …same columns…,
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE cascade,
  FOREIGN KEY (stack_id)  REFERENCES stacks(id)  ON DELETE SET NULL
);
INSERT INTO sessions_new SELECT * FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
PRAGMA foreign_keys=ON;
```

### C3. Heartbeat updates session stats without verifying session ownership
- **File**: `src/app/api/agent/heartbeat/route.ts:140-151`
- **Problem**: After authenticating the agent against `servers.agent_token_hash`, the route loops through `snap.sessions` and writes CPU/RAM/`statsUpdatedAt` keyed only by `sessions.id` — never confirming that the session row's `serverId` matches the authenticated server.
- **Why it matters**: a compromised or malicious agent token can stamp arbitrary stats onto sessions belonging to other servers. The blast radius is limited to UI noise today, but it's still a cross-tenant write and violates the agent isolation model the rest of the code is careful about. It will become a real problem the moment session stats grow new meaningful columns (e.g. ownership, restart triggers).
- **Suggested fix**:

```ts
await db.update(sessions)
  .set({ cpuPercent: s.cpuPercent, memoryMb: s.memoryMb, statsUpdatedAt: now })
  .where(and(eq(sessions.id, s.sessionId), eq(sessions.serverId, server.id)));
```

### C4. Metric pruner picks an arbitrary survivor per time bucket
- **File**: `src/lib/monitor/pruner.ts:73-84`
- **Problem**: The retain-one-per-bucket strategy is `SELECT MIN(id) … GROUP BY server_id, (captured_at / bucketMs)`. `id` is a UUID-v4 text string (`uuid()` from `uuid@13`). `MIN()` on text uses lexicographic order, so the "earliest inserted" row in a bucket is essentially random.
- **Why it matters**: down-sampled charts and dashboards will show a random sample within each minute/15-minute bucket rather than the consistent oldest-or-newest one. Time-series visualisations look noisier and oldest-vs-current comparisons are inconsistent.
- **Suggested fix**: pick on `captured_at` or `rowid`:

```sql
DELETE FROM metric_snapshots
WHERE captured_at >= ? AND captured_at < ?
  AND rowid NOT IN (
    SELECT MIN(rowid) FROM metric_snapshots
    WHERE captured_at >= ? AND captured_at < ?
    GROUP BY server_id, (captured_at / ?)
  );
```

### C5. Role-based authorization is unimplemented
- **Files**: `src/lib/db/schema.ts:11-13`, every API route under `src/app/api/`
- **Problem**: The `users.role` enum (`admin | operator | viewer`) is defined and surfaced into the session, but no route checks it. `auth()` is the universal gate, and once a user is logged in they can install agents, delete servers, run shell commands, hard-delete stacks, change restart policies, etc.
- **Why it matters**: any "viewer" account is in practice an admin. Sharing read-only access requires implementing this.
- **Suggested fix**: introduce a small `requireRole(session, ['admin'])` helper and gate destructive routes on it. Even just refusing non-admins on `POST/PUT/DELETE` would close the gap.

### C6. Install state can be permanently orphaned on dashboard restart
- **File**: `src/app/api/servers/route.ts:99`, `src/lib/agent/status-monitor.ts:60-102`
- **Problem**: `installAgent()` is fired with `void installAgent(id).catch(...)` from the POST route. If the dashboard process dies mid-install (e.g. between "uploading binary" and the install command itself), the row stays in `agentStatus = 'installing'` forever. The status sweeper only catches `installing` rows with `agentInstallStage = 'awaiting first heartbeat'` (line 99 condition is strict equality on that exact string). Any other stage is invisible to the watchdog.
- **Why it matters**: in production the server row will sit stuck in "installing" with no UI affordance to reset, no auto-retry, and no error message.
- **Suggested fix**: broaden the watchdog to "any `installing` row whose `updatedAt` is older than N minutes" → flip to `install_failed` with a generic message, OR add a resume worker that re-fires `installAgent` for orphaned `installing` rows on `initMonitoring()`.

## 4. Potential Bugs and Edge Cases

- **`metric_snapshots` accumulates without a per-server retention floor**. Pruner only enforces global time-buckets; if a server vanishes, its old snapshots remain forever (`metric_snapshots.serverId` has `ON DELETE CASCADE`, so this only matters if a server stops heartbeating without being deleted). Low risk.
- **`installAgent()` stage `"awaiting first heartbeat"` race**: comments say it's safe because the heartbeat handler bumps `updatedAt` and resets `agentStatus` to `healthy`. Verified — that's correct.
- **`reconcileServer()` runs N+1 unbounded await inserts** (`src/lib/ssh/session-manager.ts:217-244`). If the agent reports a large session list, the dashboard issues sequential writes. No transaction wraps the loop, so a partial failure leaves the DB inconsistent.
- **`useFetch` ignores requests that resolve after unmount** (`src/lib/hooks/useApi.ts:43-70`). No abort controller; setState after unmount triggers React warnings on slow networks.
- **`TerminalPaneInner` only attempts one reconnect** (3 s delay, then gives up — `TerminalPaneInner.tsx:209-216`). A momentary WS drop forces a manual refresh even though the agent's PTY survives.
- **`exec.ts` accumulates stdout/stderr unbounded** (`src/lib/ssh/exec.ts:107-111`). A command that emits megabytes (a stuck `cat`, `journalctl --no-pager`, etc.) will OOM the dashboard. Either cap at a few MB or stream.
- **`/api/servers/[id]/exec` returns HTTP 501** for runtime exec errors (`src/app/api/servers/[id]/exec/route.ts:59`). Semantically wrong — 501 means "Not Implemented"; should be 502 or 500.
- **`POST /api/sessions/[id]/recover` always 501s** (`src/app/api/sessions/[id]/recover/route.ts:33`). UI shouldn't expose it until implemented; if it shouldn't be implemented at all, delete the route.
- **`DELETE /api/stacks/[id]` returns `ok:true` even when the id doesn't exist** (`src/app/api/stacks/[id]/route.ts:108-118`). No 404 check on the existence path.
- **`launchStack` race when launched twice concurrently**: nothing prevents two clients from both clicking Launch. `Promise.allSettled` will fire two creates per service, leaving duplicates with the same `(stackId, serverId, sessionName)`. The runtime view's "freshest wins" tie-breaker hides this in the UI but the orphaned session keeps running.
- **`buildLocks` in installer is per-target keyed but global across the process** (`src/lib/agent/installer.ts:65`). If two installs of the *same* target start, only one builds — good. But if the build crashes the runtime entirely, the in-flight promise is leaked.
- **`stopStack` doesn't update the row's `updatedAt`** — purely cosmetic, but the stacks page sorts/refreshes based on no field; consider whether you want "last launched/stopped" tracking.
- **`status` column on `servers` is being maintained in lockstep with `agentStatus`** (`status-monitor.ts:71`). Two columns saying the same thing is duplication that will rot. Pick one.
- **`agent/src/sessions/server.rs:51`** removes a stale socket file before bind. If two agent processes start concurrently (e.g. systemd `Restart=on-failure` triggers while a manual `managet-agent run` is also running), the second nukes the first's socket. Mode 0666 + no peer-credential check compounds the issue.
- **Rust agent `default_shell()` falls back to `/bin/sh`** for stack services. If users author commands assuming bash (`[[ ]]`, arrays), they'll silently break on dash systems.
- **`shellEscape` in `installer.ts:378`** is correct, but the SSH-push installer passes the bearer token via `--token <SHELL_ESCAPED>` — so the token is visible in `ps`/`/proc/<pid>/cmdline` on the remote box for the ~30–60 s the install runs. The same is true for the `curl` connectivity probe (`installer.ts:255-258`). Comment acknowledges it; consider piping the token over stdin to a `managet-agent install --token-stdin` flag instead.

## 5. Code Quality Issues

- **Hand-rolled `rowTo<X>` repetition**: `src/app/api/sessions/route.ts:12-26`, `…/sessions/[id]/route.ts:23-37`, and `src/lib/ssh/session-manager.ts:263-277` each redefine the same `rowToSession`. Move to `src/lib/db/transform.ts` next to `rowToServer`.
- **Stringly-typed `restartPolicy`/`status` casts** all over: `r.status as Session["status"]`. The schema already constrains the enum, but Drizzle widens it to `string`. Either narrow once in `transform.ts` or wire `$inferSelect` types through Zod.
- **`role` cast `(user as { role?: string }).role`** in `src/lib/auth/index.ts:84` — write a NextAuth module augmentation instead of casting at every callsite.
- **`stacks/page.tsx` mega-file** (1,160 lines). Split: `<StackEditor>`, `<ActiveStacksTable>`, `<StackDetailGrid>`, `<BottomTerminalSplit>` each in their own file.
- **Inconsistent error surfacing**: some routes return `{ error: msg }`, some return `{ data: …, error }`, some go status-only. Pick a contract.
- **`@/lib/hooks/useApi.ts`** mixes `useXxx` hooks with bare `async function xxx` mutators. Conventional split: one file of hooks, one file of API helpers.
- **`scripts/`** files all duplicate the same `if (existsSync(".env.local"))` env-loader at the top. Factor into a single helper.
- **Drizzle imports**: most routes import `{ eq }` from `drizzle-orm` but the codebase uses `and`/`or`/`gte`/`lte`/`isNull`/`isNotNull` inconsistently. Tidy on a pass.
- **Login page uses inline styles** (`src/app/login/page.tsx`) while the rest of the app uses Tailwind. Convert for consistency.
- **`src/app/api/agent/binary/[target]/route.ts:18`** imports `readFileSync` but only uses it for the `.sha256` file; OK, but consider using `fs/promises` to match the rest of the file.
- **`src/lib/ws/index.ts:415`** still exports an "unused" `_SessionForAttach` type "for compatibility with old import sites". Per project memory the DB is wipeable in dev — delete it.
- **`agent/src/cli.rs:75`** uses `hide_env_values = true` for token (good) but the install_cmd in `src/lib/agent/installer.ts:204-209` still passes it as a CLI arg from the dashboard side, defeating the precaution.
- **`Cargo.toml` profile is set to `opt-level = "z"` + LTO**: appropriate for a small agent binary, just note that this slows release builds notably on first-install build-on-target (a Pi can take 8–12 minutes).
- **`scripts/seed.ts`** uses `execSync("npx drizzle-kit migrate")` instead of programmatically applying migrations. Adds a Node start-up dependency on the user's npm cache.

## 6. Architecture and Design Improvements

- **The agent-as-source-of-truth model is well-chosen**. PTY persistence across dashboard restart works correctly, and `reconcileServer` lazily catches drift. Keep it.
- **Single shared `connectionPool` singleton** is convenient but ties every consumer to a process-wide map. Currently fine; if you ever multi-tenant the dashboard, you'll need per-tenant pooling.
- **The install flow does too much in one function** (`src/lib/agent/installer.ts:72-315` — `installAgent`). Steps 1–7 are sequential, hard to retry partial work, and the `setStage()` calls are noisy. Consider modelling as a state machine with persistable steps; the watchdog could resume from any step.
- **`AlertEngine` is a singleton** that stores thresholds in memory only. Thresholds aren't persisted, so changing them requires a code edit. Either persist or document that they're constants.
- **WebSocket message handler is a switch over untyped JSON.parse output**. Replace with a `zod` discriminated union shared with the browser. Catches incoming malformed messages and gives proper typing.
- **No abstraction for "agent control plane"**: `agentRequest` and `openAgentAttach` are co-located but the dashboard often needs cross-cutting concerns (timeouts, retries, mutual auth). A thin AgentClient class would let you add metrics, tracing, and per-host rate limits in one place.
- **`stacks` data flow does two queries (`/api/stacks` + `/api/stacks/runtime`)** that the UI then joins client-side. For larger fleets this duplicates work. Consider a single `/api/stacks?withRuntime=1` view.
- **PTY scrollback** lives in memory in the agent (`SCROLLBACK_BYTES = 64 KiB`). A long-running session that pumps lots of output before the user attaches loses the head. Documented in code, but consider exposing the size as config.
- **Pruner runs in-process** in the Next.js custom server. If you ever scale horizontally, two dashboards running both pruners race. Lock the table or move to a single worker.

## 7. Performance Improvements

- **`/api/metrics/latest`** reads the last 5 minutes of every server's metrics into memory, sorts in JS, and trims (`src/app/api/metrics/latest/route.ts:34-66`). At ~30 samples × N servers it's fine, but the lack of `ORDER BY captured_at` in SQL forces a full table scan inside the time window. Add a composite index `(server_id, captured_at)` on `metric_snapshots`.
- **`reconcileServer` does N sequential `INSERT`s in a `for` loop** (`session-manager.ts:217`). Wrap in `db.transaction(...)` and prepared statements, or use `INSERT … ON CONFLICT DO UPDATE`. Same in `replaceServicesForStack` (`src/lib/stacks/index.ts:35`).
- **Frontend polling**: `useStackRuntimes` polls every 10 s, `useLatestMetrics` every 10 s. Two parallel intervals per tab. Consider Server-Sent Events from the same heartbeat bus the alert engine subscribes to.
- **Rust collector** does two `refresh_processes(ProcessesToUpdate::All, true)` calls per heartbeat — that's a full pass over the proc table twice every 10 s. On a Pi with hundreds of processes this is non-trivial. Switch to refreshing only the PIDs in `session_pids` after the second pass.
- **`getAllStackRuntimes`** runs three queries and joins in memory. Fine; the comment notes "< 10 ms". Add a brief benchmark or convert to a single SQL query if you ever see thousands of stacks.
- **`exec.ts` unbounded buffer**: see C-section. This is a perf bug as well as a stability one.
- **`buildTarball()` writes to disk** even though callers only need the path. Caching on disk is fine, but `getAgentSourceTarball` could lazy-mtime-check the source dir and rebuild if the agent source changed since the last tarball — currently the only invalidator is process restart.

## 8. Security Review

Beyond the critical items in §3:

- **`MANAGET_ENCRYPTION_KEY` is required but never validated at startup** (`src/lib/crypto/index.ts:11-18`). If unset, `decryptPassword` throws on first SSH attempt — confusing. Add an explicit boot-time check in `initMonitoring()`.
- **Same encryption key encrypts both SSH password and sudo password** (they're the same blob). If the key is rotated, you must re-encrypt; there's no rotation tooling.
- **Bearer-token storage**: SHA-256 of a 32-byte random token. Fine. Don't change to HMAC unless you're worried about read-only DB leaks.
- **`agent/src/sessions/server.rs:60-62`** chmods the agent's Unix socket to 0666. Documented as acceptable ("anyone with shell access can sudo anyway") but a smarter design would check the peer UID via `SO_PEERCRED` and refuse non-root connections.
- **`/api/agent/binary/[target]/route.ts`** requires a NextAuth session, which is good — but `binaryExists` opens the path the user supplied (through the `isAgentTarget` allowlist, so safe). The route has no rate limit.
- **No CSRF tokens on state-changing API routes**. NextAuth's session cookie is `SameSite=Lax` by default, which mitigates most cross-site `POST`s, but not all (form posts can still target it). A double-submit token or `next-safe-action` would harden this.
- **`scripts/dev-ssh.ts` and friends** decrypt and use stored passwords from the live DB. They should never be checked in alongside production data.
- **Default credentials**: `admin@managet.local / admin` (see `scripts/seed.ts:14`). README warns. Consider forcing a password change on first sign-in.
- **TLS**: no built-in HTTPS. The README assumes a reverse proxy. `trustHost: true` in NextAuth (`src/lib/auth/index.ts:78`) means any `Host` header is accepted. Acceptable for LAN deployment but document the assumption clearly.
- **`labels` is stored as JSON-stringified text**: `JSON.parse(r.labels)` in `transform.ts:24` will throw on a malformed value. Today nothing writes garbage but a future migration or hand-edit could brick the row. Defend against parse errors.
- **`agentInstallError` text is freely written from `err.message`** which can include remote stderr including paths and tokens echoed by remote scripts. Sanitise before persisting or marking visible to the UI.

## 9. Testing Gaps

- **Only one module has tests**: `src/lib/restart/tests/{matcher,classify,preprocess,heuristics}.test.ts`. Everything else is untested in CI sense.
- **No tests for**:
  - `src/lib/crypto/index.ts` — encrypt/decrypt round-trip
  - `src/lib/auth/index.ts` — `verifyPassword` timing-safe behaviour, scrypt parameters
  - `src/lib/agent/token.ts` — token format
  - `src/lib/ssh/agent-socket.ts` — framing, JSON read across TCP segment boundaries
  - `src/lib/ws/index.ts` — auth check (would have caught C1)
  - `src/lib/stacks/index.ts` — launch fan-out, missing-only mode
  - API routes — Zod validation, 401 paths, 404 paths
  - Heartbeat ingestion — partial fields, malformed JSON, session-ownership check
  - Rust agent — only `agent/src/config.rs` has a `#[cfg(test)] mod tests`. No tests for `collector`, `sessions::manager`, or the installer.
- **No E2E tests** other than the Playwright smoke referenced in commit `ef911e8`. There's no checked-in `playwright.config.ts` or `e2e/` dir.
- **No CI configuration committed** (no `.github/workflows/`, `.gitlab-ci.yml`, etc.). Tests, if they exist, aren't running on push.
- **Recommended minimum next**:
  1. Vitest for `crypto`, `auth`, `agent/token`, `ws/extractUserId` (after fixing).
  2. Mock-DB integration tests for the heartbeat route asserting the C3 fix.
  3. A Playwright happy-path: log in → add server → wait for healthy → create stack → launch → stop.
  4. `cargo test` on the agent in CI.

## 10. Dependency and Configuration Review

- **`package.json`** declares `next: 16.2.3`, `react: 19.2.4`, `next-auth: 5.0.0-beta.30`, `zod: 4.3.6`. Pinning a beta for next-auth in a security-sensitive surface is risky; pin a known-good 5.0.0 release as soon as it lands.
- **`uuid@13`** is fine but you only use `v4`; consider `crypto.randomUUID()` and drop the dep.
- **`xterm@5.3.0`** is CJS-only — the comment in `TerminalPaneInner.tsx:6` notes the pain. Migrate to `@xterm/xterm@5.5+` (the renamed ESM-friendly successor) and the `@xterm/addon-*` packages.
- **`playwright@1.59.1`** is a dev-dep but no test runner config exists. Either commit the config or remove the dep.
- **`drizzle-kit@0.31.10`** + `drizzle-orm@0.45.2` — fine, modern.
- **`better-sqlite3@12.8.0`** + `@types/better-sqlite3@7.6.13` — version mismatch in major-version line. Probably fine because the API hasn't changed much, but worth aligning types to the runtime version.
- **`Cargo.toml`** is healthy. `opt-level = "z"` + LTO trades build time for binary size; for on-target compile it's slow. Consider providing a `[profile.release-fast]` for build-on-target paths.
- **`drizzle.config.ts`** points to `file:./data/managet.db` by default; works for dev. No env-var awareness for production paths.
- **`next.config.ts`** marks `ssh2` and `better-sqlite3` as `serverExternalPackages` — correct.
- **`.gitignore`** correctly excludes `/data/`, `.env*`, `agent/target/`, `.next/`. Looks good.
- **`tsconfig.json`** excludes `scripts` and `agent` — appropriate, since `scripts` are ad-hoc and `agent` is Rust. Confirm the IDE/Lint scope matches.
- **No `.eslintignore`**: eslint config uses `globalIgnores`; OK.

## 11. Recommended Improvements

### High Priority
1. **Fix the WebSocket auth bypass** (C1). This is the single highest-impact fix.
2. **Patch the `sessions.stack_id` ON DELETE action via a new migration** (C2).
3. **Verify session ownership in `/api/agent/heartbeat`** (C3).
4. **Fix `MIN(id)` → `MIN(rowid)` or `MIN(captured_at)` in the pruner** (C4).
5. **Bound `exec.ts` output buffering** to prevent OOM on chatty commands.
6. **Add a startup check** that fails fast when `MANAGET_ENCRYPTION_KEY` is missing or malformed.
7. **Broaden the install watchdog** so any stuck `installing` row gets flipped to `install_failed` after N minutes, not only the `awaiting first heartbeat` stage.

### Medium Priority
1. **Enforce roles** on destructive routes; minimum `admin`-only on `POST/PUT/DELETE`.
2. **Replace UUID-text `MIN()` patterns** elsewhere if any (audit).
3. **Move install token from `--token` argv to stdin** in the agent installer (and update `installer.ts:204-209`).
4. **Split `stacks/page.tsx`** into ≤ 300-line files.
5. **Add session-aware `reconcileServer` transaction** and prepared inserts.
6. **Add a Vitest config + tests** for crypto/auth/token modules.
7. **Replace bespoke `rowTo*` duplications** with a single transform module.
8. **Switch xterm to the maintained `@xterm/*` packages.**
9. **Add `(server_id, captured_at)` composite index** on `metric_snapshots`.
10. **Add `next-auth/jwt` `getToken()` to WS handler** even after C1 fix, to also verify roles per message.
11. **Document MANAGET_DASHBOARD_URL/PORT/AUTH_SECRET clearly** in README; today some env vars are only mentioned in code comments.

### Low Priority
1. **Tidy `scripts/`** — move debugging scripts to a `scripts/dev/` subdirectory with a README; delete the obviously stale ones (`fix-pi-unit-and-retest.ts`, `finish-agent-reconfig.ts`, `setup-peer-demo.ts`).
2. **Replace `uuid` package with `crypto.randomUUID()`**.
3. **Convert login page to Tailwind** for consistency.
4. **Remove `_SessionForAttach` legacy export** in `ws/index.ts`.
5. **Reduce Rust collector's process refresh cost** by targeting the session PID set on the second refresh pass.
6. **Add Playwright config + check-in the smoke test** referenced in `ef911e8`.
7. **Add lint rule to forbid `as Session["status"]`** style casts in favour of typed mappers.
8. **Consider WebSocket reconnection logic** with exponential backoff in `TerminalPaneInner`.

## 12. Suggested Refactoring Plan

A pragmatic order that doesn't break the system mid-step:

1. **Land a Vitest setup** with one passing test for `verifyPassword`. Wire it into CI (even a single GitHub Action). This gives you a safety net for the rest.
2. **Fix C1 (WS auth)**. Land tests for the auth-extractor. Roll out behind a feature flag if you have multiple deployments to migrate.
3. **Fix C3 (heartbeat ownership check)**. Add a regression test that posts a heartbeat for `serverA` with a `sessionId` belonging to `serverB` and asserts the row is unchanged.
4. **Write migration 0005** to rebuild `sessions` with the correct `ON DELETE SET NULL` (C2). Test on a copy of the dev DB before shipping.
5. **Patch the pruner** (C4). Backfill is not needed — the change only affects future prunes.
6. **Bound `exec.ts` output**, then write a test that feeds 5 MB of stdout and asserts a clean error.
7. **Introduce a `requireRole` helper** and gate destructive routes. Decide explicitly whether `operator` can launch stacks but not delete servers.
8. **Refactor `stacks/page.tsx` into separate components** without changing behaviour. Keep PR-by-PR.
9. **Switch the WS protocol to a zod schema** and remove the giant `switch`.
10. **Migrate xterm packages** in a single PR.
11. **Clean up `scripts/`**.

Each step is independently shippable.

## 13. Final Verdict

The architecture is good and the code reads well. The Rust agent does its job, the heartbeat/agent-token model is the right primitive, and the soft-delete UX for stacks is thoughtful. What's missing is **defense-in-depth on the dashboard's web surface**: the WS layer assumes a friendly LAN and a single admin, while the rest of the system has clearly been designed for more than that. With the four critical fixes (§3) the product is in good shape for trusted-LAN deployment by a single admin. With also the medium-priority items it can be safely shared across a small team.

The biggest stylistic debt — `scripts/`, the 1,160-line stacks page, and the lack of tests — is solvable incrementally without re-architecting anything. Prioritise C1–C4 first, then chip away at the medium-priority list in CI-protected refactors.
