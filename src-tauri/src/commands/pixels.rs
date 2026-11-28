//! Raw frame pixels: their description, statistics, values, and 8-bit renders
//! through a sequence's display settings. See `crate::pixels`.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;
use ts_rs::TS;

use crate::commands::frame::{overview_from_bytes, ThumbnailCache};
use crate::frames::{read_frame_bytes, Frame};
use crate::pixels::cache::{Decoded, RawFrameCache};
use crate::pixels::raw;
use crate::pixels::picture::effective_settings;
use crate::pixels::display::{render_rgb, step_for, window_at, DisplaySettings, Region};
use crate::pixels::stats;
use crate::storage::{queries, DbState};
use crate::utils::error::{AppError, Result};

/// One channel's smallest and largest value.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct ValueRange {
    pub min: f64,
    pub max: f64,
}

/// What a frame's pixels are.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct PixelInfo {
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    #[ts(type = "\"u8\" | \"u16\" | \"f32\"")]
    pub sample_type: String,
    /// Bits used by 16-bit data, e.g. 12 for a 12-bit camera; null otherwise.
    pub significant_bits: Option<u8>,
    /// 8-bit with three channels: shown as stored, the image adjustments apply.
    pub is_rgb8: bool,
    pub ranges: Vec<ValueRange>,
}

/// An 8-bit render of a frame for display.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct RenderedImage {
    /// Size of the render; at most the requested `max_dim` per side.
    pub width: u32,
    pub height: u32,
    pub native_width: u32,
    pub native_height: u32,
    /// A data URL: `data:image/png;base64,...`.
    pub image_base64: String,
}

fn pixel_info(d: &Decoded) -> PixelInfo {
    let f = &d.frame;
    PixelInfo {
        width: f.width,
        height: f.height,
        channels: f.channels as u32,
        sample_type: f.sample_type().as_str().to_string(),
        significant_bits: stats::significant_bits(f, &d.stats),
        is_rgb8: f.is_rgb8(),
        ranges: d
            .stats
            .iter()
            .map(|s| ValueRange {
                min: s.min as f64,
                max: s.max as f64,
            })
            .collect(),
    }
}

#[tauri::command]
pub fn frame_pixel_info(
    db: State<DbState>,
    cache: State<RawFrameCache>,
    frame_id: i64,
) -> Result<PixelInfo> {
    let d = cache.get(&db, frame_id)?;
    Ok(pixel_info(&d))
}

/// A channel's histogram in `bins` bins over `[min, max]`.
#[tauri::command]
pub fn frame_histogram(
    db: State<DbState>,
    cache: State<RawFrameCache>,
    frame_id: i64,
    channel: u32,
    bins: u32,
    min: f64,
    max: f64,
    log: Option<bool>,
) -> Result<Vec<u32>> {
    let d = cache.get(&db, frame_id)?;
    let s = d
        .stats
        .get(channel as usize)
        .ok_or_else(|| AppError::Generic(format!("The frame has no channel {channel}")))?;
    Ok(s.rebin(bins.clamp(1, 4096) as usize, min as f32, max as f32, log.unwrap_or(false)))
}

/// The raw value of every channel at native pixel (x, y); empty outside the
/// frame.
#[tauri::command]
pub fn pixel_values(
    db: State<DbState>,
    cache: State<RawFrameCache>,
    frame_id: i64,
    x: i64,
    y: i64,
) -> Result<Vec<f64>> {
    let d = cache.get(&db, frame_id)?;
    let f = &d.frame;
    if x < 0 || y < 0 || x >= f.width as i64 || y >= f.height as i64 {
        return Ok(Vec::new());
    }
    let i = y as usize * f.width as usize + x as usize;
    Ok((0..f.channels).map(|c| f.value(c, i) as f64).collect())
}

/// The settings a frame is displayed with (its sequence's, or automatic).
#[tauri::command]
pub fn get_display_settings(
    db: State<DbState>,
    cache: State<RawFrameCache>,
    frame_id: i64,
) -> Result<DisplaySettings> {
    let d = cache.get(&db, frame_id)?;
    effective_settings(&db, &d, frame_id)
}

