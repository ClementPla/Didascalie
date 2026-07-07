use base64::{ engine::general_purpose::STANDARD as BASE64, Engine };
use rusqlite::params;
use serde::{ Serialize };
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::State;

use crate::storage::DbState;
use crate::utils::error::{ AppError, Result };

// ==========================================
// Types
// ==========================================

#[derive(Serialize, Debug, Clone)]
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

#[derive(Serialize, Debug, Clone)]
pub struct FrameImage {
  pub frame: Frame,
  pub image_base64: String,
}

/// Bounded in-memory cache of generated thumbnails, keyed by (frame, size), so
/// a frame's full image is decoded at most once per session — the gallery
/// otherwise re-decodes the full (possibly 100+ MP) image on every scroll/hover.
#[derive(Default)]
pub struct ThumbnailCache {
  inner: Mutex<ThumbnailCacheInner>,
}

#[derive(Default)]
struct ThumbnailCacheInner {
  map: std::collections::HashMap<(i64, u32), FrameImage>,
  order: std::collections::VecDeque<(i64, u32)>,
}

const THUMBNAIL_CACHE_CAP: usize = 1024;

impl ThumbnailCache {
  fn get(&self, frame_id: i64, size: u32) -> Option<FrameImage> {
    self.inner.lock().ok()?.map.get(&(frame_id, size)).cloned()
  }

  fn put(&self, frame_id: i64, size: u32, image: FrameImage) {
    let Ok(mut guard) = self.inner.lock() else { return };
    let key = (frame_id, size);
    if guard.map.insert(key, image).is_none() {
      guard.order.push_back(key);
      while guard.order.len() > THUMBNAIL_CACHE_CAP {
        if let Some(old) = guard.order.pop_front() {
          guard.map.remove(&old);
        }
      }
    }
  }
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
pub struct FrameMeta { pub frame: Frame }

pub fn read_frame_bytes(
    db: &DbState,
    frame_id: i64,
) -> Result<(FrameMeta, Vec<u8>)> {
    db.with_conn(|conn| {
        let row = conn.query_row(
            "SELECT f.id, f.sequence_id, f.frame_index, f.relative_path,
                    f.embedded_data, f.width, f.height, f.reviewed,
                    json_extract(p.config, '$.input_folder')
             FROM frames f
             JOIN sequences s ON f.sequence_id = s.id
             JOIN project p ON p.id = 1
             WHERE f.id = ?1",
            params![frame_id],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i32>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<Vec<u8>>>(4)?,
                row.get::<_, i32>(5)?,
                row.get::<_, i32>(6)?,
                row.get::<_, bool>(7)?,
                row.get::<_, Option<String>>(8)?,
            )),
        ).map_err(AppError::Database)?;

        let (id, sequence_id, frame_index, relative_path,
             embedded_data, width, height, reviewed, input_folder) = row;

        let is_embedded = embedded_data.is_some();
        let bytes = if let Some(data) = embedded_data {
            data
        } else if let Some(ref rel) = relative_path {
            let folder = input_folder.ok_or_else(|| {
                AppError::Generic("Project has no input_folder in config".into())
            })?;
            let full = Path::new(&folder).join(rel);
            fs::read(&full).map_err(|e| AppError::Io(
                std::io::Error::new(e.kind(),
                    format!("Failed to read image: {}", full.display()))
            ))?
        } else {
            return Err(AppError::Generic("Frame has no image data".into()));
        };

        Ok((
            FrameMeta {
                frame: Frame {
                    id, sequence_id, frame_index, relative_path,
                    width, height, reviewed, is_embedded,
                },
            },
            bytes,
        ))
    })
}


#[tauri::command]
pub fn get_frame_image(db: State<DbState>, frame_id: i64) -> Result<FrameImage> {
    let (meta, bytes) = read_frame_bytes(&db, frame_id)?;
    let mime = detect_mime_type(&bytes);
    let image_base64 = format!("data:{};base64,{}", mime, BASE64.encode(&bytes));
    Ok(FrameImage { frame: meta.frame, image_base64 })
}


/// A display image for a frame, downsampled server-side so its longest side is
/// ≤ `max_dim`. Images that already fit are returned unchanged. `frame.width` /
/// `frame.height` are always the NATIVE dimensions, so the frontend keeps masks
/// and coordinates at full resolution while displaying a decodable backdrop —
/// this is what lets images too large for the browser to decode still open.
#[tauri::command]
pub fn get_frame_overview(db: State<DbState>, frame_id: i64, max_dim: u32) -> Result<FrameImage> {
    let (meta, bytes) = read_frame_bytes(&db, frame_id)?;
    let nw = meta.frame.width.max(0) as u32;
    let nh = meta.frame.height.max(0) as u32;

    if max_dim == 0 || (nw <= max_dim && nh <= max_dim) {
        let mime = detect_mime_type(&bytes);
        let image_base64 = format!("data:{};base64,{}", mime, BASE64.encode(&bytes));
        return Ok(FrameImage { frame: meta.frame, image_base64 });
    }

    let img = image::load_from_memory(&bytes)
        .map_err(|e| AppError::Generic(format!("Failed to decode image: {}", e)))?;
    // Triangle (bilinear) keeps downsampling of a 100+ MP image fast; PNG keeps
    // it lossless so no compression artefacts land on the annotation backdrop.
    let scaled = img.resize(max_dim, max_dim, image::imageops::FilterType::Triangle);
    let mut out = Vec::new();
    scaled
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| AppError::Generic(format!("Failed to encode overview: {}", e)))?;
    let image_base64 = format!("data:image/png;base64,{}", BASE64.encode(&out));
    Ok(FrameImage { frame: meta.frame, image_base64 })
}

