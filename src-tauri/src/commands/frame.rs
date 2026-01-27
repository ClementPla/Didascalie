use base64::{ engine::general_purpose::STANDARD as BASE64, Engine };
use rusqlite::params;
use serde::{ Serialize };
use std::fs;
use std::path::Path;
use tauri::State;

use crate::storage::DbState;
use crate::utils::error::{ AppError, Result };

// ==========================================
// Types
// ==========================================

#[derive(Serialize, Debug)]
pub struct Frame {
  pub id: i64,
  pub sequence_id: i64,
  pub frame_index: i32,
  pub relative_path: Option<String>,
  pub width: i32,
  pub height: i32,
  pub reviewed: bool,
  pub is_embedded: bool,
}

#[derive(Serialize, Debug)]
pub struct FrameImage {
  pub frame: Frame,
  pub image_base64: String,
}


#[tauri::command]
pub fn get_progress(db: State<DbState>) -> Result<(i64, i64)> {
  db.with_conn(|conn| {
    let total: i64 = conn
      .query_row("SELECT COUNT(*) FROM frames", [], |row| row.get(0))
      .map_err(|e| AppError::Database(e))?;

    let reviewed: i64 = conn
      .query_row("SELECT COUNT(*) FROM frames WHERE reviewed = 1", [], |row| row.get(0))
      .map_err(|e| AppError::Database(e))?;

    Ok((reviewed, total))
  })
}

// ==========================================
// Frame Retrieval
// ==========================================

#[tauri::command]
pub fn get_frame_image(db: State<DbState>, frame_id: i64) -> Result<FrameImage> {
  db.with_conn(|conn| {
    let row = conn
      .query_row(
        "SELECT f.id, f.sequence_id, f.frame_index, f.relative_path, 
                    f.embedded_data, f.width, f.height, f.reviewed,
                    json_extract(p.config, '$.input_folder')
             FROM frames f
             JOIN sequences s ON f.sequence_id = s.id
             JOIN project p ON p.id = 1
             WHERE f.id = ?1",
        params![frame_id],
        |row| {
          Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i32>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<Vec<u8>>>(4)?,
            row.get::<_, i32>(5)?,
            row.get::<_, i32>(6)?,
            row.get::<_, bool>(7)?,
            row.get::<_, Option<String>>(8)?,
          ))
        }
      )
      .map_err(|e| AppError::Database(e))?;

    let (
      id,
      sequence_id,
      frame_index,
      relative_path,
      embedded_data,
      width,
      height,
      reviewed,
      input_folder,
    ) = row;

    let is_embedded = embedded_data.is_some();

    let image_data = if let Some(data) = embedded_data {
      data
    } else if let Some(ref rel_path) = relative_path {
      let folder = input_folder.ok_or_else(|| {
        AppError::Generic("Project has no input_folder in config".to_string())
      })?;

      let full_path = Path::new(&folder).join(rel_path);
      fs
        ::read(&full_path)
        .map_err(|e| {
          AppError::Io(
            std::io::Error::new(e.kind(), format!("Failed to read image: {}", full_path.display()))
          )
        })?
    } else {
      return Err(AppError::Generic("Frame has no image data".to_string()));
    };

    let mime_type = detect_mime_type(&image_data);
    let base64_data = BASE64.encode(&image_data);
    let image_base64 = format!("data:{};base64,{}", mime_type, base64_data);

    let frame = Frame {
      id,
      sequence_id,
      frame_index,
      relative_path,
      width,
      height,
      reviewed,
      is_embedded,
    };

    Ok(FrameImage {
      frame,
      image_base64,
    })
  })
}

#[tauri::command]
pub fn get_frame_thumbnail(db: State<DbState>, frame_id: i64, max_size: u32) -> Result<FrameImage> {
  let mut frame_image = get_frame_image(db, frame_id)?;

  // Decode the base64 image
  let base64_data = frame_image.image_base64
    .strip_prefix("data:")
    .and_then(|s| s.split_once(";base64,"))
    .map(|(_, data)| data)
    .ok_or_else(|| AppError::Generic("Invalid image data format".to_string()))?;

  let image_bytes = BASE64.decode(base64_data.as_bytes()).map_err(|e|
    AppError::Generic(format!("Failed to decode base64: {}", e))
  )?;

  // Resize
  let img = image
    ::load_from_memory(&image_bytes)
    .map_err(|e| AppError::Generic(format!("Failed to decode image: {}", e)))?;

  let thumbnail = img.thumbnail(max_size, max_size);

  // Re-encode as JPEG
  let mut jpeg_bytes = Vec::new();
  thumbnail
    .write_to(&mut std::io::Cursor::new(&mut jpeg_bytes), image::ImageFormat::Jpeg)
    .map_err(|e| AppError::Generic(format!("Failed to encode thumbnail: {}", e)))?;

  frame_image.image_base64 = format!("data:image/jpeg;base64,{}", BASE64.encode(&jpeg_bytes));

  Ok(frame_image)
}

// ==========================================
// Frame Modification
// ==========================================

#[tauri::command]
pub fn set_frame_reviewed(db: State<DbState>, frame_id: i64, reviewed: bool) -> Result<()> {
  db.with_conn(|conn| {
    conn
      .execute("UPDATE frames SET reviewed = ?1 WHERE id = ?2", params![reviewed, frame_id])
      .map_err(|e| AppError::Database(e))?;

    Ok(())
  })
}

#[tauri::command]
pub fn set_frames_reviewed(db: State<DbState>, frame_ids: Vec<i64>, reviewed: bool) -> Result<()> {
  db.with_conn(|conn| {
    let placeholders = frame_ids
      .iter()
      .map(|_| "?")
      .collect::<Vec<_>>()
      .join(",");
    let sql = format!("UPDATE frames SET reviewed = ?1 WHERE id IN ({})", placeholders);

    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(reviewed)];
    for id in &frame_ids {
      params.push(Box::new(*id));
    }

    conn.execute(&sql, rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))?;
    Ok(())
  })
}

// ==========================================
// Utility
// ==========================================

fn detect_mime_type(data: &[u8]) -> &'static str {
  if data.len() < 8 {
    return "application/octet-stream";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if data.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if data.starts_with(&[0xff, 0xd8, 0xff]) {
    return "image/jpeg";
  }

  // GIF: GIF87a or GIF89a
  if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
    return "image/gif";
  }

  // BMP: BM
  if data.starts_with(b"BM") {
    return "image/bmp";
  }

  // TIFF: II (little-endian) or MM (big-endian)
  if data.starts_with(&[0x49, 0x49, 0x2a, 0x00]) || data.starts_with(&[0x4d, 0x4d, 0x00, 0x2a]) {
    return "image/tiff";
  }

  // WebP: RIFF....WEBP
  if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
    return "image/webp";
  }

  "application/octet-stream"
}
