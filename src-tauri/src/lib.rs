use std::sync::Arc;
#[cfg(not(target_os = "android"))]
use crate::dl::feature_extract::FeaturesExtractor;
#[cfg(not(target_os = "android"))]
use crate::dl::model::ModelSessions;

#[cfg(not(target_os = "android"))]
use crate::connection::inference::InferenceClient;
use crate::storage::DbState;
use tauri::{Manager, RunEvent};
use tokio::sync::Mutex;

mod commands;
#[cfg(not(target_os = "android"))]
mod connection;

#[cfg(not(target_os = "android"))]
mod dl;

mod utils;
mod storage;
mod superpixel;
mod types;
mod video;

/// Per-OS webview tuning, applied before the webview is created. Windows
/// forces the GPU on in main.rs; this covers Linux (WebKitGTK). Every
/// override can be opted out of.
fn configure_webview_env() {
    #[cfg(target_os = "linux")]
    {
        // Accelerated compositing, unless the user already decided.
        if std::env::var_os("WEBKIT_FORCE_COMPOSITING_MODE").is_none() {
            // SAFETY: set before any webview/thread is spawned.
            unsafe {
                std::env::set_var("WEBKIT_FORCE_COMPOSITING_MODE", "1");
            }
        }

        // The DMABUF renderer is the fast path but corrupts on some X11 setups with
        // proprietary drivers, so it is disabled there by default. An explicit
        // WEBKIT_DISABLE_DMABUF_RENDERER is never overridden, and
        // DIDASCALIE_FORCE_DMABUF=1 keeps the fast path.
        let raw_force = std::env::var("DIDASCALIE_FORCE_DMABUF").ok();
        let force_dmabuf = raw_force.as_deref() == Some("1");
        let already_set = std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some();
        let x11_with_dri = std::path::Path::new("/dev/dri").exists()
            && std::env::var("WAYLAND_DISPLAY").is_err()
            && std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "x11";

        if force_dmabuf {
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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_webview_env();
    let app = tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init());

    // A release build has no console: log to a rotating file as well as stdout.
    let app = app.plugin(
        tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .max_file_size(5_000_000)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
            // `.target()` appends to the defaults, which are these two already.
            .clear_targets()
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::LogDir { file_name: None },
            ))
            .target(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Stdout,
            ))
            .build(),
    );

    // Auto-update from GitHub releases.
    #[cfg(desktop)]
    let app = app
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(target_os = "android"))]
    let app = app
        .manage(Arc::new(Mutex::new(FeaturesExtractor::new())))
        .manage(ModelSessions::new());
    
    #[cfg(not(target_os = "android"))]
    let app = app.manage(InferenceClient::new());

    let app = app.manage(DbState::new())
        .manage(commands::superpixel::SuperpixelState::default())
        .manage(commands::frame::FrameImageCache::default())
        .manage(commands::frame::ThumbnailCache::default())
        .manage(commands::ml::predict::MlState::default())
        .setup(|app| {
            #[cfg(not(target_os = "android"))]
            {
                let port = connection::settings::load_listen_port(app.handle());
                app.manage(connection::settings::ActiveListenPort(port));
                connection::coms::setup_zmq_receiver(app.handle().clone(), port)?;
            }
            create_main_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::segmentation::otsu_segmentation,
            #[cfg(not(target_os = "android"))]
            connection::connection::event_processed,
            commands::flood_fill::flood_fill_mask,
            commands::superpixel::superpixel_refine,
            commands::superpixel::superpixel_overlay,
            #[cfg(not(target_os = "android"))]
            commands::dl::mask_sam_segment,
            commands::io::scan_and_import_folder,
            commands::io::add_images_to_project,
            commands::users::list_users,
            commands::users::current_user,
            commands::users::login,
            commands::users::logout,
            commands::users::register_user,
            commands::users::update_user,
            commands::users::user_footprint,
            commands::users::delete_user,
            commands::agreement::intergrader_report,
            commands::agreement::intergrader_cases,
            commands::agreement::intergrader_case_image,
            #[cfg(not(target_os = "android"))]
            commands::project_edit::project_edit_impact,
            #[cfg(not(target_os = "android"))]
            commands::project_edit::apply_project_edit,
            commands::device_files::import_project_file,
            commands::device_files::take_incoming_project,
            commands::device_files::export_project_file,
            commands::project::create_project,
            commands::project::open_project,
            commands::project::close_project,
            commands::project::get_image_folder,
            commands::project::set_image_folder,
            commands::project::get_frames_count,
            commands::project::get_sequences_count,
            commands::frame::get_progress,
            commands::frame::get_frame_image,
            commands::frame::get_frame_overview,
            commands::frame::get_frame_tile,
            commands::frame::get_frame_thumbnail,
            commands::frame::set_frames_reviewed,
            commands::frame::set_frame_reviewed,
            commands::sequences::list_sequences,
            commands::sequences::get_sequence_frames,
            commands::sequences::get_all_frame_ids_by_sequence,
            commands::sequences::get_gallery_sequences,
            commands::annotation::save_annotation,
            commands::annotation::load_annotations,
            commands::annotation::clear_sequence_annotations,
            commands::volume::load_sequence_image_volume,
            commands::volume::load_label_volume,
            commands::inspect::get_frame_preview,
            commands::inspect::render_label_overlay,
            commands::window::close_detached_window,
            commands::vector::save_vector_annotations,
            commands::vector::load_vector_annotations,
            commands::propagation::propagate_annotations,
            commands::vectorize::vectorize_component,
            commands::vectorize::vectorize_mask,
            commands::skeletonize::skeletonize_component,
            commands::skeletonize::skeletonize_mask,
            commands::annotation::list_labels,
            commands::annotation::get_labels,
            commands::classification::save_classification,
            commands::classification::load_classification,
            commands::classification::save_batch_classifications,
            commands::classification::get_sequence_classification,
            commands::classification::save_sequence_classification,
            commands::text_description::save_text_description,
            commands::text_description::load_text_descriptions,
            commands::text_description::delete_text_description,
            commands::dataset_io::list_dataset_formats,
            commands::dataset_io::export_dataset,
            commands::dataset_io::import_dataset,
            commands::registration::save_registration,
            commands::registration::load_registration,
            commands::registration::list_registrations,
            commands::registration::delete_registration,
            #[cfg(not(target_os = "android"))]
            connection::settings::get_listen_port,
            #[cfg(not(target_os = "android"))]
            connection::settings::set_listen_port,
            #[cfg(not(target_os = "android"))]
            commands::python::inference_connect,
            #[cfg(not(target_os = "android"))]
            commands::python::find_keypoints_prefill,
            #[cfg(not(target_os = "android"))]
            commands::python::python_segment_frame,
            #[cfg(not(target_os = "android"))]
            commands::python::python_segment_sequence,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_list_encoders,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_download_encoder,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_dataset_summary,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_train_model,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_model_status,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_load_saved_model,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_forget_model,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_stop_training,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_storage_usage,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_clear_feature_cache,
            #[cfg(not(target_os = "android"))]
            commands::ml::commands::ml_predict_frame,

        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");
    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            println!("Graceful shutdown initiated...");
            
            let db_state = app_handle.state::<DbState>();
            
            tauri::async_runtime::block_on(async {
                db_state.close(); 
                println!("Database connections closed safely.");
            });
        }
        _ => {}
    });
}

