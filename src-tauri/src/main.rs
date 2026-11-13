#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Before anything else: may re-execute the process with ONNX Runtime's
    // CUDA provider on LD_LIBRARY_PATH (Linux, once downloaded).
    #[cfg(not(target_os = "android"))]
    didascalie_lib::reexec_with_runtime();
    // No `tracing_subscriber::fmt::init()`: it installs a global `log` logger,
    // and `tauri_plugin_log` then fails to install its own at startup.
    unsafe {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--ignore-gpu-blocklist",
        );
        std::env::set_var("RUST_LOG", "ort=debug");
    }
    didascalie_lib::run();
}