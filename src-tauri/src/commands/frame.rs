use base64::{ engine::general_purpose::STANDARD as BASE64, Engine };
use rusqlite::params;
use serde::{ Serialize };
use ts_rs::TS;
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::State;

use crate::frames::{read_frame_bytes, Frame, FrameMeta};
use crate::pixels::display::Region;
use crate::pixels::picture::{decode_downscaled, detect_mime_type};
use crate::storage::DbState;
use crate::utils::error::{ AppError, Result };

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct FrameImage {
  pub frame: Frame,
  /// A data URL: `data:image/png;base64,...`.
  pub image_base64: String,
}

/// Bounded in-memory cache of thumbnails, keyed by (frame, size). Frame ids
/// restart from 1 in every project, so it must be [`clear`]ed when the open
/// project changes.
///
/// [`clear`]: ThumbnailCache::clear
#[derive(Default)]
pub struct ThumbnailCache {
  inner: Mutex<ThumbnailCacheInner>,
}

#[derive(Default)]
struct ThumbnailCacheInner {
  map: std::collections::HashMap<(i64, u32), FrameImage>,
  order: std::collections::VecDeque<(i64, u32)>,
  /// Bumped by `clear`: `put` drops a thumbnail whose decoding started before.
  generation: u64,
}

const THUMBNAIL_CACHE_CAP: usize = 1024;

impl ThumbnailCache {
  fn get(&self, frame_id: i64, size: u32) -> Option<FrameImage> {
    self.inner.lock().ok()?.map.get(&(frame_id, size)).cloned()
  }

  fn generation(&self) -> u64 {
    self.inner.lock().map(|g| g.generation).unwrap_or(0)
  }

  fn put(&self, generation: u64, frame_id: i64, size: u32, image: FrameImage) {
    let Ok(mut guard) = self.inner.lock() else { return };
    if guard.generation != generation {
      return;
    }
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

  pub fn clear(&self) {
    let Ok(mut guard) = self.inner.lock() else { return };
    guard.map.clear();
    guard.order.clear();
    guard.generation += 1;
  }
}

#[tauri::command]
pub fn get_progress(db: State<DbState>) -> Result<(i64, i64)> {
  db.with_conn(|conn| {
    let total: i64 = conn
      .query_row("SELECT COUNT(*) FROM frames", [], |row| row.get(0))
      .map_err(AppError::Database)?;

    let reviewed: i64 = conn
      .query_row("SELECT COUNT(*) FROM frame_reviews", [], |row| row.get(0))
      .map_err(AppError::Database)?;

    Ok((reviewed, total))
  })
}

#[tauri::command]
pub fn get_frame_image(db: State<DbState>, frame_id: i64) -> Result<FrameImage> {
    let (meta, bytes) = read_frame_bytes(&db, frame_id)?;
    if crate::pixels::raw::needs_render(&bytes) {
        // The webview cannot show these bytes: a render through the sequence's display.
        let picture = crate::pixels::picture::frame_picture(&db, frame_id, &bytes, 0)?;
        return Ok(FrameImage { frame: meta.frame, image_base64: png_data_url(&picture)? });
    }
    let mime = detect_mime_type(&bytes);
    let image_base64 = format!("data:{};base64,{}", mime, BASE64.encode(&bytes));
    Ok(FrameImage { frame: meta.frame, image_base64 })
}

/// A display image for a frame, downsampled so its longest side is ≤
/// `max_dim`. `frame.width` / `frame.height` stay the native dimensions.
#[tauri::command]
pub fn get_frame_overview(db: State<DbState>, frame_id: i64, max_dim: u32) -> Result<FrameImage> {
    let (meta, bytes) = read_frame_bytes(&db, frame_id)?;
    if crate::pixels::raw::needs_render(&bytes) {
        let picture = crate::pixels::picture::frame_picture(&db, frame_id, &bytes, max_dim)?;
        return Ok(FrameImage { frame: meta.frame, image_base64: png_data_url(&picture)? });
    }
    overview_from_bytes(meta, bytes, max_dim)
}

fn png_data_url(picture: &image::DynamicImage) -> Result<String> {
    let mut out = Vec::new();
    picture
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| AppError::Generic(format!("Failed to encode image: {}", e)))?;
    Ok(format!("data:image/png;base64,{}", BASE64.encode(&out)))
}