/// Build the main window from its `tauri.conf.json` entry (`create: false`
/// there, so this handler can be attached).
///
/// The frontend detaches editor views into their own OS windows with
/// `window.open("about:blank")` and moves their DOM there, so a view keeps
/// running in the main window's JavaScript context. That needs an
/// opener-linked webview, which answering `on_new_window` provides. Anything
/// but a blank page is refused.
#[cfg(desktop)]
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::webview::NewWindowResponse;

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;

    let handle = app.clone();
    let opened = Arc::new(AtomicUsize::new(0));
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_new_window(move |url, features| {
            if url.as_str() != "about:blank" {
                return NewWindowResponse::Deny;
            }
            let label = format!("detached-{}", opened.fetch_add(1, Ordering::Relaxed) + 1);
            let built = tauri::WebviewWindowBuilder::new(
                &handle,
                label,
                tauri::WebviewUrl::External(url),
            )
            .window_features(features)
            .title("Didascalie")
            // The opener names the window through `document.title`.
            .on_document_title_changed(|window, title| {
                let _ = window.set_title(&title);
            })
            .build();
            match built {
                Ok(window) => NewWindowResponse::Create { window },
                Err(error) => {
                    log::error!("Could not open a detached window: {error}");
                    NewWindowResponse::Deny
                }
            }
        })
        .build()?;
    Ok(())
}

#[cfg(mobile)]
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
    Ok(())
}
