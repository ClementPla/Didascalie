//! The port Didascalie listens on for remote control. Kept in a file of the
//! app's config directory, since the socket is bound before any page exists;
//! a change applies at the next launch.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::utils::error::Result;
use crate::utils::AppError;

pub const DEFAULT_LISTEN_PORT: u16 = 5555;

#[derive(Serialize, Deserialize)]
struct Stored {
    listen_port: u16,
}

/// The port the receiver was started on.
pub struct ActiveListenPort(pub u16);

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("connections.json"))
}

/// The configured port, or the default when nothing valid is stored.
pub fn load_listen_port(app: &AppHandle) -> u16 {
    settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Stored>(&text).ok())
        .map(|stored| stored.listen_port)
        .unwrap_or(DEFAULT_LISTEN_PORT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenPortInfo {
    /// What the running application is bound to.
    pub active: u16,
    /// What it will bind to at the next launch.
    pub configured: u16,
}

#[tauri::command]
pub fn get_listen_port(app: AppHandle, active: State<ActiveListenPort>) -> ListenPortInfo {
    ListenPortInfo { active: active.0, configured: load_listen_port(&app) }
}

#[tauri::command]
pub fn set_listen_port(app: AppHandle, port: u16) -> Result<()> {
    if port < 1024 {
        return Err(AppError::Other("Choose a port between 1024 and 65535.".into()));
    }
    let path = settings_path(&app)
        .ok_or_else(|| AppError::Other("No configuration directory to save to.".into()))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, serde_json::to_string(&Stored { listen_port: port })?)?;
    Ok(())
}
