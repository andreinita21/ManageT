/**
 * Dashboard ↔ remote-agent control channel.
 *
 * The Rust agent on every managed host listens on the Unix socket
 * `/var/run/managet/agent.sock` and speaks the protocol defined in
 * `agent/src/sessions/protocol.rs`. We reach that socket without opening
 * any new firewall holes by tunnelling through the existing SSH session
 * (the same one the dashboard uses for the install flow). ssh2's
 * `openssh_forwardOutStreamLocal` gives us a Duplex stream that's
 * functionally identical to a local connection on the box.
 *
 * Two helpers:
 *   - `agentRequest(serverId, req)`     — one-shot JSON exchange
 *     (List / New / Kill / Resize). Opens a fresh forwarded socket,
 *     sends one newline-terminated JSON, reads one newline-terminated
 *     JSON, closes.
 *   - `openAgentAttach(serverId, req)`  — long-lived attach. Sends the
 *     Attach JSON, awaits `Attached`, then hands the caller a raw Duplex
 *     for byte-for-byte piping in both directions.
 *
 * Single source of truth for sessions lives on the agent, in agent
 * process memory. Browser refresh → re-attach → scrollback replay
 * (handled by the agent). Dashboard restart → still re-attach. The
 * dashboard process is no longer the holder of any PTY.
 */
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import type { Client as SshClient } from "ssh2";

import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { rowToServer } from "@/lib/db/transform";
import { connectionPool } from "./connection-pool";

/** Path on every managed host where the agent listens. Kept in sync with
 * `agent::sessions::server::socket_path()` in the Rust code. */
const AGENT_SOCKET_PATH = "/var/run/managet/agent.sock";

// ---------------------------------------------------------------------------
// Wire types — must stay in sync with agent/src/sessions/protocol.rs
// ---------------------------------------------------------------------------

export type AgentRequest =
  | { op: "list" }
  | {
      op: "new";
      name?: string;
      command?: string;
      rows?: number;
      cols?: number;
      /** Optional Unix user the agent should drop privileges to before
       *  spawning the PTY. When omitted, the shell inherits the agent's
       *  identity (root on installed hosts) — kept for backwards compat
       *  with the old wire format. */
      user?: string;
    }
  | { op: "attach"; id: string; rows?: number; cols?: number }
  /** Stream a session's output as timestamped, control-stripped log lines
   *  (newline-delimited `LogLine` JSON) for the stacks debugger view.
   *  Like `attach` it's long-lived, but the stream stays JSON the whole
   *  time and never carries input. Older agents reply `Response::Error`
   *  for the unknown op; the caller treats that as "this host can't tail". */
  | { op: "tail"; id: string }
  | { op: "kill"; id: string }
  | { op: "resize"; id: string; rows: number; cols: number }
  /** Update a session's display name in place. The dashboard fires this
   *  after a rename in the UI so that `managet list` / `managet attach
   *  <name>` on the host show the same name. Older agents that don't
   *  know about this op respond with `Response::Error`; the caller
   *  treats that as "name updated locally only" rather than a hard
   *  failure. */
  | { op: "rename"; id: string; name: string };

export interface AgentSessionInfo {
  id: string;
  name: string;
  command: string;
  created_at_ms: number;
  attached_clients: number;
  running: boolean;
}

export type AgentResponse =
  | { result: "session_list"; sessions: AgentSessionInfo[] }
  | { result: "created"; id: string; name: string }
  | { result: "attached"; id: string; name: string }
  | { result: "ok" }
  | { result: "error"; message: string };

// ---------------------------------------------------------------------------
// SSH client helper
// ---------------------------------------------------------------------------

async function getSshClient(serverId: string): Promise<SshClient> {
  const existing = connectionPool.getConnection(serverId);
  if (existing) return existing;
  const rows = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`agent-socket: server ${serverId} not in database`);
  }
  return connectionPool.connect(rowToServer(rows[0]));
}

