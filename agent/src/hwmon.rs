//! Hardware monitoring readers — temperatures and fan RPM.
//!
//! Phase 1 is read-only. Phase 2 (fan control) will live next to this
//! file in a separate module so the unsafe-IOKit-write surface stays
//! contained.
//!
//! Platform split:
//!   * Linux  — sysinfo's `Components` API (a thin wrapper over
//!     `/sys/class/hwmon`) for temperatures, plus a direct sysfs walk for
//!     fan RPM (sysinfo doesn't surface fans).
//!   * macOS  — direct IOKit/SMC FFI. Read keys `TC0P` (CPU prox temp),
//!     `TG0P`/`TG0D` (GPU temp), `FNum` (fan count), `F<n>Ac` (fan RPM).
//!     The macOS build is cfg-gated so the Linux musl target doesn't see
//!     the IOKit FFI at all.

use serde::{Deserialize, Serialize};

/// Single fan reading. Bundled into the heartbeat's `fans` array.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FanReading {
    /// Human label — "fan1" / "cpu_fan" on Linux, "Fan 0" on macOS.
    /// Whatever the sensor exposes; never empty.
    pub name: String,
    pub rpm: u32,
}

/// Bundle returned to the collector each heartbeat.
#[derive(Debug, Clone, Default)]
pub struct HwSnapshot {
    pub cpu_temp_c: Option<f32>,
    pub gpu_temp_c: Option<f32>,
    pub fans: Vec<FanReading>,
}

/// Fan control command coming from the dashboard via the heartbeat
/// response. Applied immediately by the reporter; failures are logged
/// and the command is treated as best-effort (Apple Silicon may reject
/// SMC writes without entitlements, certain Linux boards expose
/// pwmN_input but reject pwmN writes).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum FanCommand {
    /// Hand fans back to OS / firmware control.
    Auto,
    /// Pin fans to a specific RPM (clamped against the hardware's safe
    /// range — the agent reads the min/max from SMC on macOS, ignores
    /// the value on Linux PWM and just maps to duty cycle).
    Manual { rpm: u32 },
    /// Peg fans to the hardware maximum.
    Max,
}

/// Result of applying a FanCommand. Logged at info level and surfaced
/// back to the dashboard in the next heartbeat. We don't fail the
/// heartbeat loop on a fan-write error — that would tank monitoring for
/// a feature that's expected to be platform-dependent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FanApplyOutcome {
    /// Mode that ended up applied. May differ from the requested mode if
    /// the platform rejected the write (in which case `error` is set
    /// and `applied` is `Auto`).
    pub applied: String,
    /// RPM that ended up applied (after clamping). None for Auto.
    pub applied_rpm: Option<u32>,
    /// Set when the write failed. Free-form, surfaced in the dashboard.
    pub error: Option<String>,
}

/// Apply a FanCommand on the local host. Always returns an outcome —
/// errors are reported via the `error` field rather than the Result.
pub fn apply_fan(cmd: &FanCommand) -> FanApplyOutcome {
    #[cfg(target_os = "linux")]
    {
        linux::apply_fan(cmd)
    }
    #[cfg(target_os = "macos")]
    {
        macos::apply_fan(cmd)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = cmd;
        FanApplyOutcome {
            applied: "auto".into(),
            applied_rpm: None,
            error: Some("fan control unsupported on this platform".into()),
        }
    }
}

/// Best-effort "restore fans to OS control" hook. Called from the
/// agent's graceful-shutdown path so a stopped agent never leaves fans
/// pinned at a manual value. Errors are swallowed (logged at warn) —
/// if SMC rejects the write here, the OS will eventually reassert
/// control anyway via firmware fallback.
pub fn restore_fans_to_auto() {
    let outcome = apply_fan(&FanCommand::Auto);
    if let Some(err) = outcome.error {
        tracing::warn!(error = %err, "could not restore fans to auto on shutdown");
    } else {
        tracing::info!("restored fans to auto on shutdown");
    }
}

