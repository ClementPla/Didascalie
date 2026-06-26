use std::collections::HashMap;
use std::fs;
use std::path::{ Path, PathBuf };

use regex::Regex;
use rusqlite::params;
use serde::{ Deserialize, Serialize };
use sha2::{ Digest, Sha256 };
use tauri::State;
use std::fmt::Write;
use crate::storage::DbState;
use crate::utils::error::{ AppError, Result };

// ==========================================
// Types
// ==========================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ScanOptions {
  pub folder_path: String,
  pub embed_images: bool,
  pub embed_threshold_kb: u32,
  pub input_regex: String,
  pub recursive: bool,
  pub folders_as_sequences: bool, // NEW: if true, subfolders become sequences
}

#[derive(Serialize, Debug)]
pub struct ScanResult {
  pub sequences_created: usize,
  pub frames_imported: usize,
  pub frames_embedded: usize,
  pub errors: Vec<String>,
}

#[derive(Debug)]
struct ImageFile {
  absolute_path: PathBuf,
  relative_path: String,
}

// ==========================================
// Commands
// ==========================================

/// Scan a folder for images and import them into the database.
///
/// Behavior depends on `folders_as_sequences`:
/// - true: Subfolders become sequences with multiple frames, loose images become single-frame sequences
/// - false: Each image becomes its own single-frame sequence (flat mode)
#[tauri::command]
pub fn scan_and_import_folder(db: State<DbState>, options: ScanOptions) -> Result<ScanResult> {
  let folder_path = PathBuf::from(&options.folder_path);
  dbg!("Scanning folder:", &folder_path);
  if !folder_path.exists() {
    return Err(
      AppError::Io(
        std::io::Error::new(
          std::io::ErrorKind::NotFound,
          format!("Folder not found: {}", options.folder_path)
        )
      )
    );
  }

  // Compile regex for matching image files
  let regex = Regex::new(&options.input_regex).map_err(|e|
    AppError::Generic(format!("Invalid regex: {}", e))
  )?;

  // Scan for image files
  let image_files = scan_for_images(&folder_path, &folder_path, &regex, options.recursive)?;
  // Debug the options and number of images found
  dbg!("Scan options:", &options);
  dbg!("Number of images found:", image_files.len());
  // Group into sequences based on configuration
  let sequences = group_into_sequences(image_files, options.folders_as_sequences);
  dbg!("Found sequences:", sequences.keys().collect::<Vec<_>>());
  // Import into database
  let result = import_sequences(&db, sequences, options.embed_images, options.embed_threshold_kb)?;

  Ok(result)
}

// ==========================================
// Internal Functions
// ==========================================

/// Recursively scan folder for image files matching the regex
fn scan_for_images(
  root: &Path,
  current: &Path,
  regex: &Regex,
  recursive: bool
) -> Result<Vec<ImageFile>> {
  let mut images = Vec::new();

  let entries = fs::read_dir(current).map_err(|e| AppError::Io(e))?;

  for entry in entries {
    let entry = entry.map_err(|e| AppError::Io(e))?;
    let path = entry.path();
    let file_type = entry.file_type().map_err(|e| AppError::Io(e))?;

    if file_type.is_dir() {
      if recursive {
        let sub_images = scan_for_images(root, &path, regex, recursive)?;
        images.extend(sub_images);
      }
    } else if file_type.is_file() {
      let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

      // Check if filename matches regex
      if regex.is_match(file_name) {
        let relative_path = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_string();

        images.push(ImageFile {
          absolute_path: path,
          relative_path,
        });
      }
    }
  }

  // Sort by path for consistent ordering
  images.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

  Ok(images)
}

/// Group images into sequences
///
/// If `folders_as_sequences` is true:
///   - Images in subfolders: grouped by subfolder name
///   - Images in root: each becomes its own sequence
///
/// If `folders_as_sequences` is false:
///   - Each image becomes its own single-frame sequence (flat mode)
fn group_into_sequences(
  images: Vec<ImageFile>,
  folders_as_sequences: bool
) -> HashMap<String, Vec<ImageFile>> {
  let mut sequences: HashMap<String, Vec<ImageFile>> = HashMap::new();
  for image in images {
    let sequence_name = if folders_as_sequences {
      get_sequence_name_from_path(&image.relative_path)
    } else {
      // Flat mode: use full relative path as unique key
      image.relative_path.clone()
    };
    sequences.entry(sequence_name).or_default().push(image);
  }
  for frames in sequences.values_mut() {
    frames.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
  }
  sequences
}

