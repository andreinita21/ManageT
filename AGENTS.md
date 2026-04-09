# ManageT — Multi-Agent Development Prompt

## How to use this with Claude Code

This file is the master blueprint for building ManageT with multiple Claude Code agents running in parallel. Here's how to set it up:

### Setup

1. Create the project directory and place this file at the root:
   ```bash
   mkdir managet && cd managet
   cp /path/to/this-file.md AGENTS.md
   ```

2. Add this file as a project instruction so every Claude Code session reads it automatically. Create a `.claude/` directory with a `CLAUDE.md` file:
   ```bash
   mkdir -p .claude
   echo 'Read AGENTS.md at the project root before starting any work. It contains the full system design, shared type contracts, and your agent assignment. Identify which agent you are from the task I give you, then follow ONLY your agent section step-by-step. Do not modify files outside your ownership domain.' > .claude/CLAUDE.md
   ```

3. Initialize git so agents don't collide:
   ```bash
   git init && git add -A && git commit -m "init"
   ```

### Running the agents

**Agent 1 runs first** (it bootstraps the project and creates placeholder files that others depend on):

```bash
# Terminal 1 — Agent 1
claude-code "You are AGENT 1 — Database + Auth + API skeleton. Read AGENTS.md and execute every step in your section. Start by initializing the Next.js project and installing all dependencies."
```

Wait for Agent 1 to finish and commit its work:
```bash
git add -A && git commit -m "agent-1: project foundation"
```

**Then launch Agents 2–5 in parallel**, each in its own terminal and its own git branch:

```bash
# Terminal 2 — Agent 2
git checkout -b agent-2-ssh
claude-code "You are AGENT 2 — SSH agent + WebSocket server + Session management. Read AGENTS.md and execute every step in your section."

# Terminal 3 — Agent 3
git checkout -b agent-3-restart
claude-code "You are AGENT 3 — Restartable command system. Read AGENTS.md and execute every step in your section."

# Terminal 4 — Agent 4
git checkout -b agent-4-monitoring
claude-code "You are AGENT 4 — Monitoring engine. Read AGENTS.md and execute every step in your section."

# Terminal 5 — Agent 5
git checkout -b agent-5-frontend
claude-code "You are AGENT 5 — Frontend UI. Read AGENTS.md and execute every step in your section."
```

**After all agents finish**, merge everything:
```bash
git checkout main
git merge agent-2-ssh
git merge agent-3-restart
git merge agent-4-monitoring
git merge agent-5-frontend
```

Merges should be clean since each agent owns different files. If there are conflicts in shared files (package.json, etc.), resolve by keeping all additions.

### Verification after merge

```bash
npm install          # Ensure all deps are installed
npm run build        # TypeScript compilation check
npx drizzle-kit migrate  # Apply DB schema
node server.ts       # Start the app
```

---

## Project overview

ManageT is a self-hosted web application for managing terminal sessions, monitoring, and processes across multiple remote servers from a single browser-based dashboard. It wraps every remote session in tmux transparently, tracks working directories in real-time, and can automatically recover and re-execute processes after SSH disconnections using a three-tier command safety classification system.

**Tech stack:** Next.js 15 (app router), TypeScript, xterm.js, ws (WebSocket), ssh2, Drizzle ORM + SQLite (MVP), NextAuth.js v5, Tailwind CSS 4, zod.

**Repository structure:**

```
managet/
├── src/
│   ├── app/                      # Next.js app router
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── api/
│   │   │   ├── servers/          # CRUD + metrics
│   │   │   ├── sessions/         # Session management + recovery
│   │   │   ├── restart-policies/ # Restart rule CRUD + test endpoint
│   │   │   └── auth/             # NextAuth routes
│   │   ├── (dashboard)/          # Dashboard, server list, settings
│   │   └── (terminal)/           # Terminal view with panes
│   ├── components/
│   │   ├── terminal/             # TerminalPane, RecoveryBanner, CommandRunner
│   │   ├── dashboard/            # ServerCard, MetricSparkline, AlertBadge
│   │   └── ui/                   # Shared primitives (shadcn/ui)
│   ├── lib/
│   │   ├── ssh/                  # ConnectionPool, SessionManager, CwdTracker
│   │   ├── restart/              # Classification pipeline, pattern matcher, heuristics
│   │   ├── monitor/              # MetricCollector, LogStreamer, AlertEngine
│   │   ├── db/                   # Drizzle schema, migrations, queries
│   │   ├── ws/                   # WebSocket server, protocol, handlers
│   │   ├── auth/                 # NextAuth config
│   │   └── crypto/               # AES-256-GCM password encryption
│   └── types/                    # Shared TypeScript interfaces
├── drizzle/                      # Migration files
├── server.ts                     # Custom Next.js server (WS upgrade)
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── tailwind.config.ts
└── next.config.ts
```

---

## Shared contracts

Every agent MUST use these exact types. Create `src/types/index.ts` first. No agent may deviate from these interfaces — they are the integration boundary.

```typescript
// ============================================================
// src/types/index.ts — SHARED CONTRACTS (DO NOT MODIFY ALONE)
// ============================================================

// --- Database entities ---

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: "admin" | "operator" | "viewer";
  createdAt: number;
  updatedAt: number;
}

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "key" | "password";
  privateKeyPath?: string;
  passwordEncrypted?: string;
  labels: string[];
  groupName?: string;
  status: "connected" | "disconnected" | "reconnecting" | "unreachable" | "unknown";
  lastConnectedAt?: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  serverId: string;
  tmuxSessionName: string;
  status: "active" | "disconnected" | "reconnecting" | "recovering" | "closed";
  cwd?: string;
  lastCommand?: string;
  envSnapshot?: Record<string, string>;
  scrollBufferTail?: string;
  restartPolicy: "auto" | "ask" | "never";
  disconnectedAt?: number;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RestartRule {
  id: string;
  scope: "global" | "server" | "session";
  scopeId?: string;
  pattern: string;
  patternType: "glob" | "regex" | "exact";
  action: "auto" | "ask" | "never";
  priority: number;
  createdBy: string;
  createdAt: number;
}

export interface CommandHistoryEntry {
  id: string;
  sessionId: string;
  serverId: string;
  command: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  classifiedAs: "safe" | "dangerous" | "unknown";
  wasRestarted: boolean;
  executedAt: number;
}

export interface MetricSnapshot {
  id: string;
  serverId: string;
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  diskUsedPercent?: number;
  load1m?: number;
  load5m?: number;
  load15m?: number;
  activeConnections?: number;
  capturedAt: number;
}

export interface Alert {
  id: string;
  serverId: string;
  metric: string;
  threshold: number;
  actualValue: number;
  acknowledged: boolean;
  triggeredAt: number;
}

// --- Session snapshot (in-memory + persisted) ---

export interface SessionSnapshot {
  sessionId: string;
  serverId: string;
  tmuxSession: string;
  cwd: string;
  lastCommand: string;
  env: Record<string, string>;
  scrollBuffer: string[];
  status: Session["status"];
  disconnectedAt?: number;
  retryCount: number;
}

// --- WebSocket protocol ---

export type ClientMessage =
  | { type: "terminal:input"; sessionId: string; data: string }
  | { type: "terminal:resize"; sessionId: string; cols: number; rows: number }
  | { type: "session:create"; serverId: string; command?: string; cwd?: string }
  | { type: "session:attach"; sessionId: string }
  | { type: "session:detach"; sessionId: string }
  | { type: "session:kill"; sessionId: string };

export type ServerMessage =
  | { type: "terminal:output"; sessionId: string; data: string }
  | { type: "session:state"; session: SessionSnapshot }
  | { type: "session:recovered"; sessionId: string; method: "reattach" | "recreate"; command?: string; cwd?: string }
  | { type: "session:lost"; sessionId: string; reason: string }
  | { type: "metrics:update"; serverId: string; metrics: MetricSnapshot }
  | { type: "server:status"; serverId: string; status: Server["status"] };

// --- Restart classification ---

export type RestartAction = "auto" | "ask" | "never";

export interface ClassificationResult {
  command: string;
  action: RestartAction;
  matchedBy: "session-override" | "user-rule" | "builtin-dangerous" | "builtin-safe" | "heuristic" | "default";
  ruleName?: string;
  confidence: "high" | "medium" | "low";
}

// --- API request/response types ---

export interface CreateServerRequest {
  name: string;
  host: string;
  port?: number;
  username: string;
  authMethod: "key" | "password";
  privateKeyPath?: string;
  password?: string;
  labels?: string[];
  groupName?: string;
}

export interface ExecCommandRequest {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface ExecCommandResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CreateRestartRuleRequest {
  scope: "global" | "server" | "session";
  scopeId?: string;
  pattern: string;
  patternType: "glob" | "regex" | "exact";
  action: RestartAction;
  priority?: number;
}

export interface TestRestartRuleRequest {
  command: string;
  serverId?: string;
  sessionId?: string;
}

export interface TestRestartRuleResponse {
  result: ClassificationResult;
  matchedRules: RestartRule[];
}
```

