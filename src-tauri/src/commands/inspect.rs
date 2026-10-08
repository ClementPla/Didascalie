//! Read-only frame fetches for the sequence inspector.
//!
//! The inspector plays a sequence back like a video, so it asks for frames far
//! faster than the editor does and never edits them. Both commands therefore
//! return raw bytes (`Response`), never JSON or base64, and both work at a
//! *preview* resolution: the longest side is capped at `max_dim`, which bounds
//! what crosses the IPC boundary and what the frontend keeps cached per frame.
//!
//! The image and its labels are separate commands because they decode
//! differently on the other side: the image stays encoded (the webview decodes
//! JPEG/PNG off the main thread), while the labels arrive already composited to
//! RGBA, ready to become a bitmap.

use rayon::prelude::*;
use serde::Deserialize;
use tauri::ipc::Response;
use tauri::State;

use crate::commands::annotation::decode_to_uint8;
use crate::commands::frame::{decode_downscaled, detect_mime_type, read_frame_bytes_ahead};
use crate::storage::{queries, DbState};

/// JPEG quality of a re-encoded preview: playback, not an annotation backdrop,
/// so encode speed and size matter more than being lossless.
const PREVIEW_JPEG_QUALITY: u8 = 85;

/// Entries in a label palette: one RGBA colour per uint8 mask value.
const PALETTE_LEN: usize = 256 * 4;

/// One label to draw, with the colour of each of its mask values (`256*4`
/// RGBA bytes, as built by the frontend's `buildLabelPalette`).
#[derive(Deserialize, Debug)]
pub struct OverlayLabel {
    pub id: i64,
    pub palette: Vec<u8>,
}

/// The size a `width×height` frame is previewed at: unchanged when it already
/// fits `max_dim` (or `max_dim` is 0, meaning "no cap"), otherwise scaled so
/// its longest side is exactly `max_dim`.
fn preview_dimensions(width: u32, height: u32, max_dim: u32) -> (u32, u32) {
    let longest = width.max(height);
    if max_dim == 0 || longest <= max_dim {
        return (width, height);
    }
    let scale = |side: u32| ((side as u64 * max_dim as u64 + longest as u64 / 2) / longest as u64).max(1) as u32;
    (scale(width), scale(height))
}

/// Formats the webview decodes by itself, so their bytes can be passed through.
fn is_browser_decodable(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp"
    )
}

/// A frame's image as *encoded* bytes, no larger than `max_dim` on its longest
/// side. A frame that already fits and that the webview can decode is returned
/// untouched (no decode at all on this side); anything else is downsampled and
/// re-encoded as JPEG.
#[tauri::command]
pub async fn get_frame_preview(
    db: State<'_, DbState>,
    frame_id: i64,
    max_dim: u32,
) -> Result<Response, String> {
    let (meta, bytes) = read_frame_bytes_ahead(&db, frame_id).map_err(|e| e.to_string())?;
    let native = (
        meta.frame.width.max(0) as u32,
        meta.frame.height.max(0) as u32,
    );
    let target = preview_dimensions(native.0, native.1, max_dim);

    if target == native && is_browser_decodable(detect_mime_type(&bytes)) {
        return Ok(Response::new(bytes));
    }

    let longest = target.0.max(target.1).max(1);
    let mut img = decode_downscaled(&bytes, longest).map_err(|e| e.to_string())?;
    if img.width().max(img.height()) > longest {
        img = img.resize(longest, longest, image::imageops::FilterType::Triangle);
    }

    let mut out = Vec::new();
    // JPEG carries neither alpha nor 16-bit samples.
    img.to_rgb8()
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut out,
            PREVIEW_JPEG_QUALITY,
        ))
        .map_err(|e| format!("Failed to encode preview: {}", e))?;
    Ok(Response::new(out))
}

/// Outline thickness in "show only edges" mode, in preview pixels. A preview
/// is about as large as the pane it is shown in, so this is close to the
/// editor's two screen pixels until the user zooms in.
const EDGE_RADIUS: usize = 2;

/// How labels are drawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OverlayMode {
    /// Every labelled pixel takes its label's colour.
    Fill,
    /// Only the outline of each region, this many output pixels thick.
    Edges(usize),
}

