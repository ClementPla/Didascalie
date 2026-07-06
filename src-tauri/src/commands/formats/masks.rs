//! Didascalie's native mask output as a first-class format, so the whole export
//! UI is uniform (no legacy special-case). Individual label masks, a combined
//! index map, an RGB colormap, and vector-shape JSON — all from the IR.

use std::fs;
use std::path::Path;

use image::{GrayImage, RgbImage};
use serde_json::json;

use super::{bool_opt, get_bool, Capabilities, ExportFormat, OptionSpec, OptionValues, Progress};
use crate::types::dataset::{Dataset, FrameData};
use crate::utils::error::Result;
use crate::utils::AppError;

pub struct Masks;

impl ExportFormat for Masks {
    fn id(&self) -> &str {
        "masks"
    }
    fn name(&self) -> &str {
        "Didascalie masks"
    }
    fn description(&self) -> &str {
        "PNG masks (individual, combined index map, RGB colormap) + vector JSON."
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            masks: true,
            polygons: true,
            bboxes: false,
            classifications: false,
            instances: true,
        }
    }
    fn options(&self) -> Vec<OptionSpec> {
        vec![
            bool_opt("individual", "Individual label masks", true),
            bool_opt("combined", "Combined index map", true),
            bool_opt("colormap", "Colormap (RGB)", true),
            bool_opt("vectors", "Vector shapes (JSON)", true),
        ]
    }

    fn export(
        &self,
        dataset: &Dataset,
        out_dir: &Path,
        opts: &OptionValues,
        progress: &mut Progress,
    ) -> Result<()> {
        let individual = get_bool(opts, "individual", true);
        let combined = get_bool(opts, "combined", true);
        let colormap = get_bool(opts, "colormap", true);
        let vectors = get_bool(opts, "vectors", true);

        fs::create_dir_all(out_dir)
            .map_err(|e| AppError::Generic(format!("create output folder: {e}")))?;

        let total = dataset.frames.len() as u32;
        for (i, frame) in dataset.frames.iter().enumerate() {
            progress(i as u32, total, &frame.relative_path);
            let rel = Path::new(&frame.relative_path);
            let stem = rel
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("frame")
                .to_string();
            let parent = rel.parent().unwrap_or_else(|| Path::new(""));

            if individual {
                for lm in &frame.label_masks {
                    let label = dataset.label(lm.label_index);
                    let name = label.map(|l| l.name.as_str()).unwrap_or("label");
                    let is_instance = label.map(|l| l.is_instance).unwrap_or(false);
                    // Instance labels keep the id map; semantic ones are 0/255.
                    let pixels: Vec<u8> = if is_instance {
                        lm.values.clone()
                    } else {
                        lm.values.iter().map(|&v| if v != 0 { 255 } else { 0 }).collect()
                    };
                    let dir = out_dir.join("individual_masks").join(name).join(parent);
                    save_gray(&pixels, frame.width, frame.height, &dir, &stem)?;
                }
            }

            if combined {
                let map = combined_index_map(frame);
                let dir = out_dir.join("combined_masks").join(parent);
                save_gray(&map, frame.width, frame.height, &dir, &stem)?;
            }

            if colormap {
                let rgb = colormap_rgb(dataset, frame);
                let dir = out_dir.join("colormap").join(parent);
                save_rgb(&rgb, frame.width, frame.height, &dir, &stem)?;
            }

            if vectors && !frame.shapes.is_empty() {
                let dir = out_dir.join("vector").join(parent);
                fs::create_dir_all(&dir)
                    .map_err(|e| AppError::Generic(format!("create {}: {e}", dir.display())))?;
                let arr: Vec<_> = frame
                    .shapes
                    .iter()
                    .map(|s| {
                        json!({
                            "label": dataset.label(s.label_index).map(|l| l.name.clone()),
                            "closed": s.closed,
                            "filled": s.filled,
                            "polygon": s.points,
                        })
                    })
                    .collect();
                let text = serde_json::to_string_pretty(&arr)
                    .map_err(|e| AppError::Generic(format!("serialize vectors: {e}")))?;
                fs::write(dir.join(format!("{stem}.json")), text)
                    .map_err(|e| AppError::Generic(format!("write vector json: {e}")))?;
            }
        }

        progress(total, total, "Done");
        Ok(())
    }
}

/// Top-most label index per pixel (later labels win), 0 = background.
fn combined_index_map(frame: &FrameData) -> Vec<u8> {
    let mut map = vec![0u8; (frame.width * frame.height) as usize];
    for lm in &frame.label_masks {
        let idx = lm.label_index.min(255) as u8;
        for (i, &v) in lm.values.iter().enumerate() {
            if v != 0 && i < map.len() {
                map[i] = idx;
            }
        }
    }
    map
}

fn colormap_rgb(dataset: &Dataset, frame: &FrameData) -> Vec<u8> {
    let mut rgb = vec![0u8; (frame.width * frame.height * 3) as usize];
    for lm in &frame.label_masks {
        let (r, g, b) = dataset
            .label(lm.label_index)
            .map(|l| parse_hex(&l.color))
            .unwrap_or((128, 128, 128));
        for (i, &v) in lm.values.iter().enumerate() {
            if v != 0 && i * 3 + 2 < rgb.len() {
                rgb[i * 3] = r;
                rgb[i * 3 + 1] = g;
                rgb[i * 3 + 2] = b;
            }
        }
    }
    rgb
}

fn save_gray(pixels: &[u8], w: u32, h: u32, dir: &Path, stem: &str) -> Result<()> {
    fs::create_dir_all(dir).map_err(|e| AppError::Generic(format!("create {}: {e}", dir.display())))?;
    let img = GrayImage::from_raw(w, h, pixels.to_vec())
        .ok_or_else(|| AppError::Generic("invalid mask dimensions".into()))?;
    img.save(dir.join(format!("{stem}.png")))
        .map_err(|e| AppError::Generic(format!("save mask: {e}")))?;
    Ok(())
}

fn save_rgb(pixels: &[u8], w: u32, h: u32, dir: &Path, stem: &str) -> Result<()> {
    fs::create_dir_all(dir).map_err(|e| AppError::Generic(format!("create {}: {e}", dir.display())))?;
    let img = RgbImage::from_raw(w, h, pixels.to_vec())
        .ok_or_else(|| AppError::Generic("invalid colormap dimensions".into()))?;
    img.save(dir.join(format!("{stem}.png")))
        .map_err(|e| AppError::Generic(format!("save colormap: {e}")))?;
    Ok(())
}

fn parse_hex(hex: &str) -> (u8, u8, u8) {
    let h = hex.trim_start_matches('#');
    if h.len() >= 6 {
        let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(128);
        let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(128);
        let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(128);
        (r, g, b)
    } else {
        (128, 128, 128)
    }
}
