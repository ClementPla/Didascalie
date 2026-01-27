use std::sync::Arc;

use crate::dl::feature_extract::FeaturesExtractor;
use crate::dl::model::ModelSessions;
use crate::storage::DbState;
use tauri::{Manager, RunEvent};
use tokio::sync::Mutex;

mod commands;
mod connection;
mod dl;
mod utils;
mod storage;
mod types;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        if std::path::Path::new("/dev/dri").exists()
            && std::env::var("WAYLAND_DISPLAY").is_err()
            && std::env::var("XDG_SESSION_TYPE").unwrap_or_default() == "x11"
        {
            // SAFETY: There's potential for race conditions in a multi-threaded context.
            unsafe {
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(FeaturesExtractor::new())))
        .manage(ModelSessions::new())
        .manage(DbState::new()) 
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
            commands::dl::mask_sam_segment,
            // commands::io::save_json_file,
            // commands::io::load_json_file,
            // commands::io::save_xml_file,
            // commands::io::load_xml_file,
            // commands::io::save_csv_file,
            // commands::io::load_csv_file,
            // commands::io::list_files_in_folder,
            // commands::io::check_file_exists,
            // commands::io::export,
            commands::io::scan_and_import_folder,
            commands::project::create_project,
            commands::project::open_project,
            commands::project::close_project,
            // Frames commands
            commands::project::get_frames_count,
            commands::project::get_sequences_count,
            commands::frame::get_progress,
            commands::frame::get_frame_image,
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
            commands::annotation::mark_reviewed,
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