---

## Agent assignments

There are **5 agents** that run in parallel. Each agent owns a specific domain and must not modify files outside its domain unless explicitly noted. Integration happens through the shared types and clearly defined interfaces.

---

### AGENT 1 — Database + Auth + API skeleton

**You own:** `src/lib/db/`, `src/lib/auth/`, `src/lib/crypto/`, `src/app/api/`, `drizzle/`, `drizzle.config.ts`, `server.ts`, `package.json`, `tsconfig.json`, `next.config.ts`

**Your job:** Set up the project foundation — the database schema, ORM, auth, encryption layer, all REST API routes, and the custom server entry point that supports WebSocket upgrade.

**Step-by-step:**

1. Initialize the project: `npx create-next-app@latest managet --typescript --tailwind --app --src-dir`. Install all project dependencies:
   ```
   npm install drizzle-orm better-sqlite3 ssh2 ws xterm next-auth@5 zod uuid
   npm install -D drizzle-kit @types/better-sqlite3 @types/ws @types/ssh2 @types/uuid
   ```

2. Create `src/types/index.ts` with the exact shared contracts from above. This is the canonical source of truth.

3. Create `drizzle.config.ts`:
   ```typescript
   import { defineConfig } from "drizzle-kit";
   export default defineConfig({
     schema: "./src/lib/db/schema.ts",
     out: "./drizzle",
     dialect: "sqlite",
     dbCredentials: { url: process.env.DATABASE_URL || "file:./data/managet.db" },
   });
   ```

4. Create `src/lib/db/schema.ts` — Drizzle schema matching every table:
   - `users` — id (text pk), email (unique), passwordHash, role (default "admin"), createdAt, updatedAt
   - `servers` — id (text pk), name, host, port (default 22), username, authMethod, privateKeyPath, passwordEncrypted, labels (text, JSON stringified), groupName, status (default "unknown"), lastConnectedAt, createdBy (references users), createdAt, updatedAt
   - `sessions` — id (text pk), serverId (references servers, cascade delete), tmuxSessionName, status, cwd, lastCommand, envSnapshot (text, JSON), scrollBufferTail, restartPolicy (default "ask"), disconnectedAt, retryCount (default 0), createdAt, updatedAt
   - `restartRules` — id (text pk), scope, scopeId, pattern, patternType, action, priority (default 0), createdBy (references users), createdAt
   - `commandHistory` — id (text pk), sessionId (references sessions, cascade delete), serverId (references servers, cascade delete), command, cwd, exitCode, durationMs, classifiedAs, wasRestarted (integer default 0), executedAt
   - `metricSnapshots` — id (text pk), serverId (references servers, cascade delete), cpuPercent (real), memoryUsedMb, memoryTotalMb, diskUsedPercent (real), load1m (real), load5m (real), load15m (real), activeConnections, capturedAt
   - `alerts` — id (text pk), serverId (references servers, cascade delete), metric, threshold (real), actualValue (real), acknowledged (integer default 0), triggeredAt

5. Create `src/lib/db/index.ts` — export the drizzle instance and typed query helpers:
   ```typescript
   import { drizzle } from "drizzle-orm/better-sqlite3";
   import Database from "better-sqlite3";
   import * as schema from "./schema";
   const sqlite = new Database(process.env.DATABASE_URL?.replace("file:", "") || "./data/managet.db");
   export const db = drizzle(sqlite, { schema });
   ```

6. Create `src/lib/crypto/index.ts` — AES-256-GCM encrypt/decrypt functions for SSH passwords. Key from `process.env.MANAGET_ENCRYPTION_KEY`. Export `encryptPassword(plain: string): string` and `decryptPassword(cipher: string): string`. The cipher format should be `iv:authTag:ciphertext` as hex strings.

7. Create `src/lib/auth/index.ts` — NextAuth v5 config with credentials provider. Hash passwords with `node:crypto` scrypt. Session strategy: jwt. Export `auth`, `signIn`, `signOut`, `handlers`.

8. Create API routes. Every route must validate input with zod, return proper HTTP status codes, and use the shared types for responses. Routes:
   - `src/app/api/auth/[...nextauth]/route.ts` — NextAuth catch-all handler
   - `src/app/api/servers/route.ts` — GET (list all), POST (create server, encrypt password if authMethod=password)
   - `src/app/api/servers/[id]/route.ts` — GET, PUT, DELETE
   - `src/app/api/servers/[id]/metrics/route.ts` — GET (query metricSnapshots for this server, support ?from=&to= query params)
   - `src/app/api/servers/[id]/sessions/route.ts` — GET (list sessions for this server)
   - `src/app/api/servers/[id]/exec/route.ts` — POST (ExecCommandRequest → ExecCommandResponse, this calls into the SSH agent which Agent 2 builds — for now, export a placeholder function `executeCommand(serverId, command, cwd?) => Promise<ExecCommandResponse>` in `src/lib/ssh/exec.ts` that throws "not implemented")
   - `src/app/api/sessions/[id]/route.ts` — GET, PUT (update restartPolicy, status)
   - `src/app/api/sessions/[id]/recover/route.ts` — POST (manual trigger recovery — calls into SessionManager which Agent 2 builds, use placeholder)
   - `src/app/api/restart-policies/route.ts` — GET (list all rules), POST (create rule)
   - `src/app/api/restart-policies/[id]/route.ts` — PUT, DELETE
   - `src/app/api/restart-policies/test/route.ts` — POST (TestRestartRuleRequest → TestRestartRuleResponse, calls into the classification pipeline which Agent 3 builds, use placeholder `classifyCommand(command, serverId?, sessionId?) => Promise<ClassificationResult>` exported from `src/lib/restart/classify.ts`)