/// The automatic settings for a frame, whatever is stored. With `low` and
/// `high` (percentiles, 0–1), every channel's window runs between them, 8-bit
/// ones included; otherwise the default automatic window.
#[tauri::command]
pub fn auto_display_settings(
    db: State<DbState>,
    cache: State<RawFrameCache>,
    frame_id: i64,
    low: Option<f64>,
    high: Option<f64>,
) -> Result<DisplaySettings> {
    let d = cache.get(&db, frame_id)?;
    let mut settings = DisplaySettings::auto(&d.frame, &d.stats);
    if let (Some(low), Some(high)) = (low, high) {
        for (ch, s) in settings.channels.iter_mut().zip(&d.stats) {
            (ch.min, ch.max) = window_at(s, low, high);
        }
    }
    Ok(settings)
}

/// The frame's raw values, box-averaged so its longest side is at most
/// `max_dim`, for the panel to preview a display while a window is dragged:
/// a header of four little-endian u32 (width, height, channels, 0), then
/// every channel's plane as little-endian f32.
#[tauri::command]
pub fn preview_samples(
    db: State<DbState>,
    cache: State<RawFrameCache>,
    frame_id: i64,
    max_dim: u32,
) -> Result<Response> {
    let d = cache.get(&db, frame_id)?;
    Ok(Response::new(preview_bytes(&d.frame, max_dim)))
}

fn preview_bytes(frame: &raw::RawFrame, max_dim: u32) -> Vec<u8> {
    let step = step_for(Region::full(frame), max_dim) as usize;
    let (fw, fh) = (frame.width as usize, frame.height as usize);
    let (w, h) = (fw.div_ceil(step), fh.div_ceil(step));
    let mut out = Vec::with_capacity(16 + w * h * frame.channels * 4);
    for v in [w as u32, h as u32, frame.channels as u32, 0] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for c in 0..frame.channels {
        for oy in 0..h {
            for ox in 0..w {
                let (mut sum, mut n) = (0f32, 0u32);
                for y in oy * step..((oy + 1) * step).min(fh) {
                    for x in ox * step..((ox + 1) * step).min(fw) {
                        sum += frame.value(c, y * fw + x);
                        n += 1;
                    }
                }
                out.extend_from_slice(&(sum / n.max(1) as f32).to_le_bytes());
            }
        }
    }
    out
}

/// Store the display of a sequence's frames; `None` returns to automatic.
#[tauri::command]
pub fn set_display_settings(
    db: State<DbState>,
    thumbnails: State<ThumbnailCache>,
    sequence_id: i64,
    settings: Option<DisplaySettings>,
) -> Result<()> {
    let json = settings.map(|s| serde_json::to_string(&s)).transpose()?;
    db.with_conn(|conn| queries::save_display_settings(conn, sequence_id, json.as_deref()))?;
    // Thumbnails of rendered frames show the old display.
    thumbnails.clear();
    Ok(())
}

/// The whole frame, rendered with its display settings and downsampled so its
/// longest side is at most `max_dim` (0: native size).
#[tauri::command]
pub fn render_frame_image(
    db: State<DbState>,
    cache: State<RawFrameCache>,
    frame_id: i64,
    max_dim: u32,
) -> Result<RenderedImage> {
    let d = cache.get(&db, frame_id)?;
    let settings = effective_settings(&db, &d, frame_id)?;
    let region = Region::full(&d.frame);
    let (w, h, rgb) = render_rgb(&d.frame, &settings, region, step_for(region, max_dim));
    Ok(RenderedImage {
        width: w,
        height: h,
        native_width: d.frame.width,
        native_height: d.frame.height,
        image_base64: format!(
            "data:image/png;base64,{}",
            BASE64.encode(encode_png(w, h, &rgb)?)
        ),
    })
}

