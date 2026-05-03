//! Resource metric collection via `sysinfo`.
//!
//! Produces a single `MetricSnapshot` per call. The snapshot is the payload
//! that the reporter POSTs to `/api/agent/heartbeat`.

use anyhow::Result;
use serde::Serialize;
use sysinfo::{Disks, LoadAvg, System};

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
}

/// Collect a single snapshot. This refreshes CPU and memory in one call.
///
/// For CPU percentages, `sysinfo` requires two refreshes with a short gap —
/// the first reading is always 0 because it needs a baseline. We refresh
/// twice here with a 200ms sleep in between to get a meaningful number.
pub fn collect() -> MetricSnapshot {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    // Give sysinfo a window to observe CPU deltas.
    std::thread::sleep(std::time::Duration::from_millis(
        sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.as_millis() as u64 + 50,
    ));
    sys.refresh_cpu_all();

    let cpu_percent = sys.global_cpu_usage();

    let memory_total_mb = sys.total_memory() / 1024 / 1024;
    let memory_used_mb = sys.used_memory() / 1024 / 1024;

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
    }
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
    let snapshot = collect();
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