/** Open a fresh forwarded Unix-socket stream to the agent on `serverId`. */
function openForwardedSocket(client: SshClient): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.openssh_forwardOutStreamLocal(
      AGENT_SOCKET_PATH,
      (err, stream) => {
        if (err) {
          reject(
            new Error(
              `agent-socket: forward to ${AGENT_SOCKET_PATH} failed: ${err.message}. ` +
                `Is the agent installed and running?`
            )
          );
          return;
        }
        resolve(stream as unknown as Duplex);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// One-shot request/response
// ---------------------------------------------------------------------------

/**
 * Send a single newline-delimited JSON request, read a single newline-delimited
 * JSON response, close. Used for List/New/Kill/Resize where there is no raw
 * payload after the JSON exchange.
 *
 * Throws on transport failure or if the agent returned `{result:"error"}`.
 */
export async function agentRequest<R extends AgentResponse = AgentResponse>(
  serverId: string,
  req: AgentRequest,
  timeoutMs = 10_000
): Promise<R> {
  const client = await getSshClient(serverId);
  const stream = await openForwardedSocket(client);

  return new Promise<R>((resolve, reject) => {
    const buffers: Buffer[] = [];
    let done = false;
    const finish = (err: Error | null, value?: R) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else if (value) resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`agent-socket: request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    stream.on("data", (chunk: Buffer) => {
      buffers.push(chunk);
      const joined = Buffer.concat(buffers);
      const nl = joined.indexOf(0x0a); // '\n'
      if (nl === -1) return;
      const line = joined.subarray(0, nl).toString("utf-8");
      let parsed: AgentResponse;
      try {
        parsed = JSON.parse(line) as AgentResponse;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        finish(new Error(`agent-socket: bad response JSON: ${m}: ${line}`));
        return;
      }
      if (parsed.result === "error") {
        finish(new Error(`agent: ${parsed.message}`));
        return;
      }
      finish(null, parsed as R);
    });

    stream.on("error", (e: Error) =>
      finish(new Error(`agent-socket: stream error: ${e.message}`))
    );
    stream.on("close", () => {
      if (!done) finish(new Error("agent-socket: stream closed before response"));
    });

    stream.write(JSON.stringify(req) + "\n");
  });
}

// ---------------------------------------------------------------------------
// Long-lived attach
// ---------------------------------------------------------------------------

export interface AttachedHandle {
  /** The agent's confirmed session id (matches what we asked for). */
  sessionId: string;
  /** Friendly name reported by the agent. */
  sessionName: string;
  /**
   * Raw byte stream — write keystrokes in, read terminal output out.
   * No `data` listener is attached. The caller should flush
   * `initialBytes` to its consumer first, then wire its own `data`
   * listener; that listener auto-resumes flowing mode and any bytes
   * the agent emits between the handshake and listener-attachment
   * sit in Node's internal readable buffer until then.
   */
  stream: Duplex;
  /**
   * Bytes that arrived in the same TCP segment as the handshake JSON —
   * the agent writes `{"result":"attached",…}\n` and then immediately
   * dumps the scrollback ring, so both routinely land in a single read.
   * Those bytes are extracted here so the consumer can deliver the
   * replay to xterm deterministically *before* it starts piping live
   * output. Forwarding `initialBytes` after wiring the `data` listener
   * still works (any leftover sits in the readable buffer until then),
   * but doing it first keeps the "scrollback, then live" ordering
   * unambiguous.
   */
  initialBytes: Buffer;
}

/**
 * Open an attach connection. After the JSON handshake the returned stream
 * is in raw byte mode — anything you `write()` becomes PTY input, anything
 * you read off `data` events is PTY output.
 *
 * The caller owns the stream and is responsible for closing it on detach.
 * Closing the stream does NOT kill the session — the agent keeps the PTY
 * running and any other attached client (incl. local `managet attach`)
 * keeps seeing live output. This is the whole point of the architecture.
 */
export async function openAgentAttach(
  serverId: string,
  sessionId: string,
  rows: number | undefined,
  cols: number | undefined
): Promise<AttachedHandle> {
  const client = await getSshClient(serverId);
  const stream = await openForwardedSocket(client);

  // Send the attach request.
  stream.write(
    JSON.stringify({
      op: "attach",
      id: sessionId,
      rows,
      cols,
    } satisfies AgentRequest) + "\n"
  );

  // Read exactly one newline-delimited JSON response. Anything that
  // arrived in the same chunk after the `\n` is the agent's scrollback
  // replay — capture it as `initialBytes` and hand it to the caller
  // instead of pushing it back onto the stream. (`stream.unshift()`
  // worked in theory but had a real-world timing issue on Node 22 +
  // ssh2's forwarded Unix sockets where the very first attach
  // occasionally lost the replay.)
  const { parsed: handshake, leftover } = await readHandshake(stream);
  if (handshake.result === "error") {
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(`agent: ${handshake.message}`);
  }
  if (handshake.result !== "attached") {
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(
      `agent-socket: unexpected handshake result "${handshake.result}"`
    );
  }

  return {
    sessionId: handshake.id,
    sessionName: handshake.name,
    stream,
    initialBytes: leftover,
  };
}

/** One timestamped log line, as emitted by the agent's `Tail` stream.
 *  Mirrors `LogLine` in agent/src/sessions/protocol.rs. */
export interface AgentLogLine {
  /** ms since the Unix epoch, on the agent host's clock. */
  t: number;
  /** control-stripped line text, no trailing newline. */
  line: string;
}

export interface TailHandle {
  /** The agent's confirmed session id. */
  sessionId: string;
  /** Underlying duplex. Close it to stop the tail (never affects the PTY). */
  stream: Duplex;
  /**
   * Register the per-line consumer. Call exactly once. Any lines the agent
   * sent between the handshake and this call — the leading burst of the
   * ring replay — were buffered and are delivered synchronously here first,
   * then every subsequent line as it arrives. Each `line` is one complete
   * `AgentLogLine` JSON string (no trailing newline).
   */
  start(onLine: (line: string) => void): void;
}

/**
 * Open a tail connection: ask the agent to stream a session's timestamped
 * log lines. After the one-line `{"result":"ok"}` handshake the stream is a
 * newline-delimited sequence of `AgentLogLine` JSON objects — first the
 * replay of the session's bounded line ring, then live lines.
 *
 * Unlike `openAgentAttach`, this keeps a SINGLE persistent `data` listener
 * for the connection's whole life and never hands the stream off. The
 * attach path's "read the handshake, drop the listener, let the caller
 * reattach" dance loses data on ssh2's forwarded Unix-socket streams (the
 * same flowing-state quirk its own comments call out) — tolerable for a few
 * bytes of xterm scrollback, but here it silently dropped the front of
 * large ring replays. Buffering lines parsed before the caller registers
 * its consumer (`start`) closes that gap entirely.
 *
 * Closing the returned stream stops the tail; it never affects the PTY.
 * Throws (with the agent's message) if the session is unknown or the agent
 * is too old to know the `tail` op.
 */
export async function openAgentTail(
  serverId: string,
  sessionId: string
): Promise<TailHandle> {
  const client = await getSshClient(serverId);
  const stream = await openForwardedSocket(client);

  stream.write(
    JSON.stringify({ op: "tail", id: sessionId } satisfies AgentRequest) + "\n"
  );

  return await new Promise<TailHandle>((resolve, reject) => {
    let buf = "";
    let handshakeSeen = false;
    let settled = false;
    let onLine: ((line: string) => void) | null = null;
    const pending: string[] = [];

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!handshakeSeen) {
          handshakeSeen = true;
          let parsed: AgentResponse;
          try {
            parsed = JSON.parse(line) as AgentResponse;
          } catch {
            fail(new Error(`agent-socket: bad tail handshake JSON: ${line}`));
            return;
          }
          if (parsed.result === "error") {
            fail(new Error(`agent: ${parsed.message}`));
            return;
          }
          if (parsed.result !== "ok") {
            fail(
              new Error(
                `agent-socket: unexpected tail handshake result "${parsed.result}"`
              )
            );
            return;
          }
          settled = true;
          // Listeners stay attached — the handle owns the stream now.
          resolve({
            sessionId,
            stream,
            start(cb) {
              onLine = cb;
              for (const l of pending) cb(l);
              pending.length = 0;
            },
          });
          continue;
        }
        if (!line) continue;
        if (onLine) onLine(line);
        else pending.push(line);
      }
    };

    stream.on("data", onData);
    stream.on("error", (e: Error) =>
      fail(new Error(`agent-socket: tail stream error: ${e.message}`))
    );
    stream.on("close", () =>
      fail(new Error("agent-socket: stream closed during tail handshake"))
    );
  });
}

/**
 * Read until the first newline, parse the prefix as a JSON `AgentResponse`,
 * and return the trailing bytes (if any) verbatim.
 *
 * Deliberately does NOT call `stream.pause()`. Removing our `data`
 * listener with no other listeners attached leaves Node's stream in
 * `state.flowing = null` (the "no consumers, buffer internally" mode);
 * when the caller later adds its own `data` listener, Node auto-resumes
 * and flushes any bytes that arrived in the gap. Calling `pause()`
 * here would set `state.flowing = false`, after which adding a `data`
 * listener does NOT auto-resume — and the agent's live PTY output
 * would silently pile up in the internal buffer, leaving the user
 * unable to see any echo of their keystrokes (looks like "the terminal
 * is dead"). This bit empty-scrollback (brand-new) sessions the
 * hardest, because there's no initial replay to mask the failure.
 */
function readHandshake(
  stream: Duplex
): Promise<{ parsed: AgentResponse; leftover: Buffer }> {
  return new Promise<{ parsed: AgentResponse; leftover: Buffer }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const joined = Buffer.concat(chunks);
      const nl = joined.indexOf(0x0a);
      if (nl === -1) return;
      cleanup();
      const line = joined.subarray(0, nl).toString("utf-8");
      // `Buffer.from(...)` copies — `joined.subarray` would share the
      // underlying memory with the concat buffer, which is fine in
      // practice but easier to reason about as an independent buffer.
      const leftover = Buffer.from(joined.subarray(nl + 1));
      let parsed: AgentResponse;
      try {
        parsed = JSON.parse(line) as AgentResponse;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        reject(new Error(`agent-socket: bad handshake JSON: ${m}: ${line}`));
        return;
      }
      resolve({ parsed, leftover });
    };
    const onError = (e: Error) => {
      cleanup();
      reject(new Error(`agent-socket: handshake stream error: ${e.message}`));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("agent-socket: stream closed during handshake"));
    };
    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("close", onClose);
  });
}
