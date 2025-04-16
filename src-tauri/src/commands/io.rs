use crate::commands::images::{
    filter_aliasing, from_multiples_masks_to_multiclass, from_rgb_to_binary, merge_multiple_images,
};
use base64::{engine::general_purpose, Engine as _};
use image::ImageBuffer;
use rayon::prelude::*;
use regex::Regex;
use roxmltree;
use std;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use tauri::command;
use tauri::{AppHandle, Emitter};

// This command will return the list of files in a folder that match a regex
// It should implement the recursive search #TODO

#[command]
pub fn list_files_in_folder(folder: &str, regexfilter: &str, recursive: bool) -> Vec<String> {
    let mut files = Vec::new();
    if !std::path::Path::new(folder).exists() {
        return files;
    }
    let paths = std::fs::read_dir(folder).unwrap();
    match Regex::new(&format!(r"(?i){}", regexfilter)) {
        Ok(re) => {
            for path in paths {
                let path = path.unwrap().path();
                let file_name = path.file_name().unwrap().to_str().unwrap();
                if file_name.starts_with(".") {
                    continue;
                }
                if path.is_file() && re.is_match(path.to_str().unwrap()) {
                    files.push(path.display().to_string());
                }
                if path.is_dir() && recursive {
                    files.append(
                        list_files_in_folder(path.to_str().unwrap(), regexfilter, recursive)
                            .as_mut(),
                    );
                }
            }
        }
        Err(_) => {
            println!("Invalid regex: {}", regexfilter);
            // Return an empty list if the regex is invalid
            return files;
        }
    }
    files
}

#[command]
pub fn save_xml_file(filepath: String, xml_content: String) -> Result<(), String> {
    // Validate the filepath
    let path = Path::new(&filepath);

    // Ensure the directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // Open the file for writing
    let mut file = File::create(&path).map_err(|e| format!("Failed to create file: {}", e))?;

    // Write the XML content to the file
    file.write_all(xml_content.as_bytes())
        .map_err(|e| format!("Failed to write XML content: {}", e))?;

    Ok(())
}

#[command]
pub fn save_json_file(filepath: String, json_content: String) -> Result<(), String> {
    // Validate the filepath
    let path = Path::new(&filepath);

    // Ensure the directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    println!("Creating file: {:?}", path);

    // Open the file for writing
    let mut file = File::create(&path).map_err(|e| format!("Failed to create file: {}", e))?;

    // Write the JSON content to the file
    file.write_all(json_content.as_bytes())
        .map_err(|e| format!("Failed to write JSON content: {}", e))?;

    Ok(())
}

#[command]
pub fn load_xml_file(filepath: String) -> Result<String, String> {
    // Open the file for reading
    let mut file = File::open(&filepath).map_err(|e| format!("Failed to open file: {}", e))?;

    // Read the file contents
    let mut xml_content = String::new();
    file.read_to_string(&mut xml_content)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    Ok(xml_content)
}

#[command]
pub fn load_json_file(filepath: String) -> Result<String, String> {
    // Open the file for reading
    let mut file = File::open(&filepath).map_err(|e| format!("Failed to open file: {}", e))?;

    // Read the file contents
    let mut json_content = String::new();
    file.read_to_string(&mut json_content)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    Ok(json_content)
}
#[command]
pub fn save_csv_file(filepath: String, csv_content: String) {
    // Validate the filepath
    let path = Path::new(&filepath);

    // Ensure the directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }

    // Open the file for writing
    let mut file = File::create(&path).unwrap();

    // Write the CSV content to the file
    file.write_all(csv_content.as_bytes()).unwrap();
}

#[command]
pub fn load_csv_file(filepath: String) -> String {
    // Open the file for reading
    let mut file = File::open(&filepath).unwrap();

    // Read the file contents
    let mut csv_content = String::new();
    file.read_to_string(&mut csv_content).unwrap();

    csv_content
}

#[command]
pub fn check_file_exists(filepath: String) -> Result<bool, String> {
    let path = Path::new(&filepath);
    Ok(path.exists())
}

