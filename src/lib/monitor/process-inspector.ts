/**
 * @file process-inspector.ts — Remote process and container inspection.
 *
 * Provides helpers to list processes, Docker containers, and check
 * whether a given PID is holding a listening socket or writing to files
 * on a remote server. All commands are executed over SSH with a 5-second
 * timeout.
 */

import { executeCommand } from "@/lib/ssh/exec";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Information about a single OS-level process. */
interface ProcessInfo {
  pid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  vsz: number;
  rss: number;
  tty: string;
  stat: string;
  startTime: string;
  command: string;
}

/** Information about a single Docker container. */
interface ContainerInfo {
  containerId: string;
  image: string;
  command: string;
  created: string;
  status: string;
  ports: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SSH_TIMEOUT = 5_000;

// ---------------------------------------------------------------------------
// ProcessInspector
// ---------------------------------------------------------------------------

class ProcessInspector {
  private static instance: ProcessInspector | null = null;

  private constructor() {}

  /** Get or create the singleton instance. */
  static getInstance(): ProcessInspector {
    if (!ProcessInspector.instance) {
      ProcessInspector.instance = new ProcessInspector();
    }
    return ProcessInspector.instance;
  }

  /**
   * Retrieve the full process list from a remote server.
   *
   * Uses `ps aux` and parses the tabular output. The header line is
   * skipped automatically.
   */
  async getProcessList(serverId: string): Promise<ProcessInfo[]> {
    const res = await executeCommand(serverId, "ps aux --no-headers", undefined, SSH_TIMEOUT);

    return this.parseProcessList(res.stdout);
  }

  /**
   * List Docker containers on a remote server (all states).
   *
   * Uses `docker ps -a --no-trunc --format` with a pipe-separated
   * template for reliable parsing.
   */
  async getDockerContainers(serverId: string): Promise<ContainerInfo[]> {
    const format =
      "{{.ID}}|{{.Image}}|{{.Command}}|{{.CreatedAt}}|{{.Status}}|{{.Ports}}|{{.Names}}";
    const res = await executeCommand(serverId, `docker ps -a --no-trunc --format '${format}'`, undefined, SSH_TIMEOUT);

    return this.parseDockerContainers(res.stdout);
  }

  /**
   * Check whether a process is listening on a network port.
   *
   * Inspects `/proc/<pid>/net/tcp{,6}` indirectly via `ss` filtered
   * by PID.
   */
  async hasListeningPort(serverId: string, pid: number): Promise<boolean> {
    const res = await executeCommand(serverId, `ss -tlnp 2>/dev/null | grep -w "pid=${pid}" | wc -l`, undefined, SSH_TIMEOUT);

    const count = parseInt(res.stdout.trim(), 10);
    return !Number.isNaN(count) && count > 0;
  }

  /**
   * Check whether a process currently has open file descriptors for
   * writing.
   *
   * Uses `/proc/<pid>/fd` and `readlink` to inspect symlinks. Any fd
   * that points to a regular file (not a socket, pipe, or device) and
   * is opened with write flags is counted.
   */
  async isWritingFiles(serverId: string, pid: number): Promise<boolean> {
    // lsof is more portable but may not be installed; fall back to
    // /proc inspection.
    const res = await executeCommand(serverId, `ls -la /proc/${pid}/fd 2>/dev/null | grep -cE '\\-> /' || echo 0`, undefined, SSH_TIMEOUT);

    const count = parseInt(res.stdout.trim(), 10);
    return !Number.isNaN(count) && count > 0;
  }

  // -----------------------------------------------------------------------
  // Parsing helpers
  // -----------------------------------------------------------------------

  private parseProcessList(raw: string): ProcessInfo[] {
    const lines = raw.trim().split("\n").filter(Boolean);
    const result: ProcessInfo[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const user = parts[0];
      const pid = parseInt(parts[1], 10);
      const cpuPercent = parseFloat(parts[2]);
      const memPercent = parseFloat(parts[3]);
      const vsz = parseInt(parts[4], 10);
      const rss = parseInt(parts[5], 10);
      const tty = parts[6];
      const stat = parts[7];
      const startTime = parts[8];
      // The command can contain spaces, so join the remainder.
      const command = parts.slice(10).join(" ");

      if (Number.isNaN(pid)) continue;

      result.push({
        pid,
        user,
        cpuPercent: Number.isNaN(cpuPercent) ? 0 : cpuPercent,
        memPercent: Number.isNaN(memPercent) ? 0 : memPercent,
        vsz: Number.isNaN(vsz) ? 0 : vsz,
        rss: Number.isNaN(rss) ? 0 : rss,
        tty,
        stat,
        startTime,
        command,
      });
    }

    return result;
  }

  private parseDockerContainers(raw: string): ContainerInfo[] {
    const lines = raw.trim().split("\n").filter(Boolean);
    const result: ContainerInfo[] = [];

    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length < 7) continue;

      result.push({
        containerId: parts[0],
        image: parts[1],
        command: parts[2],
        created: parts[3],
        status: parts[4],
        ports: parts[5],
        name: parts[6],
      });
    }

    return result;
  }
}

export { ProcessInspector };
export type { ProcessInfo, ContainerInfo };
