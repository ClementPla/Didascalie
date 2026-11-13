//! ONNX Runtime's CUDA provider for Linux releases, downloaded on demand.
//!
//! `ort` links ONNX Runtime statically, but its CUDA execution provider is two
//! shared libraries (`libonnxruntime_providers_shared.so`,
//! `libonnxruntime_providers_cuda.so`), and the bundler does not ship them.
//! They are ~190 MB, useless without an NVIDIA GPU, so they are fetched only
//! when the user asks (Model lab), from the same archive `ort-sys` builds
//! against: the provider must come from the exact ONNX Runtime build that is
//! linked in.
//!
//! ONNX Runtime opens them by bare name (`dlopen("libonnxruntime_providers_…")`)
//! and the CUDA one has no SONAME, so loading it beforehand by full path does
//! not satisfy that lookup, and glibc reads `LD_LIBRARY_PATH` only at process
//! start. [`reexec_with_runtime`] therefore runs first in `main`: when the
//! libraries are on disk, it prepends their folder to `LD_LIBRARY_PATH` and
//! re-executes the process once.
//!
//! Easily broken; see ARCHITECTURE.md ("GPU encoder on Linux"). When `ort` is
//! upgraded, [`ARCHIVE_URL`] and [`ARCHIVE_SHA256`] must follow `ort-sys`'s
//! `dist.txt`; a test compares them.

use serde::Serialize;
use std::path::PathBuf;
use ts_rs::TS;

/// Must match `identifier` in tauri.conf.json: `main` runs before Tauri, so
/// the app cache folder is derived by hand. A test compares them.
const APP_IDENTIFIER: &str = "io.github.clementpla.didascalie";

/// `ort-sys`'s `dist.txt`, row `cu12  x86_64-unknown-linux-gnu`.
#[cfg_attr(
    not(all(target_os = "linux", target_arch = "x86_64")),
    allow(dead_code)
)]
const ARCHIVE_URL: &str =
    "https://cdn.pyke.io/0/pyke:ort-rs/ms@1.22.0/x86_64-unknown-linux-gnu+cu12.tgz";
#[cfg_attr(
    not(all(target_os = "linux", target_arch = "x86_64")),
    allow(dead_code)
)]
const ARCHIVE_SHA256: &str = "8BBB8416566A668A240B72A56DBBB82F99F430AF86F64D776D7EBF53E144EFC9";
/// The archive, for the UI.
const DOWNLOAD_MB: u32 = 170;

/// The two libraries kept from the archive (it also holds a static
/// `libonnxruntime.a` and the TensorRT provider, which are dropped).
#[cfg_attr(
    not(all(target_os = "linux", target_arch = "x86_64")),
    allow(dead_code)
)]
const LIBS: [&str; 2] = [
    "libonnxruntime_providers_shared.so",
    "libonnxruntime_providers_cuda.so",
];

/// Set by [`reexec_with_runtime`] to the folder it put on `LD_LIBRARY_PATH`.
/// Inherited by a relaunch (the updater's too), hence a folder and not a flag:
/// a new release must not keep loading the previous release's providers.
const MARKER: &str = "DIDASCALIE_ORT_CUDA";

const SUPPORTED: bool = cfg!(all(target_os = "linux", target_arch = "x86_64"));

/// `<cache>/<identifier>/ort-cuda/<archive hash prefix>`: one folder per ONNX
/// Runtime build, so an `ort` upgrade never reuses stale providers.
fn runtime_dir() -> Option<PathBuf> {
    Some(
        dirs::cache_dir()?
            .join(APP_IDENTIFIER)
            .join("ort-cuda")
            .join(ARCHIVE_SHA256[..16].to_ascii_lowercase()),
    )
}

fn installed() -> bool {
    SUPPORTED && runtime_dir().is_some_and(|d| LIBS.iter().all(|lib| d.join(lib).is_file()))
}