#[command]
pub async fn export(
    app: AppHandle,
    input_folder: String,
    output_folder: String,
    individual_mask: bool,
    combined_mask: bool,
    colormap: bool,
) {
    let all_files = list_files_in_folder(&input_folder, r".*\.svg", true);
    app.emit("export", all_files.len()).unwrap();
    // Iterate through the SVG files

    all_files.par_iter().enumerate().for_each(|(_i, file)| {
        app.emit("export-progress", 1).unwrap();
        // Load the SVG file as XML
        let xml_content = load_xml_file(file.clone()).unwrap();
        let xml: roxmltree::Document<'_> = roxmltree::Document::parse(&xml_content).unwrap();
        let filename = Path::new(file); 
        // Strip the input folder from the filename
        let filename = filename.strip_prefix(&input_folder).unwrap();
        let filename = filename.to_str().unwrap();
        let filename = filename.replace(".svg", ".png");
        
        // Check if the SVG file has a mask
        let has_mask = xml
            .descendants()
            .find(|n| n.has_tag_name("image"))
            .is_some();
        if has_mask {
            read_mask_and_save(
                &xml,
                filename,
                output_folder.clone(),
                individual_mask,
                combined_mask,
                colormap,
            );
        }
    });
}

fn read_mask_and_save(
    svg: &roxmltree::Document,
    filename: String,
    output_folder: String,
    individual_mask: bool,
    combined_mask: bool,
    colormap: bool,
) {
    let mut masks: Vec<ImageBuffer<image::Rgb<u8>, Vec<u8>>> = Vec::new();
    let mut mask_names: Vec<String> = Vec::new();
    // Gather all the images in the SVG file

    let images = svg
        .descendants()
        .filter(|n| n.has_tag_name("image"))
        .collect::<Vec<_>>();

    // For each image, extract the data
    images.iter().for_each(|image| {
        let image_data = image.attribute("href").unwrap();
        let image_data = image_data.replace("data:image/png;base64,", "");
        let mask_name = image.attribute("id").unwrap();
        let image_data = general_purpose::STANDARD
            .decode(image_data.as_bytes())
            .unwrap();
        let img = image::load_from_memory(&image_data).unwrap().to_rgba8();

        let img = filter_aliasing(img, image.attribute("color").unwrap().to_string());
        masks.push(img);
        mask_names.push(mask_name.to_string());
    });

    // let mut combined_mask = ImageBuffer::new(dims.0, dims.1);
    if colormap {
        let mut output_path = Path::new(&output_folder).to_path_buf().join("colormaps");
        
        output_path = output_path.join(filename.clone());
        if !output_path.exists() {
            let output_folder = output_path.parent().unwrap();
            std::fs::create_dir_all(output_folder).unwrap();
        }
        let mask = merge_multiple_images(&masks);
        println!("Saving colormap: {:?}", output_path);
        mask.save(output_path).unwrap();
    }
    if combined_mask || individual_mask {
        let binary_masks: Vec<ImageBuffer<image::Luma<u8>, Vec<u8>>> =
            masks.iter().map(|mask| from_rgb_to_binary(mask)).collect();

        if individual_mask {
            let output_path = Path::new(&output_folder).to_path_buf().join("multilabel");
            binary_masks.iter().enumerate().for_each(|(i, mask)| {
                let mut output_path = output_path.clone();
                output_path = output_path.join(mask_names[i].clone());
                
                output_path = output_path.join(filename.clone());
                if !output_path.exists() {
                    // We separate the filename from the folder
                    let output_folder = output_path.parent().unwrap();
                    std::fs::create_dir_all(output_folder).unwrap();
                }

                mask.save(output_path).unwrap();
            });
        }
        if combined_mask {
            let mut output_path = Path::new(&output_folder).to_path_buf().join("multiclass");
            
            output_path = output_path.join(filename.clone());
            if !output_path.exists() {
                let output_folder = output_path.parent().unwrap();

                std::fs::create_dir_all(output_folder).unwrap();
            }
            let mask = from_multiples_masks_to_multiclass(&binary_masks);
            mask.save(output_path).unwrap();
        }
    }
}
