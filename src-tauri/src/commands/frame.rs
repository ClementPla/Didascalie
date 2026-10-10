use base64::{ engine::general_purpose::STANDARD as BASE64, Engine };
use rusqlite::params;
use serde::{ Serialize };
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::State;

use crate::storage::DbState;
use crate::utils::error::{ AppError, Result };

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct FrameImage {
  pub frame: Frame,
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
      .map_err(|e| AppError::Database(e))?;

    let reviewed: i64 = conn
      .query_row("SELECT COUNT(*) FROM frame_reviews", [], |row| row.get(0))
      .map_err(|e| AppError::Database(e))?;

    Ok((reviewed, total))
  })
}

// ── Frame Retrieval ────────────────────────────────────────────────────────
pub struct FrameMeta { pub frame: Frame }

pub fn read_frame_bytes(
    db: &DbState,
    frame_id: i64,
) -> Result<(FrameMeta, Vec<u8>)> {
    read_frame_bytes_with(db, frame_id, false)
}

/// [`read_frame_bytes`], for a caller going through a sequence in order: a
/// video frame is decoded together with the ones that follow it (see
/// `crate::video::read_run`).
pub fn read_frame_bytes_ahead(
    db: &DbState,
    frame_id: i64,
) -> Result<(FrameMeta, Vec<u8>)> {
    read_frame_bytes_with(db, frame_id, true)
}

fn read_frame_bytes_with(
    db: &DbState,
    frame_id: i64,
    ahead: bool,
) -> Result<(FrameMeta, Vec<u8>)> {
    use crate::video::RunFrame;

    /// Where a frame's pixels are, once the row has been read.
    enum Source {
        Embedded(Vec<u8>),
        File(std::path::PathBuf),
        Video {
            path: std::path::PathBuf,
            seek_margin: f64,
            seek_preroll: f64,
            frame: RunFrame,
            ahead: Vec<RunFrame>,
        },
    }

    let image_root = db.image_root();
    // Only the row is read under the connection lock: decoding can take a while.
    let (frame, source) = db.with_conn(|conn| {
        let row = conn.query_row(
            "SELECT f.id, f.sequence_id, f.frame_index, f.relative_path,
                    f.embedded_data, f.width, f.height,
                    EXISTS (SELECT 1 FROM frame_reviews r WHERE r.frame_id = f.id),
                    json_extract(p.config, '$.input_folder'),
                    v.relative_path, f.video_time, v.seek_margin,
                    f.video_id, f.video_frame, v.seek_preroll
             FROM frames f
             JOIN sequences s ON f.sequence_id = s.id
             JOIN project p ON p.id = 1
             LEFT JOIN videos v ON v.id = f.video_id
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
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<f64>>(10)?,
                row.get::<_, Option<f64>>(11)?,
                row.get::<_, Option<i64>>(12)?,
                row.get::<_, Option<i64>>(13)?,
                row.get::<_, Option<f64>>(14)?,
            )),
        ).map_err(AppError::Database)?;

        let (id, sequence_id, frame_index, relative_path,
             embedded_data, width, height, reviewed, input_folder,
             video_path, video_time, seek_margin, video_id, video_frame, seek_preroll) = row;

        let is_embedded = embedded_data.is_some();
        // The folder as this computer reaches it, when the project was opened
        // through `open_project`; the one it was created with otherwise.
        let input_folder = image_root.or(input_folder.map(PathBuf::from));
        let in_input_folder = |rel: &str| {
            input_folder
                .as_deref()
                .map(|folder| crate::commands::project::join_relative(folder, rel))
                .ok_or_else(|| AppError::Generic("Project has no input_folder in config".into()))
        };
        let source = if let Some(data) = embedded_data {
            Source::Embedded(data)
        } else if let (Some(video), Some(time)) = (&video_path, video_time) {
            let path = in_input_folder(video)?;
            let video_frame = video_frame.unwrap_or(0);
            // The following frames are looked up only when this one must be decoded.
            let following = if ahead && !crate::video::is_cached(&path, time) {
                let limit = crate::video::run_length(width.max(0) as u32, height.max(0) as u32);
                let mut stmt = conn.prepare_cached(
                    "SELECT video_time, video_frame FROM frames
                     WHERE video_id = ?1 AND video_frame > ?2
                     ORDER BY video_frame LIMIT ?3",
                )?;
                let rows = stmt.query_map(params![video_id, video_frame, limit as i64], |row| {
                    Ok(RunFrame {
                        time: row.get(0)?,
                        video_frame: row.get::<_, i64>(1)?.max(0) as usize,
                    })
                })?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            } else {
                Vec::new()
            };
            Source::Video {
                path,
                seek_margin: seek_margin.unwrap_or(0.0),
                seek_preroll: seek_preroll.unwrap_or(0.0),
                frame: RunFrame { time, video_frame: video_frame.max(0) as usize },
                ahead: following,
            }
        } else if let Some(ref rel) = relative_path {
            Source::File(in_input_folder(rel)?)
        } else {
            return Err(AppError::Generic("Frame has no image data".into()));
        };

        Ok((
            Frame {
                id, sequence_id, frame_index, relative_path,
                width, height, reviewed, is_embedded,
            },
            source,
        ))
    })?;

    let bytes = match source {
        Source::Embedded(data) => data,
        Source::File(full) => fs::read(&full).map_err(|e| AppError::Io(
            std::io::Error::new(e.kind(),
                format!("Failed to read image: {}", full.display()))
        ))?,
        Source::Video { path, seek_margin, seek_preroll, frame, ahead } => {
            if !path.is_file() {
                return Err(AppError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("Failed to read video: {}", path.display()),
                )));
            }
            crate::video::read_run(&path, seek_margin, seek_preroll, frame, &ahead)?
        }
    };

    Ok((FrameMeta { frame }, bytes))
}