9. Create `server.ts` — custom Next.js server that:
   - Creates an HTTP server from `next`
   - On `upgrade` event, delegates to the WebSocket server (Agent 2 builds the handler — for now, import and call a placeholder `handleUpgrade(req, socket, head)` from `src/lib/ws/index.ts`)
   - Starts listening on `process.env.PORT || 3000`
   - Example structure:
     ```typescript
     import { createServer } from "http";
     import next from "next";
     import { handleUpgrade } from "./src/lib/ws";
     const dev = process.env.NODE_ENV !== "production";
     const app = next({ dev });
     const handle = app.getRequestHandler();
     app.prepare().then(() => {
       const server = createServer(handle);
       server.on("upgrade", handleUpgrade);
       server.listen(port);
     });
     ```

10. Create placeholder files that other agents will implement:
    - `src/lib/ssh/exec.ts` — export `executeCommand` that throws "not implemented"
    - `src/lib/ws/index.ts` — export `handleUpgrade` that does nothing
    - `src/lib/restart/classify.ts` — export `classifyCommand` that returns `{ command, action: "ask", matchedBy: "default", confidence: "low" }`

11. Run `npx drizzle-kit generate` and `npx drizzle-kit migrate` to create the initial migration.

**Constraints:**
- Use `uuid` package for all id generation (v4)
- All timestamps are Unix epoch milliseconds (Date.now())
- Every API route must check auth (return 401 if not authenticated) except the NextAuth routes
- Zod schemas for every request body, query params validated manually
- Return JSON with consistent shape: `{ data: T }` on success, `{ error: string }` on failure

---

### AGENT 2 — SSH agent + WebSocket server + Session management

**You own:** `src/lib/ssh/`, `src/lib/ws/`

**You may read (not write):** `src/lib/db/`, `src/types/`, `src/lib/restart/classify.ts`

**Your job:** Build the SSH connection pool, session manager with tmux integration, CWD tracker, WebSocket server, and the reconnection engine. This is the most complex agent — it is the beating heart of ManageT.

**Step-by-step:**

1. **`src/lib/ssh/connection-pool.ts`** — ConnectionPool class:
   - Maintains a `Map<serverId, ssh2.Client>` of active connections
   - `connect(server: Server): Promise<ssh2.Client>` — creates SSH connection using key or decrypted password. Sets `keepaliveInterval: 15000`, `keepaliveCountMax: 3`, `readyTimeout: 20000`.
   - `getConnection(serverId: string): ssh2.Client | undefined`
   - `disconnect(serverId: string): void`
   - `isConnected(serverId: string): boolean`
   - On connection `close` or `error` events: emit `connection:lost` event with serverId and reason
   - On connection `ready`: emit `connection:ready` event with serverId
   - Singleton export: `export const connectionPool = new ConnectionPool()`
   - The class extends EventEmitter

2. **`src/lib/ssh/cwd-tracker.ts`** — CwdTracker class:
   - `CWD_MARKER_START = "__MANAGET_CWD__"` and `CWD_MARKER_END = "__MANAGET_CWD__"`
   - `injectPromptCommand(stream: ssh2.ClientChannel): void` — writes `export PROMPT_COMMAND='echo ${CWD_MARKER_START}$(pwd)${CWD_MARKER_END}'` to the shell
   - `extractCwd(data: string): { cleanData: string; cwd?: string }` — parses PTY output, strips CWD markers from the data before it reaches xterm.js, returns the cleaned data and extracted cwd if found
   - `startPeriodicFallback(sessionId: string, stream: ssh2.ClientChannel, interval: number): NodeJS.Timeout` — for non-bash shells, periodically runs `pwd` on a side exec channel and parses the result
   - `stopPeriodicFallback(sessionId: string): void`

3. **`src/lib/ssh/session-manager.ts`** — SessionManager class (the most critical file):
   - Maintains in-memory `Map<sessionId, SessionSnapshot>`
   - `createSession(serverId: string, command?: string, cwd?: string): Promise<SessionSnapshot>` — does the following:
     1. Gets or creates SSH connection from pool
     2. Opens a shell channel (`client.shell()`)
     3. Creates a tmux session on remote: `tmux new-session -d -s managet_<sessionId> -x <cols> -y <rows>`
     4. Attaches to it: `tmux attach-session -t managet_<sessionId>`
     5. If cwd provided, sends `cd <cwd>\n`
     6. If command provided, sends `<command>\n`
     7. Injects CwdTracker PROMPT_COMMAND
     8. Creates SessionSnapshot, persists to DB, returns it
   - `attachSession(sessionId: string): Promise<ssh2.ClientChannel>` — re-attaches to existing tmux session
   - `detachSession(sessionId: string): void`
   - `killSession(sessionId: string): Promise<void>` — kills tmux session and closes channel
   - `getSnapshot(sessionId: string): SessionSnapshot | undefined`
   - `updateSnapshot(sessionId: string, partial: Partial<SessionSnapshot>): void` — updates in-memory and persists to DB
   - `handleDisconnect(serverId: string): void` — called when ConnectionPool emits `connection:lost`. For every session on this server:
     1. Set status to "disconnected"
     2. Set disconnectedAt to now
     3. Persist snapshot to DB
     4. Emit `session:lost` for each session
   - `handleReconnect(serverId: string): Promise<void>` — called when ConnectionPool re-establishes connection. For each disconnected session on this server, in parallel (Promise.allSettled):
     1. Set status to "reconnecting"
     2. Check if tmux session still exists: exec `tmux has-session -t <tmuxSessionName> 2>/dev/null && echo EXISTS || echo GONE`
     3. If EXISTS: re-attach to tmux session. Set status to "active". Emit `session:recovered` with method "reattach".
     4. If GONE: create new tmux session. cd to snapshot.cwd. Import `classifyCommand` from `src/lib/restart/classify.ts`. Call `classifyCommand(snapshot.lastCommand, serverId, sessionId)`. Based on result:
        - `action === "auto"`: re-execute the command. Set status to "active". Emit `session:recovered` with method "recreate".
        - `action === "ask"`: set status to "active" but do NOT execute. Emit `session:recovered` with method "recreate" and include the command for the UI to show in the recovery banner.
        - `action === "never"`: set status to "active". Emit `session:recovered` with method "recreate", command omitted.
     5. Re-inject CwdTracker
     6. Reset retryCount to 0
   - Singleton export: `export const sessionManager = new SessionManager()`
   - The class extends EventEmitter

