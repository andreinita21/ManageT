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
  | { op: "kill"; id: string }
  | { op: "resize"; id: string; rows: number; cols: number };

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
   * The stream is returned in *paused* mode (no `data` listener
   * attached). The caller is expected to flush `initialBytes` to its
   * consumer first, then wire its own `data` listener, which will
   * auto-resume the stream and deliver any subsequent live output.
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

/**
 * Read until the first newline, parse the prefix as a JSON `AgentResponse`,
 * and return the trailing bytes (if any) verbatim. Pauses the stream after
 * the handshake so any further bytes that arrive before the caller wires
 * its own `data` listener stay buffered on the readable side (Node's
 * internal buffer holds them until the next listener auto-resumes flow).
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
      // Pause so further chunks wait in the readable buffer for the
      // caller's listener instead of being silently dropped.
      stream.pause();
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
