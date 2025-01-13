use std::sync::{ Arc, Mutex };

mod dl;
mod tools;
mod commands;
mod connection;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder
    ::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(Arc::new(Mutex::new(dl::feature_extract::FeaturesExtractor::new())))

    .setup(|app| {
      connection::coms::setup_zmq_receiver(app.handle().clone())?;
      Ok(())
    })
    .invoke_handler(
      tauri::generate_handler![
        commands::system_infos::list_files_in_folder,
        commands::images::create_thumbnails,
        commands::images::load_image_as_base64,
        commands::images::process_image_blob,
        commands::segmentation::otsu_segmentation,
        commands::segmentation::edge_detection,
        commands::segmentation::find_overlapping_region,
        commands::dl::sam_segment,
        commands::io::save_json_file,
        commands::io::load_json_file,
        commands::io::save_xml_file,
        commands::io::load_xml_file,
        commands::io::check_file_exists,
        commands::segmentation::get_quad_tree_bbox,
        connection::connection::event_processed
      ]
    )
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