/// Flatten `layers` (a `width×height` uint8 mask and its palette each) into
/// `out_w×out_h` RGBA, sampling the masks nearest-neighbour. Layers are given
/// bottom to top: where several are set, the last one shows, as in the editor.
///
/// In [`OverlayMode::Edges`] the outlines are found per layer, before
/// flattening, so a label lying under another keeps its own outline in its own
/// colour. They are found on the *sampled* mask, which keeps their thickness
/// constant on screen whatever the frame's native size.
fn compose_overlay(
    layers: &[(&[u8], &[u8])],
    width: u32,
    height: u32,
    out_w: u32,
    out_h: u32,
    mode: OverlayMode,
) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let (ow, oh) = (out_w as usize, out_h as usize);
    let mut rgba = vec![0u8; ow * oh * 4];
    if w == 0 || h == 0 || ow == 0 || oh == 0 {
        return rgba;
    }

    // Where each output column / row reads from in a mask.
    let columns: Vec<usize> = (0..ow).map(|x| (x * w / ow).min(w - 1)).collect();
    let rows: Vec<usize> = (0..oh).map(|y| (y * h / oh).min(h - 1) * w).collect();
    let sample = |mask: &[u8], x: usize, y: usize| -> u8 {
        mask.get(rows[y] + columns[x]).copied().unwrap_or(0)
    };

    rgba.par_chunks_mut(ow * 4).enumerate().for_each(|(y, row)| {
        for (x, px) in row.chunks_exact_mut(4).enumerate() {
            // Top-most layer that draws here wins: search from the top.
            for (mask, palette) in layers.iter().rev() {
                let v = sample(mask, x, y);
                if v == 0 {
                    continue;
                }
                if let OverlayMode::Edges(radius) = mode {
                    if !is_edge(|x, y| sample(mask, x, y), v, x, y, ow, oh, radius) {
                        continue;
                    }
                }
                let v = v as usize;
                px.copy_from_slice(&palette[v * 4..v * 4 + 4]);
                break;
            }
        }
    });
    rgba
}

/// Whether `(x, y)`, which holds `v`, is on the outline of its region: a tap
/// holds another value (background, another instance) or falls outside the
/// image. Taps are the 4 direct neighbours plus 8 at distance `radius` — the
/// editor's rule, constant cost per pixel whatever the thickness.
#[allow(clippy::too_many_arguments)]
fn is_edge(
    sample: impl Fn(usize, usize) -> u8,
    v: u8,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    radius: usize,
) -> bool {
    let differs = |dx: isize, dy: isize| -> bool {
        let (tx, ty) = (x as isize + dx, y as isize + dy);
        tx < 0
            || ty < 0
            || tx >= width as isize
            || ty >= height as isize
            || sample(tx as usize, ty as usize) != v
    };
    if differs(-1, 0) || differs(1, 0) || differs(0, -1) || differs(0, 1) {
        return true;
    }
    if radius <= 1 {
        return false;
    }
    let r = radius as isize;
    [(-r, 0), (r, 0), (0, -r), (0, r), (-r, -r), (r, -r), (-r, r), (r, r)]
        .into_iter()
        .any(|(dx, dy)| differs(dx, dy))
}

