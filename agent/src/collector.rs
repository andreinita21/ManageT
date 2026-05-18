//! Resource metric collection via `sysinfo`.
//!
//! Produces a single `MetricSnapshot` per call. The snapshot is the payload
//! that the reporter POSTs to `/api/agent/heartbeat`.

use anyhow::Result;
use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{Disks, LoadAvg, Pid, ProcessesToUpdate, System};

/// A single point-in-time measurement. Field names intentionally match the
/// JSON the dashboard expects (camelCase) — serde_json handles the mapping.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricSnapshot {
    pub cpu_percent: f32,
    pub memory_used_mb: u64,
    pub memory_total_mb: u64,
    pub disk_used_percent: Option<f32>,
    pub load1m: Option<f64>,
    pub load5m: Option<f64>,
    pub load15m: Option<f64>,
    pub uptime_secs: u64,
    pub agent_version: &'static str,
    pub hostname: String,
    /// Per-session CPU/RAM. Empty when the agent has no live sessions.
    /// Older dashboards ignore the field; newer ones upsert into the
    /// `sessions` table to drive the stack-detail view.
    #[serde(default)]
    pub sessions: Vec<SessionStats>,
}

/// Resource stats for a single agent-owned PTY session, summed across the
/// shell process and all of its descendants.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub session_id: String,
    /// CPU% summed across the tree. Can exceed 100 on multi-core boxes —
    /// this matches what `htop` shows for a multi-threaded process.
    pub cpu_percent: f32,
    /// Resident set size summed across the tree, in MiB.
    pub memory_mb: u64,
    /// Number of processes counted (shell + descendants). 0 means the root
    /// PID was no longer present in the process table at sample time —
    /// the session has effectively died but `running` on the manager side
    /// hasn't flipped yet.
    pub pid_count: u32,
}

/// Collect a single snapshot, attributing CPU/RAM per session for any
/// `(session_id, root_pid)` pairs the caller passes in.
///
/// For CPU percentages — both global and per-process — `sysinfo` requires
/// two refreshes with a short gap because the first reading has no
/// baseline. We refresh twice here with a 200ms sleep in between.
pub fn collect(session_pids: &[(String, u32)]) -> MetricSnapshot {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    // Refresh processes too so per-PID CPU/RSS is available. `true` =
    // also refresh disk usage / users for each process; we don't read
    // those, but the cost is dominated by the syscall pass anyway.
    sys.refresh_processes(ProcessesToUpdate::All, true);
    // Give sysinfo a window to observe CPU deltas (both global + per-process).
    std::thread::sleep(std::time::Duration::from_millis(
        sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.as_millis() as u64 + 50,
    ));
    sys.refresh_cpu_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let cpu_percent = sys.global_cpu_usage();

    let memory_total_mb = sys.total_memory() / 1024 / 1024;
    let memory_used_mb = sys.used_memory() / 1024 / 1024;

    // Per-session attribution: build a parent->children index over the
    // process table once, then DFS from each session's root PID to sum
    // CPU + RSS across the tree. Building the index per heartbeat is O(N)
    // in the number of processes (a few hundred on these boxes), which is
    // dominated by the refresh cost above.
    let sessions = if session_pids.is_empty() {
        Vec::new()
    } else {
        let mut by_parent: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, proc) in sys.processes() {
            if let Some(ppid) = proc.parent() {
                by_parent.entry(ppid).or_default().push(*pid);
            }
        }
        session_pids
            .iter()
            .map(|(id, root_pid)| {
                let (cpu, mem_bytes, count) =
                    sum_process_tree(&sys, &by_parent, Pid::from_u32(*root_pid));
                SessionStats {
                    session_id: id.clone(),
                    cpu_percent: cpu,
                    memory_mb: mem_bytes / 1024 / 1024,
                    pid_count: count,
                }
            })
            .collect()
    };

    let LoadAvg { one, five, fifteen } = System::load_average();
    // On Windows load average is always zero — treat as None.
    let (load1m, load5m, load15m) = if one == 0.0 && five == 0.0 && fifteen == 0.0 {
        (None, None, None)
    } else {
        (Some(one), Some(five), Some(fifteen))
    };

    // Disk usage on the root filesystem. If sysinfo can't find a mountpoint
    // at "/" (macOS sometimes reports "/System/Volumes/Data" as the data
    // volume), fall back to the first disk we see.
    let disks = Disks::new_with_refreshed_list();
    let disk_used_percent = pick_root_disk(&disks).map(|(total, available)| {
        if total == 0 {
            0.0
        } else {
            let used = total.saturating_sub(available);
            (used as f64 / total as f64 * 100.0) as f32
        }
    });

    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string());

    MetricSnapshot {
        cpu_percent,
        memory_used_mb,
        memory_total_mb,
        disk_used_percent,
        load1m,
        load5m,
        load15m,
        uptime_secs: System::uptime(),
        agent_version: env!("CARGO_PKG_VERSION"),
        hostname,
        sessions,
    }
}

/// Sum cpu_usage + RSS across `root` and all of its descendants in the
/// already-refreshed process table. Returns `(cpu_percent_sum, rss_bytes_sum,
/// process_count)`.
fn sum_process_tree(
    sys: &System,
    by_parent: &HashMap<Pid, Vec<Pid>>,
    root: Pid,
) -> (f32, u64, u32) {
    let mut cpu = 0.0_f32;
    let mut mem = 0u64;
    let mut count = 0u32;
    let mut stack: Vec<Pid> = vec![root];
    while let Some(pid) = stack.pop() {
        if let Some(proc) = sys.processes().get(&pid) {
            cpu += proc.cpu_usage();
            mem += proc.memory();
            count += 1;
        }
        if let Some(kids) = by_parent.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    (cpu, mem, count)
}

/// Find the root filesystem disk. Returns `(total_bytes, available_bytes)`.
fn pick_root_disk(disks: &Disks) -> Option<(u64, u64)> {
    // First try a disk literally mounted at "/".
    for d in disks.list() {
        if d.mount_point() == std::path::Path::new("/") {
            return Some((d.total_space(), d.available_space()));
        }
    }
    // Fall back to the first disk.
    disks
        .list()
        .first()
        .map(|d| (d.total_space(), d.available_space()))
}

/// `managet-agent status` subcommand implementation — prints config + a
/// one-shot snapshot as pretty JSON so users can verify the install works.
pub fn print_status_snapshot() -> Result<()> {
    // No live SessionManager when the user runs `managet-agent status` from
    // the command line — pass an empty list so the per-session block is
    // omitted from the JSON.
    let snapshot = collect(&[]);
    let json = serde_json::to_string_pretty(&snapshot)?;
    println!("{json}");

    // Config might not exist yet (pre-install status check), so don't error.
    match crate::config::AgentConfig::load() {
        Ok(cfg) => {
            println!("\nConfig:");
            println!("  api_url:   {}", cfg.api_url_normalized());
            println!("  server_id: {}", cfg.server_id);
            println!("  interval:  {}s", cfg.heartbeat_interval_secs);
            println!("  token:     <hidden, {} chars>", cfg.token.len());
        }
        Err(e) => {
            println!("\nConfig: not loaded ({e})");
        }
    }
    Ok(())
}