/// Extract sequence name from image path (filename without extension)
fn get_sequence_name_from_path(relative_path: &str) -> String {
  Path::new(relative_path)
    .parent()
    .filter(|p| !p.as_os_str().is_empty())
    .map(|p| p.to_string_lossy().to_string())
    .unwrap_or_else(|| {
      // No parent directory (root-level image), use filename stem
      Path::new(relative_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed")
        .to_string()
    })
}
/// Import sequences and frames into database
fn import_sequences(
  db: &State<DbState>,
  sequences: HashMap<String, Vec<ImageFile>>,
  embed_images: bool,
  embed_threshold_kb: u32
) -> Result<ScanResult> {
  let mut result = ScanResult {
    sequences_created: 0,
    frames_imported: 0,
    frames_embedded: 0,
    errors: Vec::new(),
  };

  db.with_conn(|conn| {
    // Sort sequences by name for consistent ordering
    let mut sequence_names: Vec<_> = sequences.keys().collect();
    sequence_names.sort();

    for (sort_order, sequence_name) in sequence_names.iter().enumerate() {
      let frames = sequences.get(*sequence_name).unwrap();

      // Insert sequence
      conn.execute(
        "INSERT INTO sequences (name, sort_order) VALUES (?1, ?2)",
        params![sequence_name, sort_order as i32]
      )?;
      let sequence_id = conn.last_insert_rowid();
      result.sequences_created += 1;

      // Insert frames
      for (frame_index, image) in frames.iter().enumerate() {
        match import_frame(conn, sequence_id, frame_index, image, embed_images, embed_threshold_kb) {
          Ok(embedded) => {
            result.frames_imported += 1;
            if embedded {
              result.frames_embedded += 1;
            }
          }
          Err(e) => {
            result.errors.push(format!("Failed to import {}: {}", image.relative_path, e));
          }
        }
      }
    }

    Ok(result)
  })
}

/// Import a single frame into database
fn import_frame(
  conn: &rusqlite::Connection,
  sequence_id: i64,
  frame_index: usize,
  image: &ImageFile,
  embed_images: bool,
  embed_threshold_kb: u32
) -> Result<bool> {
  // Read image file
  let file_data = fs::read(&image.absolute_path).map_err(|e| AppError::Io(e))?;

  // Calculate content hash
  let mut hasher = Sha256::new();
  hasher.update(&file_data);
  let digest = hasher.finalize();
  let mut content_hash = String::with_capacity(digest.len() * 2);
  for byte in digest {
    write!(&mut content_hash, "{:02x}", byte).unwrap();
  }

  // Get image dimensions
  let (width, height) = get_image_dimensions(&file_data)?;

  // Determine if we should embed
  let file_size_kb = (file_data.len() as u32) / 1024;
  let should_embed = embed_images || file_size_kb < embed_threshold_kb;

  let embedded_data: Option<Vec<u8>> = if should_embed { Some(file_data) } else { None };

  // Store relative path only if not embedded
  let relative_path: Option<&str> = Some(&image.relative_path);

  conn.execute(
    "INSERT INTO frames (
            sequence_id, frame_index, relative_path, content_hash,
            embedded_data, width, height, reviewed
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
    params![
      sequence_id,
      frame_index as i32,
      relative_path,
      content_hash,
      embedded_data,
      width,
      height
    ]
  )?;

  Ok(should_embed)
}

/// Get image dimensions from raw bytes
fn get_image_dimensions(data: &[u8]) -> Result<(i32, i32)> {
  let img = image
    ::load_from_memory(data)
    .map_err(|e| AppError::Generic(format!("Failed to decode image: {}", e)))?;

  Ok((img.width() as i32, img.height() as i32))
}
