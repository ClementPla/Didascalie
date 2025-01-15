use regex::Regex;
use std;

// This command will return the list of files in a folder that match a regex
// It should implement the recursive search #TODO

#[tauri::command]
pub fn list_files_in_folder(folder: &str, regexfilter: &str, recursive: bool) -> Vec<String> {
    let paths = std::fs::read_dir(folder).unwrap();
    let mut files = Vec::new();
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
