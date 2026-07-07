// src-tauri/src/lib.rs
use std::sync::Arc;
#[cfg(not(target_os = "android"))]
use crate::dl::feature_extract::FeaturesExtractor;
#[cfg(not(target_os = "android"))]
use crate::dl::model::ModelSessions;

use crate::connection::inference::InferenceClient;   // ← add
use crate::storage::DbState;
use tauri::{Manager, RunEvent};
use tokio::sync::Mutex;

mod commands;
mod connection;

#[cfg(not(target_os = "android"))]
mod dl;

mod utils;
mod storage;
mod superpixel;
mod types;

/// Per-OS webview tuning, applied before the webview is created.
///
/// Tauri uses the platform's native webview (WebView2/Chromium on Windows,
/// WKWebView on macOS, WebKitGTK on Linux), so the same canvas code performs
/// very differently across platforms. Windows already forces the GPU on via
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` in main.rs; this covers Linux, where
/// WebKitGTK defaults are the main lever. Every override is opt-outable so a
/// user can A/B test the effect on their own hardware.
fn configure_webview_env() {
    #[cfg(target_os = "linux")]
    {
        // Force accelerated compositing on unless the user already decided.
        if std::env::var_os("WEBKIT_FORCE_COMPOSITING_MODE").is_none() {
            // SAFETY: set before any webview/thread is spawned.
            unsafe {
                std::env::set_var("WEBKIT_FORCE_COMPOSITING_MODE", "1");
            }
        }

        // The DMABUF renderer is the fast path but corrupts on some X11 +
        // proprietary-driver setups, so we disable it there by default. Two
        // escape hatches: an explicit WEBKIT_DISABLE_DMABUF_RENDERER is never
        // overridden, and DIDASCALIE_FORCE_DMABUF=1 keeps the fast path on so
        // the perf cost of disabling it can be measured.
        let raw_force = std::env::var("DIDASCALIE_FORCE_DMABUF").ok();
        let force_dmabuf = raw_force.as_deref() == Some("1");
        let already_set = std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some();
        let x11_with_dri = std::path::Path::new("/dev/dri").exists()
            && std::env::var("WAYLAND_DISPLAY").is_err()
            && std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "x11";

        if force_dmabuf {
            // Explicit opt-in to the fast path wins, even if something upstream
            // (a wrapper, the desktop, a prior export) already disabled DMABUF.
            // SAFETY: set before any webview/thread is spawned.
            unsafe {
                std::env::remove_var("WEBKIT_DISABLE_DMABUF_RENDERER");
            }
        } else if !already_set && x11_with_dri {
            // SAFETY: set before any webview/thread is spawned.
            unsafe {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }

        eprintln!(
            "[webview] WebKitGTK: DIDASCALIE_FORCE_DMABUF={:?} -> force={} | WEBKIT_FORCE_COMPOSITING_MODE={:?} WEBKIT_DISABLE_DMABUF_RENDERER={:?}",
            raw_force,
            force_dmabuf,
            std::env::var("WEBKIT_FORCE_COMPOSITING_MODE").ok(),
            std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").ok(),
        );
    }
    // macOS (WKWebView) exposes no comparable env knobs; nothing to do here.
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_webview_env();
    let app = tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init());

    // Auto-update from GitHub releases (desktop only; the updater/process
    // plugins don't apply on mobile).
    #[cfg(desktop)]
    let app = app
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    #[cfg(not(target_os = "android"))]
    let app = app
        .manage(Arc::new(Mutex::new(FeaturesExtractor::new())))
        .manage(ModelSessions::new());
    
    let app = app.manage(DbState::new())
        .manage(InferenceClient::new())
        .manage(commands::superpixel::SuperpixelState::default())
        .setup(|app| {
            connection::coms::setup_zmq_receiver(app.handle().clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::images::create_cache_thumbnail,
            commands::images::create_thumbnail,
            commands::images::load_image_as_base64,
            commands::images::process_image_blob,
            commands::segmentation::otsu_segmentation,
            connection::connection::event_processed,
            commands::crf::crf_refine,
            commands::flood_fill::flood_fill_mask,
            commands::superpixel::superpixel_refine,
            commands::superpixel::superpixel_overlay,
            #[cfg(not(target_os = "android"))]
            commands::dl::mask_sam_segment,
            commands::io::scan_and_import_folder,
            commands::project::create_project,
            commands::project::open_project,
            commands::project::close_project,
            // Frames commands
            commands::project::get_frames_count,
            commands::project::get_sequences_count,
            commands::frame::get_progress,
            commands::frame::get_frame_image,
            commands::frame::get_frame_overview,
            commands::frame::get_frame_thumbnail,
            commands::frame::set_frames_reviewed,
            commands::frame::set_frame_reviewed,
            // Sequences commands
            commands::sequences::list_sequences,
            commands::sequences::get_sequence,
            commands::sequences::get_sequence_frames,
            commands::sequences::get_all_frame_ids_by_sequence,
            commands::sequences::get_gallery_sequences,
            commands::sequences::create_sequence,
            commands::sequences::rename_sequence,
            commands::sequences::delete_sequence,
            commands::sequences::reorder_sequences,
            commands::sequences::find_sequence_by_name,
            commands::sequences::move_frames_to_sequence,
            commands::annotation::save_annotation,
            commands::annotation::load_annotations,
            commands::vector::save_vector_annotations,
            commands::vector::load_vector_annotations,
            commands::vectorize::vectorize_component,
            commands::annotation::list_labels,
            commands::annotation::get_labels,
            // Classification commands
            commands::classification::save_classification,
            commands::classification::load_classification,
            commands::classification::save_batch_classifications,
            // Text Description commands
            commands::text_description::save_text_description,
            commands::text_description::load_text_descriptions,
            commands::text_description::delete_text_description,
            // Export commands
            commands::export::export_annotations,
            // Pluggable dataset import/export (COCO, YOLO, NIfTI, …)
            commands::dataset_io::list_dataset_formats,
            commands::dataset_io::export_dataset,
            commands::dataset_io::import_dataset,
            // Registration commands
            commands::registration::save_registration,
            commands::registration::load_registration,
            commands::registration::list_registrations,
            commands::registration::delete_registration,
            commands::registration::inference_connect,
            commands::registration::find_keypoints_prefill,


        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");
    // Start the event loop manually
    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            // This code executes when the app is closing
            println!("Graceful shutdown initiated...");
            
            let db_state = app_handle.state::<DbState>();
            
            // If your DbState uses a connection pool (like sqlx), 
            // you should implement a .close() method.
            // Since shutdown is synchronous here, we use block_on if your close is async.
            tauri::async_runtime::block_on(async {
                db_state.close(); 
                println!("Database connections closed safely.");
            });
        }
        _ => {}
    });
}