/// Collect temps + fans. `gpu_present` short-circuits the GPU branch on
/// hosts where the installer determined there's no usable GPU.
pub fn collect(gpu_present: bool) -> HwSnapshot {
    #[cfg(target_os = "linux")]
    {
        linux::collect(gpu_present)
    }
    #[cfg(target_os = "macos")]
    {
        macos::collect(gpu_present)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = gpu_present;
        HwSnapshot::default()
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{FanApplyOutcome, FanCommand, FanReading, HwSnapshot};
    use sysinfo::Components;
    use tracing::trace;

    /// Substring matches for CPU thermal sensors. Case-insensitive. The
    /// label coming out of sysinfo on Linux is whatever the kernel
    /// hwmon/thermal driver exposes, so the same physical sensor can
    /// surface as "Package id 0" on Intel, "Tdie" or "Tctl" on Ryzen,
    /// "cpu_thermal" on a Pi.
    const CPU_LABELS: &[&str] = &[
        "coretemp", "package id", "k10temp", "tdie", "tctl",
        "cpu_thermal", "cpu-thermal", "soc_thermal",
    ];
    /// Substring matches for GPU thermal sensors.
    const GPU_LABELS: &[&str] = &["amdgpu", "nouveau", "nvidia", "radeon"];

    pub fn collect(gpu_present: bool) -> HwSnapshot {
        let components = Components::new_with_refreshed_list();

        let mut cpu_temp: Option<f32> = None;
        let mut gpu_temp: Option<f32> = None;

        for c in components.list() {
            let label_lower = c.label().to_lowercase();
            let temp = c.temperature();
            // sysinfo 0.33 returns Option<f32>; reject NaN/sentinel zeros
            // that some drivers emit when no probe is connected.
            let Some(t) = temp else { continue };
            if !t.is_finite() || t < -50.0 || t > 200.0 {
                continue;
            }
            if cpu_temp.is_none() && CPU_LABELS.iter().any(|k| label_lower.contains(k)) {
                cpu_temp = Some(t);
            }
            if gpu_present && gpu_temp.is_none()
                && GPU_LABELS.iter().any(|k| label_lower.contains(k))
            {
                gpu_temp = Some(t);
            }
        }

        // nvidia-smi fallback. Skip entirely when the installer found no
        // GPU. We also skip when sysinfo already gave us a number — the
        // subprocess is the slow path.
        if gpu_present && gpu_temp.is_none() {
            gpu_temp = read_nvidia_smi_temp();
        }

        // Last-ditch CPU fallback for hosts where sysinfo's hwmon scrape
        // misses the SoC thermal zone (older Pi kernels). Read
        // /sys/class/thermal/thermal_zone0/temp directly.
        if cpu_temp.is_none() {
            cpu_temp = read_thermal_zone0();
        }

        let fans = read_fans();

        trace!(?cpu_temp, ?gpu_temp, fan_count = fans.len(), "hwmon snapshot");
        HwSnapshot { cpu_temp_c: cpu_temp, gpu_temp_c: gpu_temp, fans }
    }

    fn read_nvidia_smi_temp() -> Option<f32> {
        let out = std::process::Command::new("nvidia-smi")
            .args(["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        // Multi-GPU rigs print one line per card. Take the hottest.
        s.lines()
            .filter_map(|line| line.trim().parse::<f32>().ok())
            .filter(|t| t.is_finite())
            .fold(None, |acc: Option<f32>, t| Some(acc.map_or(t, |x| x.max(t))))
    }

    fn read_thermal_zone0() -> Option<f32> {
        let raw = std::fs::read_to_string("/sys/class/thermal/thermal_zone0/temp").ok()?;
        let milli: i32 = raw.trim().parse().ok()?;
        let c = milli as f32 / 1000.0;
        if c.is_finite() && c > -50.0 && c < 200.0 { Some(c) } else { None }
    }

    /// Walk `/sys/class/hwmon/hwmon*/fan*_input`. Each `_input` file holds
    /// the current RPM as a decimal integer. We skip readings of `0`
    /// because most drivers emit zero when a header has no fan connected.
    fn read_fans() -> Vec<FanReading> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir("/sys/class/hwmon") else {
            return out;
        };

        for chip in entries.flatten() {
            // Chip-wide "name" file (e.g. "nct6798", "thinkpad", "applesmc").
            let chip_name = std::fs::read_to_string(chip.path().join("name"))
                .ok()
                .map(|s| s.trim().to_string())
                .unwrap_or_default();

            let Ok(files) = std::fs::read_dir(chip.path()) else {
                continue;
            };
            for f in files.flatten() {
                let fname = f.file_name();
                let fname = fname.to_string_lossy();
                let Some(rest) = fname.strip_prefix("fan") else {
                    continue;
                };
                let Some(idx_str) = rest.strip_suffix("_input") else {
                    continue;
                };
                let raw = match std::fs::read_to_string(f.path()) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let rpm: u32 = match raw.trim().parse() {
                    Ok(n) => n,
                    Err(_) => continue,
                };
                if rpm == 0 {
                    continue;
                }

                // Optional per-fan label (`fanN_label`). Falls back to
                // "<chip>/fanN" so the UI never shows an empty string.
                let label_path = chip.path().join(format!("fan{idx_str}_label"));
                let label = std::fs::read_to_string(&label_path)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| {
                        if chip_name.is_empty() {
                            format!("fan{idx_str}")
                        } else {
                            format!("{chip_name}/fan{idx_str}")
                        }
                    });

                out.push(FanReading { name: label, rpm });
            }
        }
        out
    }

    /// Walk hwmon and apply a fan command via PWM. On Linux the
    /// duty-cycle / RPM mapping is firmware-dependent; we accept an RPM
    /// value as a fraction of the *maximum reported RPM observed so
    /// far* and map linearly to 0..255 PWM. "max" writes 255 directly;
    /// "auto" writes 2 (kernel auto) to pwm*_enable.
    ///
    /// The first writable pwm channel we find wins. Many boards expose
    /// pwm*_enable but reject writes from userland unless certain BIOS
    /// settings are flipped — we accept that and surface the OS error.
    pub fn apply_fan(cmd: &FanCommand) -> FanApplyOutcome {
        let chips = match std::fs::read_dir("/sys/class/hwmon") {
            Ok(d) => d,
            Err(e) => {
                return FanApplyOutcome {
                    applied: "auto".into(),
                    applied_rpm: None,
                    error: Some(format!("no /sys/class/hwmon: {e}")),
                };
            }
        };

        let mut last_err: Option<String> = None;
        for chip in chips.flatten() {
            let Ok(files) = std::fs::read_dir(chip.path()) else { continue };
            for f in files.flatten() {
                let name = f.file_name();
                let s = name.to_string_lossy();
                let Some(rest) = s.strip_prefix("pwm") else { continue };
                // Only `pwm1` / `pwm2` / ... (no `_enable`/`_mode` suffix).
                if !rest.chars().all(|c| c.is_ascii_digit()) { continue; }
                let pwm_path = f.path();
                let enable_path = chip.path().join(format!("pwm{rest}_enable"));

                let res = match cmd {
                    FanCommand::Auto => {
                        // pwmN_enable=2 = kernel-managed auto on most drivers.
                        std::fs::write(&enable_path, "2\n")
                    }
                    FanCommand::Max => {
                        let _ = std::fs::write(&enable_path, "1\n");
                        std::fs::write(&pwm_path, "255\n")
                    }
                    FanCommand::Manual { rpm } => {
                        // Without a known max RPM curve this is necessarily
                        // approximate. Treat 5000 RPM as a reasonable
                        // upper bound for desktop fans and map linearly.
                        let duty = ((*rpm as f32 / 5000.0).clamp(0.0, 1.0) * 255.0) as u8;
                        let _ = std::fs::write(&enable_path, "1\n");
                        std::fs::write(&pwm_path, format!("{duty}\n"))
                    }
                };

                match res {
                    Ok(()) => {
                        let (applied, applied_rpm) = match cmd {
                            FanCommand::Auto => ("auto".to_string(), None),
                            FanCommand::Manual { rpm } => ("manual".into(), Some(*rpm)),
                            FanCommand::Max => ("max".into(), None),
                        };
                        return FanApplyOutcome { applied, applied_rpm, error: None };
                    }
                    Err(e) => {
                        last_err = Some(format!("{}: {e}", pwm_path.display()));
                    }
                }
            }
        }

        FanApplyOutcome {
            applied: "auto".into(),
            applied_rpm: None,
            error: Some(last_err.unwrap_or_else(|| "no writable pwm channel found".into())),
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    //! Apple SMC reader via IOKit. Read-only: temperature keys and fan
    //! RPM. The code uses a small handwritten FFI so we don't pull in
    //! `core-foundation`/`io-kit-sys` just for sensor reads. Phase 2 (fan
    //! control) will need the write-path versions of `IOConnectCallStructMethod`
    //! and bring corresponding bounds-checking with it.
    //!
    //! Untested on real Apple Silicon hardware in this codebase — the
    //! key codes (`TC0P`, `TG0P`, `F0Ac`, `FNum`) are well-documented
    //! public SMC keys that have been stable from Intel through M-series.
    //! If a key isn't present on a given chip generation, the read
    //! returns `Err` and we yield `None`/empty — never panicking.

    use super::{FanApplyOutcome, FanCommand, FanReading, HwSnapshot};
    use std::os::raw::{c_char, c_int, c_uint, c_void};

    // Minimal Mach / IOKit type aliases. Kept here rather than pulling
    // `mach2` to avoid a new heavy dep for a few FFI calls.
    type KernReturn = c_int;
    type IoService = c_uint;
    type IoConnect = c_uint;
    type MachPort = c_uint;
    type CFDictionaryRef = *const c_void;
    type IoName = [c_char; 128];

    const KERN_SUCCESS: KernReturn = 0;
    const K_IO_MASTER_PORT_DEFAULT: MachPort = 0;
    const K_SMC_CMD_READ_BYTES: u8 = 5;
    const K_SMC_CMD_WRITE_BYTES: u8 = 6;
    const K_SMC_CMD_READ_KEYINFO: u8 = 9;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct SmcKeyData {
        key: u32,
        vers: SmcKeyDataVers,
        p_limit_data: SmcKeyDataLimit,
        key_info: SmcKeyDataInfo,
        result: u8,
        status: u8,
        data8: u8,
        data32: u32,
        bytes: [u8; 32],
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct SmcKeyDataVers {
        major: u8,
        minor: u8,
        build: u8,
        reserved: u8,
        release: u16,
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct SmcKeyDataLimit {
        version: u16,
        length: u16,
        cpu_plimit: u32,
        gpu_plimit: u32,
        mem_plimit: u32,
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct SmcKeyDataInfo {
        data_size: u32,
        data_type: u32,
        data_attributes: u8,
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> CFDictionaryRef;
        fn IOServiceGetMatchingService(
            master_port: MachPort,
            matching: CFDictionaryRef,
        ) -> IoService;
        fn IOObjectRelease(obj: IoService) -> KernReturn;
        fn IOServiceOpen(
            service: IoService,
            owning_task: MachPort,
            typ: u32,
            connect: *mut IoConnect,
        ) -> KernReturn;
        fn IOServiceClose(connect: IoConnect) -> KernReturn;
        fn IOConnectCallStructMethod(
            connection: IoConnect,
            selector: u32,
            input_struct: *const c_void,
            input_struct_cnt: usize,
            output_struct: *mut c_void,
            output_struct_cnt: *mut usize,
        ) -> KernReturn;
        fn mach_task_self() -> MachPort;
    }

    /// Encode a 4-char ASCII string as a big-endian u32 the way SMC
    /// expects (`"TC0P"` → 0x54433050).
    fn fourcc(key: &[u8; 4]) -> u32 {
        ((key[0] as u32) << 24)
            | ((key[1] as u32) << 16)
            | ((key[2] as u32) << 8)
            | (key[3] as u32)
    }

    struct Smc {
        connect: IoConnect,
    }

    impl Smc {
        fn open() -> Option<Self> {
            unsafe {
                let name = b"AppleSMC\0".as_ptr() as *const c_char;
                let matching = IOServiceMatching(name);
                if matching.is_null() {
                    return None;
                }
                let service = IOServiceGetMatchingService(K_IO_MASTER_PORT_DEFAULT, matching);
                if service == 0 {
                    return None;
                }
                let mut connect: IoConnect = 0;
                let rc = IOServiceOpen(service, mach_task_self(), 0, &mut connect);
                IOObjectRelease(service);
                if rc != KERN_SUCCESS {
                    return None;
                }
                Some(Smc { connect })
            }
        }

        fn read_key(&self, key: &[u8; 4]) -> Option<(SmcKeyDataInfo, [u8; 32])> {
            unsafe {
                let mut input = SmcKeyData::default();
                let mut output = SmcKeyData::default();
                let mut out_size = std::mem::size_of::<SmcKeyData>();

                input.key = fourcc(key);
                input.data8 = K_SMC_CMD_READ_KEYINFO;
                let rc = IOConnectCallStructMethod(
                    self.connect,
                    2,
                    &input as *const _ as *const c_void,
                    std::mem::size_of::<SmcKeyData>(),
                    &mut output as *mut _ as *mut c_void,
                    &mut out_size,
                );
                if rc != KERN_SUCCESS {
                    return None;
                }
                let info = output.key_info;

                let mut input2 = SmcKeyData::default();
                let mut output2 = SmcKeyData::default();
                let mut out_size2 = std::mem::size_of::<SmcKeyData>();
                input2.key = fourcc(key);
                input2.key_info = info;
                input2.data8 = K_SMC_CMD_READ_BYTES;
                let rc2 = IOConnectCallStructMethod(
                    self.connect,
                    2,
                    &input2 as *const _ as *const c_void,
                    std::mem::size_of::<SmcKeyData>(),
                    &mut output2 as *mut _ as *mut c_void,
                    &mut out_size2,
                );
                if rc2 != KERN_SUCCESS {
                    return None;
                }
                Some((info, output2.bytes))
            }
        }

        /// Decode an SMC value as f32. Handles the two type codes we care
        /// about for sensors: `sp78` (signed 8.8 fixed-point, used for
        /// temps) and `flt ` (IEEE-754 float, used for newer fan keys).
        fn read_f32(&self, key: &[u8; 4]) -> Option<f32> {
            let (info, bytes) = self.read_key(key)?;
            let type_str = info.data_type.to_be_bytes();
            // "sp78" — 16-bit signed fixed-point, 8 integer + 8 fraction.
            if &type_str == b"sp78" && info.data_size >= 2 {
                let raw = i16::from_be_bytes([bytes[0], bytes[1]]);
                return Some(raw as f32 / 256.0);
            }
            // "flt " — 32-bit float (little-endian per SMC convention).
            if &type_str == b"flt " && info.data_size >= 4 {
                let raw =
                    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                return Some(f32::from_bits(raw));
            }
            // "ui16"/"ui32" — unsigned ints, treat as plain value.
            if &type_str == b"ui16" && info.data_size >= 2 {
                return Some(u16::from_be_bytes([bytes[0], bytes[1]]) as f32);
            }
            if &type_str == b"ui32" && info.data_size >= 4 {
                return Some(
                    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32,
                );
            }
            // "ui8 " — single byte, used by FNum.
            if &type_str == b"ui8 " && info.data_size >= 1 {
                return Some(bytes[0] as f32);
            }
            None
        }
    }

    impl Smc {
        /// Write raw bytes to an SMC key. `bytes` must be at least
        /// `info.data_size` long; only the first `data_size` bytes get
        /// shipped to the SMC. Returns Err with the kernel return code
        /// on failure — Apple Silicon often rejects writes from
        /// non-entitled processes (kIOReturnNotPrivileged = 0xE00002C1).
        fn write_key(&self, key: &[u8; 4], bytes: &[u8]) -> Result<(), String> {
            unsafe {
                // First fetch key info so the SMC knows the type/size.
                let mut info_in = SmcKeyData::default();
                let mut info_out = SmcKeyData::default();
                let mut info_size = std::mem::size_of::<SmcKeyData>();
                info_in.key = fourcc(key);
                info_in.data8 = K_SMC_CMD_READ_KEYINFO;
                let rc = IOConnectCallStructMethod(
                    self.connect,
                    2,
                    &info_in as *const _ as *const c_void,
                    std::mem::size_of::<SmcKeyData>(),
                    &mut info_out as *mut _ as *mut c_void,
                    &mut info_size,
                );
                if rc != KERN_SUCCESS {
                    return Err(format!("SMC read_keyinfo({:?}) rc=0x{:x}", std::str::from_utf8(key).unwrap_or("?"), rc));
                }
                let info = info_out.key_info;
                let n = (info.data_size as usize).min(32).min(bytes.len());
                if n == 0 {
                    return Err("SMC reported zero-length key".into());
                }

                let mut write_in = SmcKeyData::default();
                let mut write_out = SmcKeyData::default();
                let mut write_size = std::mem::size_of::<SmcKeyData>();
                write_in.key = fourcc(key);
                write_in.key_info = info;
                write_in.data8 = K_SMC_CMD_WRITE_BYTES;
                write_in.bytes[..n].copy_from_slice(&bytes[..n]);
                let rc = IOConnectCallStructMethod(
                    self.connect,
                    2,
                    &write_in as *const _ as *const c_void,
                    std::mem::size_of::<SmcKeyData>(),
                    &mut write_out as *mut _ as *mut c_void,
                    &mut write_size,
                );
                if rc != KERN_SUCCESS {
                    return Err(format!(
                        "SMC write({:?}) rc=0x{:x}",
                        std::str::from_utf8(key).unwrap_or("?"),
                        rc
                    ));
                }
                Ok(())
            }
        }

        /// Convenience: encode an f32 as SMC `flt ` (32-bit LE float)
        /// and write it. Apple Silicon SMC accepts the same encoding for
        /// fan target keys (F0Tg etc.) as Intel-era Macs.
        fn write_f32(&self, key: &[u8; 4], value: f32) -> Result<(), String> {
            let bytes = value.to_le_bytes();
            self.write_key(key, &bytes)
        }
    }

    impl Drop for Smc {
        fn drop(&mut self) {
            unsafe {
                IOServiceClose(self.connect);
            }
        }
    }

    /// Apply a fan command via SMC.
    ///
    /// The SMC keys we touch:
    ///   * `FS! ` — bitmask of fans under manual override. Bit N = fan N.
    ///   * `F0Tg` — fan 0 target RPM.
    ///   * `F0Mn` / `F0Mx` — fan 0 min/max RPM (read-only, for clamping).
    ///
    /// Apple Silicon does honour these keys for sensor reads. Writes
    /// are less guaranteed — newer macOS may require entitlements that
    /// our binary doesn't carry, in which case the write returns
    /// kIOReturnNotPrivileged and we surface the error.
    pub fn apply_fan(cmd: &FanCommand) -> FanApplyOutcome {
        let smc = match Smc::open() {
            Some(s) => s,
            None => {
                return FanApplyOutcome {
                    applied: "auto".into(),
                    applied_rpm: None,
                    error: Some("could not open AppleSMC".into()),
                };
            }
        };

        // Read fan 0's safe range so manual targets get clamped against
        // Apple's own minimum (the user can't accidentally pin fans
        // below the firmware's safe floor and cook the chip).
        let min_rpm = smc.read_f32(b"F0Mn").map(|f| f as u32);
        let max_rpm = smc.read_f32(b"F0Mx").map(|f| f as u32);

        let res: Result<(String, Option<u32>), String> = match cmd {
            FanCommand::Auto => {
                // Clear the manual-override bit. Setting FS! to 0 hands
                // fan 0 back to the SMC's own curves.
                smc.write_key(b"FS! ", &[0x00, 0x00]).map(|_| ("auto".into(), None))
            }
            FanCommand::Max => {
                let mx = max_rpm.unwrap_or(5500);
                smc.write_key(b"FS! ", &[0x00, 0x01])
                    .and_then(|_| smc.write_f32(b"F0Tg", mx as f32))
                    .map(|_| ("max".into(), Some(mx)))
            }
            FanCommand::Manual { rpm } => {
                let lo = min_rpm.unwrap_or(0);
                let hi = max_rpm.unwrap_or(*rpm);
                let clamped = (*rpm).clamp(lo, hi);
                smc.write_key(b"FS! ", &[0x00, 0x01])
                    .and_then(|_| smc.write_f32(b"F0Tg", clamped as f32))
                    .map(|_| ("manual".into(), Some(clamped)))
            }
        };

        match res {
            Ok((applied, applied_rpm)) => FanApplyOutcome { applied, applied_rpm, error: None },
            Err(e) => FanApplyOutcome {
                applied: "auto".into(),
                applied_rpm: None,
                error: Some(e),
            },
        }
    }

    pub fn collect(gpu_present: bool) -> HwSnapshot {
        let Some(smc) = Smc::open() else {
            return HwSnapshot::default();
        };

        // CPU temperature. The Intel-era keys (TC0P/TC0D) don't exist on
        // Apple Silicon; M-series exposes per-cluster keys instead. We
        // try the broadly-compatible names first, then walk a list of
        // M-series per-cluster keys and take the hottest reading we
        // find — useful because a single "the temp" doesn't really
        // exist on M-series (multiple P/E clusters + die sensors).
        let valid = |t: &f32| t.is_finite() && *t > -50.0 && *t < 200.0;
        let cpu_intel = smc.read_f32(b"TC0P").or_else(|| smc.read_f32(b"TC0D"));
        // Apple Silicon "Tp0X" P-cluster + "Te0X" E-cluster probes. Not
        // every chip generation exposes every key, but at least one of
        // these typically returns a value on M1/M2/M3/M4 Mac minis.
        const M_SERIES_CPU_KEYS: &[&[u8; 4]] = &[
            b"Tp01", b"Tp02", b"Tp03", b"Tp04", b"Tp05",
            b"Tp09", b"Tp0D", b"Tp0H", b"Tp0L", b"Tp0Q",
            b"Te01", b"Te02", b"Te03", b"Te04",
        ];
        let cpu_apple = M_SERIES_CPU_KEYS
            .iter()
            .filter_map(|k| smc.read_f32(k))
            .filter(valid)
            .fold(None, |acc: Option<f32>, t| Some(acc.map_or(t, |x| x.max(t))));
        let cpu_temp = cpu_intel.filter(valid).or(cpu_apple);

        let gpu_temp = if gpu_present {
            let gpu_intel = smc.read_f32(b"TG0P").or_else(|| smc.read_f32(b"TG0D"));
            // M-series GPU cluster probes.
            const M_SERIES_GPU_KEYS: &[&[u8; 4]] = &[
                b"Tg05", b"Tg0D", b"Tg0H", b"Tg0L", b"Tg0Q",
            ];
            let gpu_apple = M_SERIES_GPU_KEYS
                .iter()
                .filter_map(|k| smc.read_f32(k))
                .filter(valid)
                .fold(None, |acc: Option<f32>, t| Some(acc.map_or(t, |x| x.max(t))));
            gpu_intel.filter(valid).or(gpu_apple)
        } else {
            None
        };

        // Fan count + per-fan RPM. Fans are keyed F0Ac, F1Ac, …, with
        // the count in FNum. Bound the loop defensively.
        let mut fans = Vec::new();
        let n = smc.read_f32(b"FNum").map(|f| f as u32).unwrap_or(0);
        for i in 0..n.min(8) {
            let key = [b'F', (b'0' + i as u8), b'A', b'c'];
            if let Some(rpm) = smc.read_f32(&key) {
                if rpm.is_finite() && rpm > 0.0 {
                    fans.push(FanReading {
                        name: format!("Fan {i}"),
                        rpm: rpm as u32,
                    });
                }
            }
        }

        HwSnapshot { cpu_temp_c: cpu_temp, gpu_temp_c: gpu_temp, fans }
    }
}