/// The stored bytes when the frame fits within `max_dim`, otherwise a PNG
/// downsampled to it. `frame.width` / `frame.height` stay native.
pub(crate) fn overview_from_bytes(meta: FrameMeta, bytes: Vec<u8>, max_dim: u32) -> Result<FrameImage> {
    let nw = meta.frame.width.max(0) as u32;
    let nh = meta.frame.height.max(0) as u32;

    if max_dim == 0 || (nw <= max_dim && nh <= max_dim) {
        let mime = detect_mime_type(&bytes);
        let image_base64 = format!("data:{};base64,{}", mime, BASE64.encode(&bytes));
        return Ok(FrameImage { frame: meta.frame, image_base64 });
    }

    let img = decode_downscaled(&bytes, max_dim)?;
    // PNG: no compression artefacts on the annotation backdrop.
    let scaled = img.resize(max_dim, max_dim, image::imageops::FilterType::Triangle);
    let mut out = Vec::new();
    scaled
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| AppError::Generic(format!("Failed to encode overview: {}", e)))?;
    let image_base64 = format!("data:image/png;base64,{}", BASE64.encode(&out));
    Ok(FrameImage { frame: meta.frame, image_base64 })
}

fn decode_thumbnail(bytes: &[u8], max: u32) -> Result<image::DynamicImage> {
  Ok(decode_downscaled(bytes, max)?.thumbnail(max, max))
}

#[tauri::command(async)]
pub fn get_frame_thumbnail(
  db: State<DbState>,
  cache: State<ThumbnailCache>,
  frame_id: i64,
  max_size: u32,
) -> Result<FrameImage> {
  if let Some(hit) = cache.get(frame_id, max_size) {
    return Ok(hit);
  }
  let generation = cache.generation();

  let (meta, bytes) = read_frame_bytes(&db, frame_id)?;

  let thumbnail = if crate::pixels::raw::needs_render(&bytes) {
    crate::pixels::picture::frame_picture(&db, frame_id, &bytes, max_size)?.thumbnail(max_size, max_size)
  } else {
    decode_thumbnail(&bytes, max_size)?
  };

  let mut jpeg_bytes = Vec::new();
  thumbnail
    .write_to(&mut std::io::Cursor::new(&mut jpeg_bytes), image::ImageFormat::Jpeg)
    .map_err(|e| AppError::Generic(format!("Failed to encode thumbnail: {}", e)))?;

  let frame_image = FrameImage {
    frame: meta.frame,
    image_base64: format!("data:image/jpeg;base64,{}", BASE64.encode(&jpeg_bytes)),
  };
  cache.put(generation, frame_id, max_size, frame_image.clone());
  Ok(frame_image)
}

// ── Native tile server (large images) ──────────────────────────────────────

/// The decoded RGBA pixels of one frame, so that tile requests do not decode
/// the image again.
#[derive(Default)]
pub struct FrameImageCache {
    inner: Mutex<Option<CachedFrame>>,
}

impl FrameImageCache {
    /// Call when the open project changes.
    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
    }
}

struct CachedFrame {
    frame_id: i64,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

/// Copy an RGBA rectangle out of a full-image buffer. Always `w*h*4` bytes;
/// areas outside the image are transparent.
fn crop_rgba(raw: &[u8], img_w: u32, img_h: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let mut out = vec![0u8; (w as usize) * (h as usize) * 4];
    if x >= img_w {
        return out;
    }
    let copy_w = w.min(img_w - x);
    for row in 0..h {
        let Some(iy) = y.checked_add(row).filter(|&iy| iy < img_h) else {
            break;
        };
        let src = (iy as usize * img_w as usize + x as usize) * 4;
        let dst = row as usize * w as usize * 4;
        out[dst..dst + (copy_w as usize) * 4]
            .copy_from_slice(&raw[src..src + (copy_w as usize) * 4]);
    }
    out
}

/// A native-resolution RGBA tile of a frame, as raw bytes (`width*height*4`,
/// row-major).
#[tauri::command(async)]
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

    let stale = guard.as_ref().is_none_or(|c| c.frame_id != frame_id);
    if stale {
        let (_, bytes) = read_frame_bytes(&db, frame_id).map_err(|e| e.to_string())?;
        let img = image::load_from_memory(&bytes)
            .map_err(|e| format!("Failed to decode image: {}", e))?
            .to_rgba8();
        let (w, h) = (img.width(), img.height());
        *guard = Some(CachedFrame { frame_id, rgba: img.into_raw(), width: w, height: h });
    }

    let c = guard.as_ref().ok_or("Frame image cache is empty")?;
    let region = Region { x, y, width, height }.bounded(c.width, c.height)?;
    let tile = crop_rgba(&c.rgba, c.width, c.height, region.x, region.y, region.width, region.height);
    Ok(Response::new(tile))
}

// ── Frame Modification ─────────────────────────────────────────────────────

#[tauri::command]
pub fn set_frame_reviewed(db: State<DbState>, frame_id: i64, reviewed: bool) -> Result<()> {
  db.with_conn(|conn| mark_reviewed(conn, &[frame_id], reviewed))
}