/// A native-resolution RGBA tile, rendered with the frame's display settings:
/// `width*height*4` bytes, transparent outside the frame. Same layout as
/// `get_frame_tile`.
#[tauri::command(async)]
pub fn render_frame_tile(
    db: State<DbState>,
    cache: State<RawFrameCache>,
    frame_id: i64,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<Response> {
    let d = cache.get(&db, frame_id)?;
    let settings = effective_settings(&db, &d, frame_id)?;
    let region = Region {
        x,
        y,
        width,
        height,
    }
    .bounded(d.frame.width, d.frame.height)
    .map_err(AppError::Generic)?;
    let (_, _, rgb) = render_rgb(&d.frame, &settings, region, 1);
    Ok(Response::new(rgb_to_tile_rgba(
        &rgb,
        region,
        d.frame.width,
        d.frame.height,
    )))
}

/// What the editor shows for a frame.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct FrameDisplay {
    pub frame: Frame,
    /// A data URL. Native size, or downsampled to `max_dim` for a larger frame.
    pub image_base64: String,
    /// Set when the image is a render of raw pixels (deeper than 8 bits, or
    /// several channels): tiles then come from `render_frame_tile`, and the
    /// display settings apply.
    pub raw: Option<PixelInfo>,
}

/// The image the editor shows for a frame. An ordinary 8-bit image is sent as
/// stored (or as a downsampled overview when larger than `max_dim`), exactly as
/// before; anything deeper is decoded and rendered with its display settings.
#[tauri::command]
pub fn load_frame_display(
    db: State<DbState>,
    cache: State<RawFrameCache>,
    frame_id: i64,
    max_dim: u32,
) -> Result<FrameDisplay> {
    let (meta, bytes) = read_frame_bytes(&db, frame_id)?;
    if !raw::needs_render(&bytes) {
        let image = overview_from_bytes(meta, bytes, max_dim)?;
        return Ok(FrameDisplay { frame: image.frame, image_base64: image.image_base64, raw: None });
    }
    let d = cache.get_from_bytes(frame_id, &bytes)?;
    drop(bytes);
    let settings = effective_settings(&db, &d, frame_id)?;
    let region = Region::full(&d.frame);
    let (w, h, rgb) = render_rgb(&d.frame, &settings, region, step_for(region, max_dim));
    Ok(FrameDisplay {
        frame: meta.frame,
        image_base64: format!("data:image/png;base64,{}", BASE64.encode(encode_png(w, h, &rgb)?)),
        raw: Some(pixel_info(&d)),
    })
}

/// RGBA from RGB, with alpha 0 where the region lies outside the frame.
fn rgb_to_tile_rgba(rgb: &[u8], region: Region, frame_w: u32, frame_h: u32) -> Vec<u8> {
    let mut out = vec![0u8; region.width as usize * region.height as usize * 4];
    for ty in 0..region.height {
        for tx in 0..region.width {
            let i = ty as usize * region.width as usize + tx as usize;
            let inside = region.x + tx < frame_w && region.y + ty < frame_h;
            out[i * 4..i * 4 + 3].copy_from_slice(&rgb[i * 3..i * 3 + 3]);
            out[i * 4 + 3] = if inside { 255 } else { 0 };
        }
    }
    out
}