/// Whether this process was started with the providers on its library path.
fn active() -> bool {
    match (std::env::var_os(MARKER), runtime_dir()) {
        (Some(m), Some(d)) => installed() && m == d.as_os_str(),
        _ => false,
    }
}

/// An NVIDIA driver is installed: `libcuda.so.1` loads.
fn nvidia_driver() -> bool {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        // SAFETY: the driver library has no initialisers with preconditions;
        // burn's CUDA backend opens it in this process anyway.
        unsafe { libloading::Library::new("libcuda.so.1") }.is_ok()
    }
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    false
}

/// Called first thing in `main`. Re-executes the process with the providers'
/// folder on `LD_LIBRARY_PATH` when they are installed, and without a folder a
/// previous process (another release) put there. Otherwise returns.
pub fn reexec_with_runtime() {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        use std::os::unix::process::CommandExt;

        let previous = std::env::var_os(MARKER).map(PathBuf::from);
        let target = if installed() { runtime_dir() } else { None };
        if previous == target {
            return;
        }

        let mut paths: Vec<PathBuf> = std::env::var_os("LD_LIBRARY_PATH")
            .map(|v| std::env::split_paths(&v).collect())
            .unwrap_or_default();
        paths.retain(|p| Some(p) != previous.as_ref() && !p.as_os_str().is_empty());
        if let Some(dir) = &target {
            paths.insert(0, dir.clone());
        }

        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let mut cmd = std::process::Command::new(exe);
        cmd.args(std::env::args_os().skip(1));
        match std::env::join_paths(&paths) {
            Ok(joined) if !paths.is_empty() => cmd.env("LD_LIBRARY_PATH", joined),
            _ => cmd.env_remove("LD_LIBRARY_PATH"),
        };
        match &target {
            Some(dir) => cmd.env(MARKER, dir),
            None => cmd.env_remove(MARKER),
        };
        // Only returns on failure; the app then starts without the providers.
        let err = cmd.exec();
        eprintln!("[ml] could not restart with the GPU runtime: {err}");
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct GpuRuntimeStatus {
    /// A Linux build on a machine with an NVIDIA driver: the download is worth
    /// offering.
    pub available: bool,
    /// The providers are on disk.
    pub installed: bool,
    /// This process started with them; otherwise a restart is needed.
    pub active: bool,
    pub download_mb: u32,
}

#[tauri::command]
pub fn ml_gpu_runtime_status() -> GpuRuntimeStatus {
    GpuRuntimeStatus {
        available: SUPPORTED && nvidia_driver(),
        installed: installed(),
        active: active(),
        download_mb: DOWNLOAD_MB,
    }
}

/// Download the archive, check its hash, keep the two providers. Progress
/// arrives on `download-progress`. Takes effect at the next start.
#[tauri::command]
pub async fn ml_install_gpu_runtime(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        install(&app).await
    }
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    {
        let _ = app;
        Err("the GPU runtime download exists only for Linux x86-64".into())
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
async fn install(app: &tauri::AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;

    if installed() {
        return Ok(());
    }
    let dir = runtime_dir().ok_or("no cache folder")?;
    let parent = dir.parent().ok_or("no cache folder")?.to_path_buf();
    tokio::fs::create_dir_all(&parent)
        .await
        .map_err(|e| format!("create {}: {e}", parent.display()))?;
    let archive = parent.join("download.tgz.part");

    log::info!("[ml] downloading the CUDA provider from {ARCHIVE_URL}");
    let client = reqwest::Client::builder()
        .user_agent("didascalie")
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let response = client
        .get(ARCHIVE_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download failed: {e}"))?;
    let total = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&archive)
        .await
        .map_err(|e| format!("create {}: {e}", archive.display()))?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write {}: {e}", archive.display()))?;
        done += chunk.len() as u64;
        if total > 0 && (done - last_emit >= total / 50 || done == total) {
            last_emit = done;
            let _ = app.emit(
                "download-progress",
                serde_json::json!({
                    "filename": "GPU runtime",
                    "progress": done as f64 / total as f64 * 100.0,
                    "downloaded": done,
                    "total": total,
                }),
            );
        }
    }
    file.flush().await.map_err(|e| format!("write: {e}"))?;
    drop(file);

    let actual: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();
    if !actual.eq_ignore_ascii_case(ARCHIVE_SHA256) {
        let _ = tokio::fs::remove_file(&archive).await;
        return Err(format!(
            "GPU runtime checksum mismatch: expected {ARCHIVE_SHA256}, got {actual}"
        ));
    }

    let result = tokio::task::spawn_blocking({
        let archive = archive.clone();
        move || extract(&archive, &dir)
    })
    .await
    .map_err(|e| format!("extraction: {e}"))?;
    let _ = std::fs::remove_file(&archive);
    result?;
    log::info!("[ml] CUDA provider installed; it is used from the next start");
    Ok(())
}

/// Keep [`LIBS`] from the archive, into a fresh folder renamed into place, and
/// drop folders of other ONNX Runtime builds.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn extract(archive: &std::path::Path, dir: &std::path::Path) -> Result<(), String> {
    let parent = dir.parent().ok_or("no cache folder")?;
    let staging = parent.join("staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("create staging: {e}"))?;

    let file = std::fs::File::open(archive).map_err(|e| format!("open archive: {e}"))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut found = 0;
    for entry in tar.entries().map_err(|e| format!("read archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("read archive: {e}"))?;
        let path = entry.path().map_err(|e| format!("read archive: {e}"))?;
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        if !LIBS.contains(&name.as_str()) || !entry.header().entry_type().is_file() {
            continue;
        }
        // By file name only: nothing in the archive picks where it lands.
        let mut out =
            std::fs::File::create(staging.join(&name)).map_err(|e| format!("write {name}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("write {name}: {e}"))?;
        found += 1;
    }
    if found != LIBS.len() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("the archive does not contain the CUDA provider".into());
    }

    for old in std::fs::read_dir(parent).into_iter().flatten().flatten() {
        let p = old.path();
        if p.is_dir() && p != staging {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
    std::fs::rename(&staging, dir).map_err(|e| format!("install: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_IDENTIFIER);
    }

    /// The pinned archive is the one `ort-sys` was built from: bump both
    /// constants when `ort` is upgraded.
    #[test]
    fn archive_matches_ort_sys() {
        let lock = include_str!("../../../Cargo.lock");
        let version = lock
            .split("[[package]]")
            .find(|p| p.contains("name = \"ort-sys\""))
            .and_then(|p| p.lines().find_map(|l| l.strip_prefix("version = \"")))
            .map(|v| v.trim_end_matches('"').to_string())
            .expect("ort-sys in Cargo.lock");
        let cargo_home = std::env::var_os("CARGO_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".cargo")))
            .expect("CARGO_HOME");
        let dist = std::fs::read_dir(cargo_home.join("registry/src"))
            .expect("cargo registry sources")
            .flatten()
            .map(|d| d.path().join(format!("ort-sys-{version}/dist.txt")))
            .find(|p| p.is_file())
            .expect("ort-sys dist.txt in the cargo registry");
        let dist = std::fs::read_to_string(dist).unwrap();
        let row = dist
            .lines()
            .map(|l| l.split('\t').collect::<Vec<_>>())
            .find(|c| c.len() == 4 && c[0] == "cu12" && c[1] == "x86_64-unknown-linux-gnu")
            .expect("cu12 Linux row in dist.txt");
        assert_eq!(row[2], ARCHIVE_URL, "bump ARCHIVE_URL to ort-sys {version}");
        assert_eq!(
            row[3], ARCHIVE_SHA256,
            "bump ARCHIVE_SHA256 to ort-sys {version}"
        );
    }
}
