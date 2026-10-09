#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // No `tracing_subscriber::fmt::init()` here: it installs a global `log`
    // logger, and `tauri_plugin_log` (see `lib.rs`) then fails to install its
    // own (`log::set_boxed_logger` allows exactly one), which takes the app
    // down at startup. ort's events still surface through tracing's `log`
    // feature.
    unsafe {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--ignore-gpu-blocklist",
        );
        std::env::set_var("RUST_LOG", "ort=debug");
    }
    didascalie_lib::run();
}