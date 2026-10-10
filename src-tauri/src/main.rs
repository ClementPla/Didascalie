#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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