4. **`src/lib/ssh/reconnect.ts`** — ReconnectionEngine class:
   - Listens to ConnectionPool `connection:lost` events
   - For each lost server, starts exponential backoff reconnection:
     - Initial delay: 1000ms
     - Multiplier: 2
     - Max delay: 30000ms
     - Jitter: ±25%
     - Max attempts: 10
   - On each attempt: call `connectionPool.connect(server)`. If success: call `sessionManager.handleReconnect(serverId)`. If fail: increment attempt, schedule next.
   - After 10 failures: update server status to "unreachable" in DB. Stop retrying. Emit `server:unreachable`.
   - `retryNow(serverId: string): void` — manual retry, resets attempt counter
   - Singleton export: `export const reconnectionEngine = new ReconnectionEngine()`

5. **`src/lib/ssh/exec.ts`** — Replace the placeholder:
   - `executeCommand(serverId: string, command: string, cwd?: string, timeout?: number): Promise<ExecCommandResponse>`
   - Gets connection from pool, runs `client.exec()` with the command (prepend `cd <cwd> &&` if cwd provided)
   - Collects stdout, stderr. On close, return exit code and duration.
   - Default timeout: 30 seconds. Kill process on timeout.

6. **`src/lib/ws/index.ts`** — WebSocket server:
   - Replace the placeholder with a real implementation
   - `handleUpgrade(req, socket, head)` — verify auth cookie from request headers (import auth from `src/lib/auth`). If invalid, socket.destroy(). If valid, complete WebSocket upgrade.
   - On connection: parse incoming ClientMessage JSON.
   - Message handlers:
     - `terminal:input` → find the session's SSH channel, write data to it
     - `terminal:resize` → send tmux resize: `tmux resize-window -t <tmux> -x <cols> -y <rows>`
     - `session:create` → call `sessionManager.createSession()`, set up data flow (SSH channel data → parse through CwdTracker → send as `terminal:output` to WS client)
     - `session:attach` → call `sessionManager.attachSession()`
     - `session:detach` → call `sessionManager.detachSession()`
     - `session:kill` → call `sessionManager.killSession()`
   - Listen to SessionManager events and forward as ServerMessage to relevant WS clients:
     - `session:lost` → send `session:lost`
     - `session:recovered` → send `session:recovered`
   - Listen to MetricCollector events (Agent 4) and forward `metrics:update`
   - Maintain a `Map<userId, Set<WebSocket>>` for client tracking
   - Handle WS close: clean up subscriptions

**Constraints:**
- Every SSH command that ManageT runs on the remote must be non-interactive and handle failures gracefully
- Tmux session names must be `managet_<first8CharsOfSessionId>` for uniqueness
- When writing data to SSH channels, handle backpressure (check `stream.write()` return value)
- All EventEmitter usage must type events properly
- Log every connection event, reconnection attempt, and recovery action with timestamps (use `console.log` with `[SSH]`, `[WS]`, `[SESSION]` prefixes for now)

---

### AGENT 3 — Restartable command system

**You own:** `src/lib/restart/`

**You may read (not write):** `src/lib/db/`, `src/types/`

**Your job:** Build the three-tier command classification pipeline — the system that decides whether a command is safe to automatically re-execute after reconnection.

**Step-by-step:**

1. **`src/lib/restart/patterns.ts`** — Built-in pattern definitions:

   Export two arrays: `SAFE_PATTERNS: string[]` and `DANGEROUS_PATTERNS: string[]`.

   Safe patterns (auto-restart) — long-running, idempotent processes:
   ```
   npm run dev*, npm start, yarn dev*, yarn start, pnpm dev*, pnpm start,
   node *server*, node *app*, nodemon *, ts-node *, tsx *,
   next dev, next start, vite, vite dev, vite preview, nuxt dev,
   python -m http.server*, python *manage.py runserver*, flask run*, uvicorn *, gunicorn *,
   cargo run*, cargo watch*, go run *, air,
   java -jar *, mvn spring-boot:run*, gradle bootRun*,
   php artisan serve*, rails server*, rails s*, bundle exec *server*,
   nginx -g 'daemon off;'*,
   docker compose up*, docker-compose up*, docker run *,
   tail -f *, journalctl -f*, watch *, htop, top, btop, less +F *,
   ping *, tcpdump *, strace -p *,
   npm run watch*, npm run serve*, webpack serve*, webpack --watch*,
   tsc --watch*, tsc -w*, jest --watch*, vitest*, pytest-watch*,
   inotifywait *, fswatch *,
   redis-server*, mongod*, mysqld*, postgres*,
   caddy run*, traefik*, consul agent*, vault server*
   ```

   Dangerous patterns (never restart) — destructive or non-idempotent:
   ```
   rm *, rmdir *, mv *, cp *, dd *, mkfs*, fdisk*, parted*, shred *, truncate *,
   curl -X POST *, curl -X PUT *, curl -X DELETE *, curl -X PATCH *, curl -d *, curl --data *,
   wget --post*, http POST *, http PUT *, http DELETE *,
   git push*, git merge*, git rebase*, git reset*, git checkout *, git clean*,
   npm publish*, npm unpublish*, yarn publish*,
   pip install*, pip uninstall*, apt install*, apt remove*, apt purge*,
   apt-get install*, apt-get remove*, yum install*, yum remove*, dnf install*,
   dpkg *, rpm *,
   docker rm *, docker rmi *, docker system prune*, docker volume rm*,
   kubectl delete*, kubectl apply*, kubectl create*,
   terraform apply*, terraform destroy*, ansible-playbook*,
   mysql -e *, psql -c *, mongo --eval*,
   redis-cli FLUSHALL*, redis-cli FLUSHDB*,
   *DROP TABLE*, *DROP DATABASE*, *DELETE FROM*, *TRUNCATE*,
   *migrate*, alembic *, prisma migrate*, drizzle-kit push*, knex migrate*, rake db:*,
   chmod *, chown *, chgrp *, useradd*, userdel*, passwd*, visudo*,
   iptables*, ufw *, firewall-cmd*,
   systemctl start*, systemctl stop*, systemctl restart*, systemctl enable*, systemctl disable*,
   service * start, service * stop, service * restart,
   reboot, shutdown*, poweroff, init *, kill *, killall *, pkill *,
   ssh *, scp *, rsync *, sftp *, crontab *, at *,
   make install*, make deploy*, make clean*,
   npm run build*, npm run deploy*, yarn build*, yarn deploy*,
   cargo build --release*
   ```

2. **`src/lib/restart/matcher.ts`** — Pattern matching engine:
   - `matchGlob(command: string, pattern: string): boolean` — implement glob matching (fnmatch-style). `*` matches any sequence including empty. Case-insensitive. Do NOT use any external library, implement it yourself with a simple recursive or iterative algorithm.
   - `matchRegex(command: string, pattern: string): boolean` — wraps `new RegExp(pattern, "i").test(command)` with try/catch for invalid regex
   - `matchExact(command: string, pattern: string): boolean` — case-insensitive exact match
   - `matchPattern(command: string, pattern: string, type: "glob" | "regex" | "exact"): boolean` — dispatcher

