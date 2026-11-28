//! Windows the frontend opens for detached views (see `create_main_window`).

use tauri::{AppHandle, Manager};

/// Close the detached view window titled `title`. `window.close()` from the
/// opener does not: these are native windows created in answer to
/// `window.open`.
#[tauri::command]
pub fn close_detached_window(app: AppHandle, title: String) -> crate::utils::error::Result<()> {
    for (label, window) in app.webview_windows() {
        if !label.starts_with("detached-") {
            continue;
        }
        if window.title()? == title {
            window.destroy()?;
        }
    }
    Ok(())
}