/// PNG with fast compression: renders are recomputed whenever the window
/// changes, so speed matters more than size.
fn encode_png(w: u32, h: u32, rgb: &[u8]) -> Result<Vec<u8>> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(rgb, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| AppError::Generic(format!("Failed to encode render: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pixels::picture::frame_picture;
    use std::path::Path;

    #[test]
    fn preview_bytes_average_blocks_per_channel() {
        // 4x2, two channels; a step of 2 gives 2x1.
        let frame = raw::RawFrame {
            width: 4,
            height: 2,
            channels: 2,
            samples: raw::Samples::U16(vec![
                0, 2, 10, 10, 2, 4, 30, 30, // channel 0
                1, 1, 1, 1, 1, 1, 1, 1, // channel 1
            ]),
        };
        let bytes = preview_bytes(&frame, 2);
        let word = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!((word(0), word(1), word(2)), (2, 1, 2));
        let value = |i: usize| f32::from_le_bytes(bytes[16 + i * 4..20 + i * 4].try_into().unwrap());
        assert_eq!([value(0), value(1), value(2), value(3)], [2.0, 20.0, 1.0, 1.0]);
    }

    #[test]
    fn tiles_are_transparent_outside_the_frame() {
        let rgb = vec![10, 20, 30, 40, 50, 60];
        let rgba = rgb_to_tile_rgba(
            &rgb,
            Region {
                x: 1,
                y: 0,
                width: 2,
                height: 1,
            },
            2,
            1,
        );
        assert_eq!(rgba, vec![10, 20, 30, 255, 40, 50, 60, 0]);
    }

    #[test]
    fn display_settings_are_stored_per_sequence() {
        let conn = queries::create_database(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO sequences (id, name) VALUES (1, 's'), (2, 't');
             INSERT INTO frames (id, sequence_id, frame_index, width, height) VALUES (7, 2, 0, 4, 4);",
        )
        .unwrap();
        assert_eq!(queries::frame_sequence_id(&conn, 7).unwrap(), 2);
        assert_eq!(queries::load_display_settings(&conn, 2).unwrap(), None);

        queries::save_display_settings(&conn, 2, Some("{\"channels\":[]}")).unwrap();
        queries::save_display_settings(&conn, 2, Some("{\"channels\":[1]}")).unwrap();
        assert_eq!(
            queries::load_display_settings(&conn, 2).unwrap().as_deref(),
            Some("{\"channels\":[1]}")
        );
        assert_eq!(queries::load_display_settings(&conn, 1).unwrap(), None);

        queries::save_display_settings(&conn, 2, None).unwrap();
        assert_eq!(queries::load_display_settings(&conn, 2).unwrap(), None);
    }

    #[test]
    fn pictures_of_deep_frames_go_through_the_sequence_display() {
        use crate::pixels::display::ChannelDisplay;
        use tiff::encoder::{colortype::Gray16, TiffEncoder};

        let conn = queries::create_database(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO sequences (id, name) VALUES (1, 's');
             INSERT INTO frames (id, sequence_id, frame_index, width, height) VALUES (7, 1, 0, 2, 1);",
        )
        .unwrap();
        let channel = |color: &str| ChannelDisplay {
            name: None,
            visible: true,
            color: color.into(),
            min: 0.0,
            max: 1000.0,
            gamma: 1.0,
        };
        let settings = DisplaySettings { channels: vec![channel("#ff0000"), channel("#00ff00")] };
        queries::save_display_settings(&conn, 1, Some(&serde_json::to_string(&settings).unwrap())).unwrap();
        let db = DbState::new();
        db.set(conn);

        // Two 16-bit channels: [0, 1000] in red, [1000, 0] in green.
        let mut tiff = std::io::Cursor::new(Vec::new());
        {
            let mut enc = TiffEncoder::new(&mut tiff).unwrap();
            enc.write_image::<Gray16>(2, 1, &[0, 1000]).unwrap();
            enc.write_image::<Gray16>(2, 1, &[1000, 0]).unwrap();
        }
        let picture = frame_picture(&db, 7, tiff.get_ref(), 0).unwrap().to_rgb8();
        assert_eq!(picture.into_raw(), vec![0, 255, 0, 255, 0, 0]);

        // An ordinary image keeps its size at 0, JPEG included.
        let jpeg = {
            let mut out = Vec::new();
            image::RgbImage::from_pixel(64, 32, image::Rgb([9, 9, 9]))
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
                .unwrap();
            out
        };
        let picture = frame_picture(&db, 7, &jpeg, 0).unwrap();
        assert_eq!((picture.width(), picture.height()), (64, 32));
    }

    #[test]
    fn a_rendered_png_decodes_to_the_same_pixels() {
        let rgb = vec![255, 0, 0, 0, 128, 255];
        let png = encode_png(2, 1, &rgb).unwrap();
        let back = image::load_from_memory(&png).unwrap().to_rgb8();
        assert_eq!(back.into_raw(), rgb);
    }
}