3. **`src/lib/restart/preprocess.ts`** — Command preprocessing:
   - `normalizeCommand(command: string): string` — trims, collapses whitespace
   - `stripSudo(command: string): string` — removes leading `sudo` (and `sudo -u <user>`, `sudo -E`, etc.)
   - `splitChain(command: string): string[]` — splits on `&&`, `||`, `;` respecting quotes. Returns individual commands.
   - `getFirstPipeCommand(command: string): string` — returns the first command in a pipe chain. `cat file | grep x | wc -l` → `cat file`.
   - `preprocessCommand(command: string): { normalized: string; commands: string[]; }` — full pipeline: normalize → strip sudo → split chain. For each command in the chain, also strip pipes (getFirstPipeCommand).

4. **`src/lib/restart/heuristics.ts`** — Tier 3 runtime heuristics:
   - `interface HeuristicContext { durationAtDisconnect: number; hadListeningPort: boolean; previousRestartCount: number; hadFileWrites: boolean; }`
   - `evaluateHeuristics(command: string, context: HeuristicContext): { action: RestartAction; confidence: "high" | "medium" | "low"; heuristicName: string } | null`
   - Heuristic checks in order:
     1. If `hadListeningPort === true` → `{ action: "auto", confidence: "high", heuristicName: "binds_port" }`
     2. If `previousRestartCount >= 3` → `{ action: "auto", confidence: "medium", heuristicName: "repeated_execution" }`
     3. If `durationAtDisconnect > 30000` (30s) → `{ action: "auto", confidence: "medium", heuristicName: "long_running_process" }`
     4. If `hadFileWrites === true` → `{ action: "ask", confidence: "low", heuristicName: "writes_to_filesystem" }`
     5. Otherwise return `null` (no heuristic matched)

5. **`src/lib/restart/classify.ts`** — Replace the placeholder. Main classification pipeline:
   - `classifyCommand(command: string, serverId?: string, sessionId?: string, heuristicContext?: HeuristicContext): Promise<ClassificationResult>`
   - Pipeline steps:
     1. If sessionId provided: query sessions table. If `restartPolicy` is "auto" or "never", return immediately with `matchedBy: "session-override"`.
     2. Query `restartRules` table ordered by scope priority (session > server > global), then by `priority` DESC. For each rule, if the command matches the pattern, return with `matchedBy: "user-rule"`.
     3. Preprocess the command. For chain commands: ALL must be safe for chain to be safe, ANY dangerous makes chain dangerous.
     4. Check against DANGEROUS_PATTERNS. If any match → `{ action: "never", matchedBy: "builtin-dangerous", confidence: "high" }`.
     5. Check against SAFE_PATTERNS. If any match → `{ action: "auto", matchedBy: "builtin-safe", confidence: "high" }`.
     6. If heuristicContext provided, run `evaluateHeuristics()`. If result, return with `matchedBy: "heuristic"`.
     7. Default: `{ action: "ask", matchedBy: "default", confidence: "low" }`.

6. **`src/lib/restart/safety.ts`** — Safety guardrails:
   - `interface CrashLoopState { failures: number; firstFailureAt: number; }`
   - `crashLoopTracker: Map<sessionId, CrashLoopState>`
   - `recordFailure(sessionId: string): { isCrashLooping: boolean }` — if 3 failures within 10 seconds, return `isCrashLooping: true`
   - `recordSuccess(sessionId: string): void` — resets the tracker for this session
   - `autoRestartTracker: Map<sessionId, { count: number; windowStart: number }>`
   - `canAutoRestart(sessionId: string): boolean` — returns false if 5+ auto-restarts in 10-minute window
   - `recordAutoRestart(sessionId: string): void`

7. **`src/lib/restart/index.ts`** — Re-export everything:
   ```typescript
   export { classifyCommand } from "./classify";
   export { SAFE_PATTERNS, DANGEROUS_PATTERNS } from "./patterns";
   export { matchPattern } from "./matcher";
   export { preprocessCommand } from "./preprocess";
   export { evaluateHeuristics } from "./heuristics";
   export { crashLoopTracker, autoRestartTracker } from "./safety";
   export type { ClassificationResult, HeuristicContext } from "./types";
   ```

**Constraints:**
- Zero external dependencies for pattern matching — implement glob yourself
- The classification pipeline must be deterministic: same input = same output (except for DB queries which may change)
- Every function must have JSDoc comments explaining what it does
- Write unit test files alongside each module: `matcher.test.ts`, `preprocess.test.ts`, `heuristics.test.ts`, `classify.test.ts`. Use Node.js built-in test runner (`node:test` + `node:assert`).

---

### AGENT 4 — Monitoring engine

**You own:** `src/lib/monitor/`

**You may read (not write):** `src/lib/db/`, `src/lib/ssh/`, `src/types/`

**Your job:** Build the agentless monitoring system that collects metrics, streams logs, and fires alerts — all over existing SSH connections.

**Step-by-step:**

1. **`src/lib/monitor/metric-collector.ts`** — MetricCollector class:
   - Maintains per-server polling intervals using `setInterval`
   - `startCollecting(serverId: string): void` — begins polling metrics for a server
   - `stopCollecting(serverId: string): void` — stops polling
   - Metric commands and parse logic:
     - CPU: `top -bn1 | grep 'Cpu(s)'` → parse `%us`, `%sy` → `cpuPercent = us + sy`
     - Memory: `free -m | grep Mem` → parse used and total → `memoryUsedMb`, `memoryTotalMb`
     - Disk: `df -h / | tail -1` → parse use% → `diskUsedPercent`
     - Load: `cat /proc/loadavg` → parse first 3 fields → `load1m`, `load5m`, `load15m`
     - Connections: `ss -tunp | tail -n +2 | wc -l` → `activeConnections`
   - Each metric collection: execute command via `connectionPool.getConnection(serverId).exec()`, parse output, create MetricSnapshot, write to DB, emit `metrics:collected` event with the snapshot
   - Polling intervals: CPU/memory/load every 10s, disk every 60s, connections every 30s
   - Handle parse failures gracefully — log warning, skip that metric, don't crash the collector
   - Extends EventEmitter
   - Singleton: `export const metricCollector = new MetricCollector()`

