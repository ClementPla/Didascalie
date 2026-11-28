//! Frames as pictures: decoding, downscaled, and rendering through a
//! sequence's display settings.

use super::cache::Decoded;
use super::display::{render_rgb, step_for, DisplaySettings, Region};
use super::raw;
use crate::storage::{queries, DbState};
use crate::utils::error::{AppError, Result};

/// The settings a frame is displayed with: its sequence's, when they fit the
/// frame, otherwise the automatic ones.
pub fn effective_settings(db: &DbState, d: &Decoded, frame_id: i64) -> Result<DisplaySettings> {
    let stored = db.with_conn(|conn| {
        let sequence_id = queries::frame_sequence_id(conn, frame_id)?;
        queries::load_display_settings(conn, sequence_id)
    })?;
    Ok(stored
        .and_then(|json| serde_json::from_str::<DisplaySettings>(&json).ok())
        .filter(|s| s.fits(&d.frame))
        .unwrap_or_else(|| DisplaySettings::auto(&d.frame, &d.stats)))
}

/// A frame as a picture (thumbnails, previews, 3D, comparisons), its longest
/// side at most about `max_dim` (0: native size). A frame deeper than 8 bits
/// or with several channels is rendered through its sequence's display
/// settings; any other is decoded as stored.
pub fn frame_picture(
    db: &DbState,
    frame_id: i64,
    bytes: &[u8],
    max_dim: u32,
) -> Result<image::DynamicImage> {
    if !raw::needs_render(bytes) {
        // `decode_downscaled` reads 0 as "as small as possible".
        return if max_dim == 0 {
            image::load_from_memory(bytes)
                .map_err(|e| AppError::Generic(format!("Failed to decode image: {e}")))
        } else {
            decode_downscaled(bytes, max_dim)
        };
    }
    let d = Decoded::new(raw::decode(bytes)?);
    let settings = effective_settings(db, &d, frame_id)?;
    let region = Region::full(&d.frame);
    let (w, h, rgb) = render_rgb(&d.frame, &settings, region, step_for(region, max_dim));
    image::RgbImage::from_raw(w, h, rgb)
        .map(image::DynamicImage::ImageRgb8)
        .ok_or_else(|| AppError::Generic("Render has the wrong size".into()))
}

/// Decode an image to a longest side ≥ `max_dim`. A JPEG is scaled during
/// decoding (1/1, 1/2, 1/4 or 1/8), so a very large one is never fully
/// decoded; other formats are.
pub fn decode_downscaled(bytes: &[u8], max_dim: u32) -> Result<image::DynamicImage> {
  if detect_mime_type(bytes) == "image/jpeg" {
    if let Some(img) = decode_jpeg_downscaled(bytes, max_dim) {
      return Ok(img);
    }
  }
  image::load_from_memory(bytes)
    .map_err(|e| AppError::Generic(format!("Failed to decode image: {}", e)))
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

/// The image type of `data`, from its magic bytes.
pub fn detect_mime_type(data: &[u8]) -> &'static str {
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