#[tauri::command]
pub fn get_frame_thumbnail(
  db: State<DbState>,
  cache: State<ThumbnailCache>,
  frame_id: i64,
  max_size: u32,
) -> Result<FrameImage> {
  if let Some(hit) = cache.get(frame_id, max_size) {
    return Ok(hit);
  }

  // Read the raw file bytes directly — NOT via get_frame_image, which would
  // base64-encode the whole full-resolution image just for us to decode it
  // straight back (very slow for large images).
  let (meta, bytes) = read_frame_bytes(&db, frame_id)?;

  let img = image::load_from_memory(&bytes)
    .map_err(|e| AppError::Generic(format!("Failed to decode image: {}", e)))?;
  let thumbnail = img.thumbnail(max_size, max_size);

  let mut jpeg_bytes = Vec::new();
  thumbnail
    .write_to(&mut std::io::Cursor::new(&mut jpeg_bytes), image::ImageFormat::Jpeg)
    .map_err(|e| AppError::Generic(format!("Failed to encode thumbnail: {}", e)))?;

  let frame_image = FrameImage {
    frame: meta.frame,
    image_base64: format!("data:image/jpeg;base64,{}", BASE64.encode(&jpeg_bytes)),
  };
  cache.put(frame_id, max_size, frame_image.clone());
  Ok(frame_image)
}

// ==========================================
// Native tile server (large images)
// ==========================================

/// Caches the decoded RGBA pixels of one frame so native-resolution tile
/// requests don't re-decode the whole image each time. Holds a single frame
/// (replaced when a different frame's tile is requested).
#[derive(Default)]
pub struct FrameImageCache {
    inner: Mutex<Option<CachedFrame>>,
}

struct CachedFrame {
    frame_id: i64,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

/// Copy an RGBA rectangle out of a full-image buffer. The output is always
/// `w*h*4` bytes; areas outside the image are left transparent, so edge tiles
/// come back a consistent size.
fn crop_rgba(raw: &[u8], img_w: u32, img_h: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
    if x >= img_w {
        return out;
    }
    let copy_w = w.min(img_w - x);
    for row in 0..h {
        let iy = y + row;
        if iy >= img_h {
            break;
        }
        let src = ((iy * img_w + x) as usize) * 4;
        let dst = ((row * w) as usize) * 4;
        out[dst..dst + (copy_w as usize) * 4]
            .copy_from_slice(&raw[src..src + (copy_w as usize) * 4]);
    }
    out
}

/// Return a native-resolution RGBA tile `(x, y, width, height)` of a frame as
/// raw bytes (`width*height*4`, row-major). The first tile of a frame decodes
/// the full image into the cache; later tiles are cheap crops.
#[tauri::command]
pub fn get_frame_tile(
    db: State<DbState>,
    cache: State<FrameImageCache>,
    frame_id: i64,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> std::result::Result<Response, String> {
    let mut guard = cache.inner.lock().map_err(|e| e.to_string())?;

    let stale = guard.as_ref().map_or(true, |c| c.frame_id != frame_id);
    if stale {
        let (_, bytes) = read_frame_bytes(&db, frame_id).map_err(|e| e.to_string())?;
        let img = image::load_from_memory(&bytes)
            .map_err(|e| format!("Failed to decode image: {}", e))?
            .to_rgba8();
        let (w, h) = (img.width(), img.height());
        *guard = Some(CachedFrame { frame_id, rgba: img.into_raw(), width: w, height: h });
    }

    let c = guard.as_ref().unwrap();
    let tile = crop_rgba(&c.rgba, c.width, c.height, x, y, width, height);
    Ok(Response::new(tile))
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

#[cfg(test)]
mod tests {
    use super::crop_rgba;

    /// Build a 2x2 RGBA image whose R channel encodes (y*2 + x) so pixels are
    /// distinguishable: (0,0)=0, (1,0)=1, (0,1)=2, (1,1)=3.
    fn img_2x2() -> Vec<u8> {
        let mut v = vec![0u8; 2 * 2 * 4];
        for y in 0..2u32 {
            for x in 0..2u32 {
                let i = ((y * 2 + x) as usize) * 4;
                v[i] = (y * 2 + x) as u8;
                v[i + 3] = 255;
            }
        }
        v
    }

    #[test]
    fn crop_full_image_is_identity() {
        let raw = img_2x2();
        assert_eq!(crop_rgba(&raw, 2, 2, 0, 0, 2, 2), raw);
    }

    #[test]
    fn crop_interior_pixel() {
        let raw = img_2x2();
        let tile = crop_rgba(&raw, 2, 2, 1, 1, 1, 1);
        assert_eq!(tile.len(), 4);
        assert_eq!(tile[0], 3); // pixel (1,1)
        assert_eq!(tile[3], 255);
    }

    #[test]
    fn crop_edge_tile_pads_out_of_bounds_with_zero() {
        let raw = img_2x2();
        // A 2x2 tile starting at (1,1) overhangs the image by one row/col.
        let tile = crop_rgba(&raw, 2, 2, 1, 1, 2, 2);
        assert_eq!(tile.len(), 2 * 2 * 4);
        assert_eq!(tile[0], 3); // in-bounds pixel (1,1)
        // The other three tile pixels are out of bounds → transparent zero.
        assert_eq!(&tile[4..16], &[0u8; 12]);
    }

    #[test]
    fn crop_fully_out_of_bounds_is_transparent() {
        let raw = img_2x2();
        let tile = crop_rgba(&raw, 2, 2, 5, 5, 2, 2);
        assert_eq!(tile, vec![0u8; 2 * 2 * 4]);
    }
}