2. **`src/lib/monitor/log-streamer.ts`** — LogStreamer class:
   - `streamJournal(serverId: string, unit: string, onData: (line: string) => void): Promise<{ stop: () => void }>`
     - Runs `journalctl -f -u <unit> --no-pager -o short-iso` via SSH exec
     - Pipes stdout data to onData callback line-by-line
     - Returns stop function that kills the remote process
   - `streamFile(serverId: string, filepath: string, onData: (line: string) => void): Promise<{ stop: () => void }>`
     - Runs `tail -f <filepath>` via SSH exec
     - Same pattern as above
   - `streamDockerLogs(serverId: string, container: string, onData: (line: string) => void): Promise<{ stop: () => void }>`
     - Runs `docker logs -f --tail 100 <container> 2>&1` via SSH exec
   - Each method validates input (no shell injection — reject if serverId/unit/filepath/container contain `;`, `|`, `&&`, `||`, `` ` ``, `$()`)
   - Singleton: `export const logStreamer = new LogStreamer()`

3. **`src/lib/monitor/alert-engine.ts`** — AlertEngine class:
   - `defaultThresholds: Record<string, number>`:
     ```
     cpuPercent: 90, memoryPercent: 85, diskUsedPercent: 90, loadMultiplier: 2.0
     ```
   - Listens to MetricCollector `metrics:collected` events
   - `evaluate(serverId: string, snapshot: MetricSnapshot): Alert[]` — checks each metric against thresholds. For load, threshold is `loadMultiplier * cpuCoreCount` (query via `nproc` on first connect, cache the result).
   - If threshold exceeded and no unacknowledged alert exists for this server+metric: create Alert, write to DB, emit `alert:triggered`
   - `acknowledgeAlert(alertId: string): void` — sets acknowledged=true in DB
   - Extends EventEmitter
   - Singleton: `export const alertEngine = new AlertEngine()`

4. **`src/lib/monitor/pruner.ts`** — MetricPruner:
   - `pruneMetrics(): void` — runs on a 1-hour interval
   - Retention policy:
     - Last 24 hours: keep all (10s resolution)
     - 24h–7d: keep one per minute (delete others)
     - 7d–30d: keep one per 15 minutes
     - Older than 30d: delete all
   - Implementation: for each age bucket, select metric IDs to delete using SQL window functions or grouped queries, then batch delete
   - `startPruner(): NodeJS.Timeout`
   - `stopPruner(): void`

5. **`src/lib/monitor/process-inspector.ts`** — ProcessInspector (used by tier 3 heuristics and dashboard):
   - `getProcessList(serverId: string): Promise<ProcessInfo[]>` — runs `ps aux --sort=-%cpu | head -20`, parses into `{ pid, user, cpu, mem, command }[]`
   - `getDockerContainers(serverId: string): Promise<ContainerInfo[]>` — runs `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null`, parses into objects. Returns empty array if docker not available.
   - `hasListeningPort(serverId: string, pid: number): Promise<boolean>` — runs `ss -tlnp | grep pid=<pid>`, returns true if any match
   - `isWritingFiles(serverId: string, pid: number): Promise<boolean>` — runs `ls -la /proc/<pid>/fd 2>/dev/null | grep -c 'w'`, returns true if count > 0

6. **`src/lib/monitor/index.ts`** — Re-export everything and provide an init function:
   ```typescript
   export { metricCollector } from "./metric-collector";
   export { logStreamer } from "./log-streamer";
   export { alertEngine } from "./alert-engine";
   export { processInspector } from "./process-inspector";
   export { startPruner, stopPruner } from "./pruner";

   export function initMonitoring() {
     // Wire alertEngine to listen to metricCollector events
     // Start the pruner
     // Called once from server.ts on startup
   }
   ```

**Constraints:**
- Every SSH command must be non-interactive and must not hang. Always use timeouts (5s default for metric commands).
- Shell injection prevention is critical in LogStreamer — validate all inputs
- Parse functions must handle unexpected output gracefully (different Linux distros format `free`, `top`, `df` differently). Use flexible regex, not column-index parsing.
- Metric collection must not block — if one server is slow, others continue independently
- All EventEmitter events must be typed

---

### AGENT 5 — Frontend UI

**You own:** `src/app/(dashboard)/`, `src/app/(terminal)/`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/components/`, `tailwind.config.ts`

**You may read (not write):** `src/types/`, `src/app/api/` (for endpoint shapes)

**Your job:** Build the entire frontend — dashboard, terminal view, server management UI, restart policy settings, and the session recovery banner. You are a frontend specialist. Make it look professional and feel fast.

**Design system — Neon Purple Dark Theme:**

The entire UI is dark-first with neon purple as the primary accent. Think cyberpunk terminal meets professional dashboard. The aesthetic is: deep dark backgrounds, purple glows on interactive elements, sharp contrast, monospace vibes in data areas.

**Color palette (use CSS variables via Tailwind):**

```
--bg-primary:       #0a0a0f       /* Deepest background — near black with blue undertone */
--bg-secondary:     #12121a       /* Card/surface background */
--bg-tertiary:      #1a1a2e       /* Elevated surfaces, sidebar */
--bg-hover:         #232340       /* Hover states on surfaces */
--bg-active:        #2a2a4a       /* Active/selected states */

--accent-primary:   #a855f7       /* Neon purple — primary buttons, active states, links */
--accent-bright:    #c084fc       /* Brighter purple — hover states, highlights */
--accent-dim:       #7c3aed       /* Deeper purple — pressed states, borders */
--accent-glow:      rgba(168, 85, 247, 0.15)  /* Purple glow for box-shadows, focus rings */
--accent-glow-strong: rgba(168, 85, 247, 0.3) /* Stronger glow for hover */

--text-primary:     #e4e4e7       /* Primary text — off-white */
--text-secondary:   #a1a1aa       /* Secondary/muted text */
--text-tertiary:    #71717a       /* Tertiary/hint text */
--text-on-accent:   #ffffff       /* Text on purple backgrounds */

--border-default:   #27272a       /* Default borders — barely visible */
--border-hover:     #3f3f46       /* Borders on hover */
--border-accent:    rgba(168, 85, 247, 0.4)  /* Purple-tinted borders */

--status-connected:    #22c55e    /* Green */
--status-reconnecting: #eab308    /* Yellow */
--status-disconnected: #ef4444    /* Red */
--status-unreachable:  #6b7280    /* Gray */

--terminal-bg:      #0d0d14       /* Terminal pane background */
--terminal-cursor:  #a855f7       /* Purple cursor */
--terminal-selection: rgba(168, 85, 247, 0.3) /* Selection highlight */
```

**Tailwind config specifics:**
```typescript
// tailwind.config.ts
const config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        mg: {
          bg:      { DEFAULT: "#0a0a0f", secondary: "#12121a", tertiary: "#1a1a2e", hover: "#232340", active: "#2a2a4a" },
          accent:  { DEFAULT: "#a855f7", bright: "#c084fc", dim: "#7c3aed" },
          text:    { DEFAULT: "#e4e4e7", secondary: "#a1a1aa", tertiary: "#71717a" },
          border:  { DEFAULT: "#27272a", hover: "#3f3f46" },
        }
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      boxShadow: {
        "glow":       "0 0 20px rgba(168, 85, 247, 0.15)",
        "glow-lg":    "0 0 40px rgba(168, 85, 247, 0.2)",
        "glow-hover": "0 0 30px rgba(168, 85, 247, 0.3)",
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "fade-in":    "fade-in 0.2s ease-out",
        "slide-up":   "slide-up 0.3s ease-out",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 20px rgba(168, 85, 247, 0.15)" },
          "50%":      { boxShadow: "0 0 30px rgba(168, 85, 247, 0.3)" },
        },
        "fade-in":  { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": { from: { opacity: "0", transform: "translateY(8px)" }, to: { opacity: "1", transform: "translateY(0)" } },
      },
    }
  }
}
```

**Design rules for every component:**

1. **Backgrounds:** Never use pure black (#000). Always use the bg palette. Cards use `bg-mg-bg-secondary` with `border border-mg-border` and `rounded-lg`.
2. **Purple glow effects:** Primary buttons get `shadow-glow` on default and `shadow-glow-hover` on hover. Focus rings use `ring-2 ring-mg-accent/40 ring-offset-2 ring-offset-mg-bg`. Active sidebar items and selected tabs get a left border accent `border-l-2 border-mg-accent` with `bg-mg-bg-active`.
3. **Typography:** UI text uses Inter (sans). ALL monospace content (terminal, metrics, server addresses, commands, code, IPs, ports) uses JetBrains Mono. Headings are `text-mg-text font-medium`, body is `text-mg-text-secondary`, hints are `text-mg-text-tertiary`.
4. **Buttons:** Primary = `bg-mg-accent text-white hover:bg-mg-accent-bright shadow-glow`. Secondary = `bg-mg-bg-tertiary text-mg-text border border-mg-border hover:border-mg-border-hover`. Danger = `bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20`. Ghost = `text-mg-text-secondary hover:text-mg-text hover:bg-mg-bg-hover`.
5. **Inputs/selects:** `bg-mg-bg-tertiary border border-mg-border text-mg-text placeholder:text-mg-text-tertiary focus:border-mg-accent focus:ring-2 focus:ring-mg-accent/20 rounded-md`.
6. **Status dots:** Tiny 8px circles with the status color + a matching `shadow-[0_0_8px]` glow. Connected server = green dot with green glow, disconnected = red with red glow.
7. **Cards (ServerCard, etc.):** `bg-mg-bg-secondary border border-mg-border rounded-lg p-4 hover:border-mg-border-hover hover:shadow-glow transition-all duration-200`. On hover the card gets a subtle purple glow lift.
8. **Sidebar:** `bg-mg-bg-tertiary border-r border-mg-border`. Nav items are `px-3 py-2 rounded-md text-mg-text-secondary hover:text-mg-text hover:bg-mg-bg-hover`. Active item gets `text-mg-accent bg-mg-bg-active border-l-2 border-mg-accent`.
9. **Tables:** Header row `bg-mg-bg-tertiary text-mg-text-tertiary text-xs uppercase tracking-wider`. Body rows `border-b border-mg-border hover:bg-mg-bg-hover`. Alternating rows NOT used (hover is enough).
10. **Modals:** Overlay `bg-black/60 backdrop-blur-sm`. Modal body `bg-mg-bg-secondary border border-mg-border rounded-xl shadow-glow-lg`. Animate in with `animate-fade-in`.
11. **Terminal pane background:** `#0d0d14` (even darker than the UI). The xterm.js theme:
    ```typescript
    {
      background: "#0d0d14",
      foreground: "#e4e4e7",
      cursor: "#a855f7",
      cursorAccent: "#0d0d14",
      selectionBackground: "rgba(168, 85, 247, 0.3)",
      black: "#27272a",
      red: "#ef4444",
      green: "#22c55e",
      yellow: "#eab308",
      blue: "#3b82f6",
      magenta: "#a855f7",
      cyan: "#06b6d4",
      white: "#e4e4e7",
      brightBlack: "#52525b",
      brightRed: "#f87171",
      brightGreen: "#4ade80",
      brightYellow: "#facc15",
      brightBlue: "#60a5fa",
      brightMagenta: "#c084fc",
      brightCyan: "#22d3ee",
      brightWhite: "#ffffff",
    }
    ```
12. **RecoveryBanner:** NOT green (clashes with theme). Use `bg-mg-accent/10 border border-mg-accent/30 text-mg-accent-bright` for a purple-tinted recovery banner that fits the theme. The "Cancel" button inside uses the danger variant.
13. **Sparklines and charts:** Use purple (`#a855f7`) as the primary chart color. Secondary metrics use `#06b6d4` (cyan). Warning metrics use `#eab308`. Critical uses `#ef4444`. Chart backgrounds are transparent (card provides the bg). Grid lines use `#27272a`.
14. **Empty states:** Centered icon (subtle purple outline), heading in `text-mg-text`, description in `text-mg-text-secondary`, CTA button in primary style.
15. **Loading states:** Use a subtle purple pulse animation. Skeleton loaders use `bg-mg-bg-tertiary animate-pulse rounded`.
16. **Transitions:** All interactive elements get `transition-all duration-200`. No abrupt state changes.

**Step-by-step:**

1. **`tailwind.config.ts`** — Implement the exact Tailwind config from the design system above. Install Inter and JetBrains Mono via `next/font/google` (not CDN). Add all custom colors, shadows, animations, and keyframes exactly as specified.

2. **`src/app/layout.tsx`** — Root layout:
   - Apply `dark` class to `<html>` (always dark)
   - Set `<body>` to `bg-mg-bg text-mg-text`
   - Left sidebar navigation (240px wide, `bg-mg-bg-tertiary border-r border-mg-border`): Dashboard, Servers, Terminal, Settings — using the sidebar styling from the design system
   - Top bar (`bg-mg-bg-secondary border-b border-mg-border`): server connection count indicator (e.g., "3/5 connected" with status dots), user avatar/menu
   - Load Inter (sans) and JetBrains Mono (mono) via `next/font/google`

3. **`src/app/page.tsx`** — Redirect to dashboard

4. **`src/app/(dashboard)/dashboard/page.tsx`** — Server overview:
   - Grid of ServerCard components, each showing: name, host, status badge (green/yellow/red), CPU sparkline (last 60 readings), RAM bar, uptime
   - Click a card to navigate to that server's detail view
   - "Add Server" button in header → opens modal
   - Filter by group, search by name
   - Auto-refresh via polling every 10s (fetch `/api/servers` + metrics)

5. **`src/components/dashboard/ServerCard.tsx`**:
   - Status indicator: colored dot (green=connected, yellow=reconnecting, red=disconnected/unreachable)
   - CPU sparkline: tiny line chart (last 60 data points, use SVG path — no library needed for a sparkline)
   - RAM bar: horizontal progress bar with percentage label
   - Labels shown as small pills/tags
   - Click triggers navigation

6. **`src/components/dashboard/MetricSparkline.tsx`**:
   - Takes `data: number[]` and `color: string`
   - Renders an SVG polyline sparkline, 120px wide × 30px tall
   - Handles empty data gracefully

7. **`src/components/dashboard/AlertBadge.tsx`**:
   - Shows count of unacknowledged alerts
   - Red badge if any critical, yellow if warning
   - Click opens alert list panel

8. **`src/app/(dashboard)/servers/[id]/page.tsx`** — Server detail:
   - Full metrics charts (recharts): CPU, RAM, disk over time with time range selector (1h, 6h, 24h, 7d)
   - Process list table (sortable by CPU, RAM)
   - Docker container list (if available)
   - Active sessions list with status badges
   - "Open Terminal" button → navigates to terminal view with this server pre-selected
   - "Edit Server" and "Delete Server" buttons
   - Log streaming panel: select a service/file/container, stream logs in a scrollable monospace area

9. **`src/app/(terminal)/terminal/page.tsx`** — Terminal view:
   - Full-height terminal area
   - Tab bar at top: each tab = one session. Tab shows server name + session status
   - "+" button to create new session (dropdown to pick server)
   - Support split-view: horizontal/vertical split, drag to resize
   - Each pane renders a TerminalPane component
   - Session status indicators in tab: green dot = active, yellow spinner = reconnecting, red = disconnected

10. **`src/components/terminal/TerminalPane.tsx`** — The core terminal component:
    - Creates xterm.js Terminal instance with addons (fit, web-links, search)
    - Connects to WebSocket on mount: sends `session:create` or `session:attach`
    - On `terminal:output` messages: writes to xterm
    - On keypress: sends `terminal:input` via WS
    - On resize: calls fitAddon.fit() and sends `terminal:resize` via WS
    - Terminal theme: use the exact xterm.js theme object from the design system above (purple cursor, deep dark background #0d0d14, purple selection)
    - Handles WS disconnect: shows "Reconnecting..." overlay with `bg-mg-bg/80 backdrop-blur-sm` and a purple pulse spinner
    - Clean up on unmount: send `session:detach`, close WS

11. **`src/components/terminal/RecoveryBanner.tsx`**:
    - Shown when a `session:recovered` WS message arrives
    - Purple-tinted banner at top of terminal pane: `bg-mg-accent/10 border border-mg-accent/30 text-mg-accent-bright rounded-md mx-2 mt-2 px-3 py-2`
    - Content depends on recovery method:
      - `reattach`: "Session recovered — reconnected to existing process"
      - `recreate` with command: "Session recovered — re-executed `<command>` in `<cwd>`" + "Cancel" button (5s countdown)
      - `recreate` without command: "Session recovered in `<cwd>` — previous command was not restarted"
    - Auto-dismisses after 10 seconds
    - "Cancel" button sends `session:kill` + creates a new clean session

12. **`src/components/terminal/CommandRunner.tsx`**:
    - Simple panel: text input for command, dropdown to select server(s) (multi-select), "Run" button
    - Output area: monospace scrollable div showing stdout/stderr
    - Calls POST `/api/servers/:id/exec`
    - Support running on multiple servers simultaneously, showing output side-by-side with server name labels

13. **`src/app/(dashboard)/settings/page.tsx`** — Settings:
    - **Restart Policies tab:**
      - Table of all restart rules, sortable by scope/priority
      - Add/edit/delete rules via modal form
      - Fields: scope (dropdown), scopeId (conditional server/session picker), pattern, patternType (dropdown), action (dropdown), priority (number)
      - "Test Command" section: input a command, optionally select server/session context, hit "Test" → shows ClassificationResult with which rule matched
    - **Profile tab:** email, change password
    - **General tab:** placeholder for future settings

14. **`src/components/ui/`** — Shared primitives. Build these from scratch with Tailwind (no shadcn installation needed, just implement the components):
    - `Button.tsx` — variants: primary, secondary, danger, ghost. Sizes: sm, md, lg.
    - `Input.tsx` — text input with label, error state, optional icon
    - `Select.tsx` — dropdown with label
    - `Modal.tsx` — centered overlay modal with title, body, footer actions
    - `Badge.tsx` — status badge with color variants
    - `Toast.tsx` — notification toast (success, error, warning, info) with auto-dismiss
    - `Tabs.tsx` — tab navigation component
    - `Table.tsx` — sortable data table with header click sorting

15. **WebSocket hook — `src/lib/hooks/useWebSocket.ts`**:
    - `useWebSocket(sessionId?: string): { sendMessage, lastMessage, connectionState }`
    - Manages WS connection lifecycle, reconnects on drop
    - Typed with ClientMessage/ServerMessage
    - Returns connection state: "connecting" | "connected" | "disconnected"

16. **API hooks — `src/lib/hooks/useApi.ts`**:
    - `useServers()` — fetches and caches server list
    - `useServer(id)` — fetches single server
    - `useServerMetrics(id, timeRange)` — fetches metrics
    - `useSessions(serverId)` — fetches sessions
    - `useRestartRules()` — fetches rules
    - All with loading/error states, built on `fetch` + `useState`/`useEffect`

**Constraints:**
- Use client components (`"use client"`) for anything interactive. Server components for static layouts and data fetching where possible.
- xterm.js must be dynamically imported (`next/dynamic` with `ssr: false`) — it doesn't work server-side
- Terminal must feel instant — no loading spinners for keystroke echo
- All forms must validate client-side before submitting (use zod schemas imported from the shared types where applicable)
- Responsive down to tablet (1024px min). Terminal view is desktop-only (show message on mobile).
- Keyboard shortcuts: `Ctrl+Shift+T` = new terminal tab, `Ctrl+Shift+W` = close tab, `Ctrl+Tab` = next tab
- Handle empty states everywhere: no servers → "Add your first server" CTA, no sessions → "Open a terminal to get started", no metrics → "Waiting for data..."

---

## Integration protocol

When all 5 agents finish their work:

1. Agent 1's API routes call into Agent 2's SSH functions and Agent 3's classification functions (placeholders were replaced)
2. Agent 2's WebSocket server sends Agent 4's metrics to Agent 5's frontend
3. Agent 2's SessionManager calls Agent 3's `classifyCommand` during recovery
4. Agent 5's frontend calls Agent 1's API routes and connects to Agent 2's WebSocket server
5. Agent 4's monitoring hooks into Agent 2's connection pool

**After all agents complete, run:**
```bash
npm run build     # Verify the project compiles
npx drizzle-kit migrate  # Apply DB migrations
node server.ts    # Start the custom server
```

---

## Environment variables

Create `.env.local`:
```
DATABASE_URL=file:./data/managet.db
NEXTAUTH_SECRET=<random-32-chars>
NEXTAUTH_URL=http://localhost:3000
MANAGET_ENCRYPTION_KEY=<random-32-hex-chars>
```

---

## Rules for all agents

1. **TypeScript strict mode.** No `any` types. No `@ts-ignore`.
2. **Use the shared types from `src/types/index.ts` everywhere.** Do not redefine interfaces.
3. **Do not install additional dependencies** without documenting why in a comment at the top of the file that needs it.
4. **Every file must have a top-level JSDoc comment** explaining what it does and who owns it (which agent).
5. **Error handling:** never let errors crash the process. Wrap SSH operations in try/catch. Log errors with `[COMPONENT_NAME]` prefix.
6. **No console.error for expected states** (like a server being offline). Use console.warn. Reserve console.error for bugs.
7. **File ownership is strict.** If you need a function from another agent's domain, import it — do not reimplement it.
