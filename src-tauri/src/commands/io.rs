use tauri::command;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

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
