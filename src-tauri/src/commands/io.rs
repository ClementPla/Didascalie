use tauri::command;
use std;

use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use regex::Regex;

// This command will return the list of files in a folder that match a regex
// It should implement the recursive search #TODO

#[tauri::command]
pub fn list_files_in_folder(folder: &str, regexfilter: &str, recursive: bool) -> Vec<String> {
    let mut files = Vec::new();
    if !std::path::Path::new(folder).exists() {
        return files;
    }
    println!("Listing files in folder: {}", folder);
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
    let mut file = File::create(&path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    
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
    let mut file = File::create(&path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    
    // Write the JSON content to the file
    file.write_all(json_content.as_bytes())
        .map_err(|e| format!("Failed to write JSON content: {}", e))?;
    
    Ok(())

}




#[command]
pub fn load_xml_file(filepath: String) -> Result<String, String> {
    // Open the file for reading
    let mut file = File::open(&filepath)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    
    // Read the file contents
    let mut xml_content = String::new();
    file.read_to_string(&mut xml_content)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    Ok(xml_content)
}


#[command]
pub fn load_json_file(filepath: String) -> Result<String, String> {
    // Open the file for reading
    let mut file = File::open(&filepath)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    
    // Read the file contents
    let mut json_content = String::new();
    file.read_to_string(&mut json_content)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    Ok(json_content)
}


#[command]
pub fn check_file_exists(filepath: String) -> Result<bool, String> {
    let path = Path::new(&filepath);
    Ok(path.exists())
}