#[tauri::command]
pub fn get_frame_image(db: State<DbState>, frame_id: i64) -> Result<FrameImage> {
    let (meta, bytes) = read_frame_bytes(&db, frame_id)?;
    let mime = detect_mime_type(&bytes);
    let image_base64 = format!("data:{};base64,{}", mime, BASE64.encode(&bytes));
    Ok(FrameImage { frame: meta.frame, image_base64 })
}

/// A display image for a frame, downsampled so its longest side is ≤
/// `max_dim`. `frame.width` / `frame.height` stay the native dimensions.
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

/// Decode an image to a longest side ≥ `max_dim`. A JPEG is scaled during
/// decoding (1/1, 1/2, 1/4 or 1/8), so a very large one is never fully
/// decoded; other formats are.
pub(crate) fn decode_downscaled(bytes: &[u8], max_dim: u32) -> Result<image::DynamicImage> {
  if detect_mime_type(bytes) == "image/jpeg" {
    if let Some(img) = decode_jpeg_downscaled(bytes, max_dim) {
      return Ok(img);
    }
  }
  image::load_from_memory(bytes)
    .map_err(|e| AppError::Generic(format!("Failed to decode image: {}", e)))
}

fn decode_thumbnail(bytes: &[u8], max: u32) -> Result<image::DynamicImage> {
  Ok(decode_downscaled(bytes, max)?.thumbnail(max, max))
}

/// DCT-scaled JPEG decode to roughly `max` px. None on an unsupported pixel
/// format or a decode error.
fn decode_jpeg_downscaled(bytes: &[u8], max: u32) -> Option<image::DynamicImage> {
  use jpeg_decoder::{Decoder, PixelFormat};

  let mut dec = Decoder::new(std::io::Cursor::new(bytes));
  let target = max.clamp(1, u16::MAX as u32) as u16;
  let (w, h) = dec.scale(target, target).ok()?; // sets the DCT scale factor
  let pixels = dec.decode().ok()?;
  let (w, h) = (w as u32, h as u32);
  match dec.info()?.pixel_format {
    PixelFormat::L8 => image::GrayImage::from_raw(w, h, pixels).map(image::DynamicImage::ImageLuma8),
    PixelFormat::RGB24 => image::RgbImage::from_raw(w, h, pixels).map(image::DynamicImage::ImageRgb8),
    _ => None,
  }
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
  let generation = cache.generation();

  let (meta, bytes) = read_frame_bytes(&db, frame_id)?;

  let thumbnail = decode_thumbnail(&bytes, max_size)?;

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

/// A native-resolution RGBA tile of a frame, as raw bytes (`width*height*4`,
/// row-major).
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

// ── Utility ────────────────────────────────────────────────────────────────

pub(crate) fn detect_mime_type(data: &[u8]) -> &'static str {
  if data.len() < 8 {
    return "application/octet-stream";
  }

  if data.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
    return "image/png";
  }

  if data.starts_with(&[0xff, 0xd8, 0xff]) {
    return "image/jpeg";
  }

  if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
    return "image/gif";
  }

  if data.starts_with(b"BM") {
    return "image/bmp";
  }

  // TIFF, little- or big-endian.
  if data.starts_with(&[0x49, 0x49, 0x2a, 0x00]) || data.starts_with(&[0x4d, 0x4d, 0x00, 0x2a]) {
    return "image/tiff";
  }

  if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
    return "image/webp";
  }

  "application/octet-stream"
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