#[tauri::command]
pub fn set_frames_reviewed(db: State<DbState>, frame_ids: Vec<i64>, reviewed: bool) -> Result<()> {
  db.with_conn(|conn| mark_reviewed(conn, &frame_ids, reviewed))
}

/// Record or withdraw the current user's review of `frame_ids`.
pub fn mark_reviewed(conn: &rusqlite::Connection, frame_ids: &[i64], reviewed: bool) -> Result<()> {
  let user = crate::storage::queries::current_user_id(conn)?;
  let tx = conn.unchecked_transaction()?;
  {
    let mut stmt = tx.prepare(if reviewed {
      "INSERT OR IGNORE INTO main.frame_reviews (frame_id, user_id) VALUES (?1, ?2)"
    } else {
      "DELETE FROM main.frame_reviews WHERE frame_id = ?1 AND user_id = ?2"
    })?;
    for frame_id in frame_ids {
      stmt.execute(params![frame_id, user])?;
    }
  }
  tx.commit()?;
  Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        crop_rgba, decode_downscaled, decode_thumbnail, Frame, FrameImage, ThumbnailCache,
    };

    fn thumbnail(tag: &str) -> FrameImage {
        FrameImage {
            frame: Frame {
                id: 1,
                sequence_id: 1,
                frame_index: 0,
                relative_path: None,
                width: 1,
                height: 1,
                reviewed: false,
                is_embedded: true,
            },
            image_base64: tag.to_string(),
        }
    }

    /// Frame 1 of the next project is not frame 1 of this one.
    #[test]
    fn clearing_the_thumbnail_cache_forgets_the_previous_project() {
        let cache = ThumbnailCache::default();
        cache.put(cache.generation(), 1, 256, thumbnail("first project"));
        assert!(cache.get(1, 256).is_some());

        cache.clear();
        assert!(cache.get(1, 256).is_none());

        cache.put(cache.generation(), 1, 256, thumbnail("second project"));
        assert_eq!(cache.get(1, 256).unwrap().image_base64, "second project");
    }

    /// A thumbnail still being decoded when the project changes is dropped.
    #[test]
    fn a_thumbnail_started_before_a_clear_is_not_stored() {
        let cache = ThumbnailCache::default();
        let started = cache.generation();
        cache.clear();
        cache.put(started, 1, 256, thumbnail("first project"));
        assert!(cache.get(1, 256).is_none());
    }

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

    fn encode(img: image::DynamicImage, fmt: image::ImageFormat) -> Vec<u8> {
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), fmt).unwrap();
        out
    }

    #[test]
    fn thumbnail_downscales_jpeg_preserving_aspect() {
        let src = image::RgbImage::from_fn(400, 300, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let jpeg = encode(image::DynamicImage::ImageRgb8(src), image::ImageFormat::Jpeg);
        let thumb = decode_thumbnail(&jpeg, 64).unwrap();
        // 400x300 fits in a 64 box as 64x48 (aspect preserved).
        assert!(thumb.width() <= 64 && thumb.height() <= 64);
        assert_eq!(thumb.width(), 64);
        assert!(thumb.height() > 0);
    }

    #[test]
    fn thumbnail_downscales_grayscale_jpeg() {
        let src = image::GrayImage::from_fn(300, 200, |x, _| image::Luma([(x % 256) as u8]));
        let jpeg = encode(image::DynamicImage::ImageLuma8(src), image::ImageFormat::Jpeg);
        let thumb = decode_thumbnail(&jpeg, 32).unwrap();
        assert!(thumb.width() <= 32 && thumb.height() <= 32 && thumb.width() > 0);
    }

    #[test]
    fn overview_decode_shrinks_large_jpeg() {
        let src = image::RgbImage::from_fn(800, 600, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 64])
        });
        let jpeg = encode(image::DynamicImage::ImageRgb8(src), image::ImageFormat::Jpeg);
        let img = decode_downscaled(&jpeg, 100).unwrap();
        assert!(img.width() < 800, "expected DCT downscale, got {}", img.width());
        assert!(img.width() >= 100 && img.height() >= 75);
    }

    #[test]
    fn thumbnail_falls_back_for_png() {
        let src = image::RgbImage::from_fn(200, 150, |x, _| image::Rgb([(x % 256) as u8, 0, 0]));
        let png = encode(image::DynamicImage::ImageRgb8(src), image::ImageFormat::Png);
        let thumb = decode_thumbnail(&png, 64).unwrap();
        assert!(thumb.width() <= 64 && thumb.height() <= 64 && thumb.width() > 0);
    }
}