/// The labels of a frame composited to RGBA at preview resolution.
///
/// `labels` lists what to draw, bottom to top; a label left out is not drawn,
/// which is how the caller hides one. With `edges_only`, regions are outlined
/// instead of filled. The reply is an 8-byte header — output
/// width and height as little-endian `u32` — followed by `width*height*4` RGBA
/// bytes. A frame with nothing to draw replies with no bytes at all, so the
/// caller can skip the overlay instead of holding a transparent bitmap.
#[tauri::command]
pub async fn render_label_overlay(
    db: State<'_, DbState>,
    frame_id: i64,
    max_dim: u32,
    labels: Vec<OverlayLabel>,
    edges_only: bool,
) -> Result<Response, String> {
    if let Some(bad) = labels.iter().find(|l| l.palette.len() < PALETTE_LEN) {
        return Err(format!(
            "Label {} has a palette of {} bytes, expected {}",
            bad.id,
            bad.palette.len(),
            PALETTE_LEN
        ));
    }

    let ((width, height), annotations) = db
        .with_conn(|conn| {
            Ok((
                queries::get_frame_dimensions(conn, frame_id)?,
                queries::load_annotations(conn, frame_id)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    // Decoding is the expensive part; one mask per requested label, in the
    // caller's order, dropping the ones that turn out empty.
    let masks: Vec<(usize, Vec<u8>)> = labels
        .par_iter()
        .enumerate()
        .filter_map(|(index, label)| {
            let annotation = annotations.iter().find(|a| a.label_id == label.id)?;
            let mask = decode_to_uint8(&annotation.mask_data, &annotation.encoding, width, height);
            mask.iter().any(|&v| v != 0).then_some((index, mask))
        })
        .collect();

    if masks.is_empty() {
        return Ok(Response::new(Vec::new()));
    }

    let layers: Vec<(&[u8], &[u8])> = masks
        .iter()
        .map(|(index, mask)| (mask.as_slice(), labels[*index].palette.as_slice()))
        .collect();
    let (out_w, out_h) = preview_dimensions(width, height, max_dim);
    let mode = if edges_only {
        OverlayMode::Edges(EDGE_RADIUS)
    } else {
        OverlayMode::Fill
    };
    let rgba = compose_overlay(&layers, width, height, out_w, out_h, mode);

    let mut reply = Vec::with_capacity(8 + rgba.len());
    reply.extend_from_slice(&out_w.to_le_bytes());
    reply.extend_from_slice(&out_h.to_le_bytes());
    reply.extend_from_slice(&rgba);
    Ok(Response::new(reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A palette mapping every non-zero value to one opaque colour.
    fn palette(rgb: [u8; 3]) -> Vec<u8> {
        let mut p = vec![0u8; PALETTE_LEN];
        for v in 1..256 {
            p[v * 4..v * 4 + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
        }
        p
    }

    #[test]
    fn a_frame_that_fits_keeps_its_size() {
        assert_eq!(preview_dimensions(640, 480, 1024), (640, 480));
        assert_eq!(preview_dimensions(1024, 1024, 1024), (1024, 1024));
    }

    #[test]
    fn zero_means_no_cap() {
        assert_eq!(preview_dimensions(8000, 6000, 0), (8000, 6000));
    }

    #[test]
    fn a_large_frame_is_scaled_on_its_longest_side() {
        assert_eq!(preview_dimensions(4000, 2000, 1000), (1000, 500));
        assert_eq!(preview_dimensions(2000, 4000, 1000), (500, 1000));
    }

    #[test]
    fn a_very_thin_frame_never_collapses_to_zero() {
        assert_eq!(preview_dimensions(10000, 1, 100), (100, 1));
    }

    #[test]
    fn background_stays_transparent() {
        let mask = [0u8, 1, 0, 0];
        let red = palette([255, 0, 0]);
        let out = compose_overlay(&[(&mask, &red)], 2, 2, 2, 2, OverlayMode::Fill);
        assert_eq!(&out[0..4], &[0, 0, 0, 0]);
        assert_eq!(&out[4..8], &[255, 0, 0, 255]);
        assert_eq!(&out[8..16], &[0u8; 8]);
    }

    #[test]
    fn the_last_layer_shows_where_layers_overlap() {
        let below = [1u8, 1];
        let above = [0u8, 1];
        let red = palette([255, 0, 0]);
        let blue = palette([0, 0, 255]);
        let out = compose_overlay(&[(&below, &red), (&above, &blue)], 2, 1, 2, 1, OverlayMode::Fill);
        assert_eq!(&out[0..4], &[255, 0, 0, 255]);
        assert_eq!(&out[4..8], &[0, 0, 255, 255]);
    }

    #[test]
    fn an_instance_value_picks_its_own_palette_entry() {
        let mask = [3u8];
        let mut p = vec![0u8; PALETTE_LEN];
        p[3 * 4..3 * 4 + 4].copy_from_slice(&[10, 20, 30, 255]);
        assert_eq!(compose_overlay(&[(&mask, &p)], 1, 1, 1, 1, OverlayMode::Fill), vec![10, 20, 30, 255]);
    }

    #[test]
    fn downsampling_samples_nearest_and_keeps_the_output_size() {
        // 4×2 mask, left half set, shrunk to 2×1.
        let mask = [1u8, 1, 0, 0, 1, 1, 0, 0];
        let red = palette([255, 0, 0]);
        let out = compose_overlay(&[(&mask, &red)], 4, 2, 2, 1, OverlayMode::Fill);
        assert_eq!(out, vec![255, 0, 0, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn a_mask_shorter_than_the_frame_reads_as_background() {
        // A ragged annotation must not panic the whole frame.
        let mask = [1u8];
        let red = palette([255, 0, 0]);
        let out = compose_overlay(&[(&mask, &red)], 2, 1, 2, 1, OverlayMode::Fill);
        assert_eq!(out, vec![255, 0, 0, 255, 0, 0, 0, 0]);
    }

    /// Alpha of each output pixel as a grid of `#` (drawn) and `.` rows.
    fn drawn(rgba: &[u8], width: usize) -> Vec<String> {
        rgba.chunks_exact(4)
            .map(|px| if px[3] != 0 { '#' } else { '.' })
            .collect::<Vec<_>>()
            .chunks(width)
            .map(|row| row.iter().collect())
            .collect()
    }

    /// A `size×size` mask with a filled square from `from` to `to` (exclusive).
    fn square(size: usize, from: usize, to: usize, value: u8) -> Vec<u8> {
        let mut mask = vec![0u8; size * size];
        for y in from..to {
            for x in from..to {
                mask[y * size + x] = value;
            }
        }
        mask
    }

    #[test]
    fn edges_outline_a_region_and_leave_its_inside_empty() {
        let mask = square(7, 1, 6, 1);
        let red = palette([255, 0, 0]);
        let out = compose_overlay(&[(&mask, &red)], 7, 7, 7, 7, OverlayMode::Edges(1));
        assert_eq!(
            drawn(&out, 7),
            vec![".......", ".#####.", ".#...#.", ".#...#.", ".#...#.", ".#####.", "......."]
        );
    }

    #[test]
    fn a_wider_radius_thickens_the_outline_inwards() {
        let mask = square(9, 1, 8, 1);
        let red = palette([255, 0, 0]);
        let out = compose_overlay(&[(&mask, &red)], 9, 9, 9, 9, OverlayMode::Edges(2));
        let rows = drawn(&out, 9);
        assert_eq!(rows[1], ".#######.");
        assert_eq!(rows[2], ".#######.");
        assert_eq!(rows[3], ".##...##.");
        assert_eq!(rows[4], ".##...##.");
    }

    #[test]
    fn a_region_touching_the_border_is_outlined_along_it() {
        let mask = vec![1u8; 9];
        let red = palette([255, 0, 0]);
        let out = compose_overlay(&[(&mask, &red)], 3, 3, 3, 3, OverlayMode::Edges(1));
        assert_eq!(drawn(&out, 3), vec!["###", "#.#", "###"]);
    }

    #[test]
    fn two_instances_of_a_label_are_outlined_separately() {
        // Left half is instance 1, right half instance 2: the seam is an edge
        // on both sides even though no pixel there is background.
        let mask = [1u8, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2];
        let red = palette([255, 0, 0]);
        let out = compose_overlay(&[(&mask, &red)], 4, 3, 4, 3, OverlayMode::Edges(1));
        assert_eq!(drawn(&out, 4), vec!["####", "####", "####"]);
    }

    #[test]
    fn a_label_under_another_keeps_its_outline() {
        // A small blue square over the middle of a larger red one: red's
        // inside is empty there, so only blue's outline shows — but red's own
        // outline, which blue does not cover, is still drawn in red.
        let below = square(7, 0, 7, 1);
        let above = square(7, 2, 5, 1);
        let red = palette([255, 0, 0]);
        let blue = palette([0, 0, 255]);
        let out = compose_overlay(
            &[(&below, &red), (&above, &blue)],
            7,
            7,
            7,
            7,
            OverlayMode::Edges(1),
        );
        assert_eq!(&out[0..4], &[255, 0, 0, 255]); // red's corner
        let at = |x: usize, y: usize| &out[(y * 7 + x) * 4..(y * 7 + x) * 4 + 4];
        assert_eq!(at(2, 2), &[0, 0, 255, 255]); // blue's corner
        assert_eq!(at(3, 3), &[0, 0, 0, 0]); // inside both
        assert_eq!(at(1, 1), &[0, 0, 0, 0]); // inside red, outside blue
    }
}
