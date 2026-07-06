//! YOLO format: one `.txt` per image (normalized), plus `data.yaml`. Supports
//! detection (`class cx cy w h`) and segmentation (`class x1 y1 x2 y2 …`).
//! Class ids are 0-based (`label.index - 1`).

use std::fs;
use std::path::{Path, PathBuf};

use super::geometry::{polygon_bounds, regions_from_mask};
use super::{enum_opt, bool_opt, get_bool, get_str, Capabilities, ExportFormat, ImportFormat, OptionSpec, OptionValues, Progress};
use crate::types::dataset::{Dataset, FrameData, LabelDef, PolygonShape};
use crate::utils::error::Result;
use crate::utils::AppError;

pub struct Yolo;

const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "bmp", "tif", "tiff"];

fn is_segment(opts: &OptionValues) -> bool {
    get_str(opts, "task", "segment") == "segment"
}

// ── Export ──────────────────────────────────────────────────────────────────

impl ExportFormat for Yolo {
    fn id(&self) -> &str {
        "yolo"
    }
    fn name(&self) -> &str {
        "YOLO"
    }
    fn description(&self) -> &str {
        "YOLO txt (detection or segmentation) + data.yaml."
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities { masks: false, polygons: true, bboxes: true, classifications: false, instances: true }
    }
    fn options(&self) -> Vec<OptionSpec> {
        vec![
            enum_opt("task", "Task", &[("segment", "Segmentation"), ("detect", "Detection")], "segment"),
            bool_opt("images", "Copy image files", false),
        ]
    }

    fn export(&self, dataset: &Dataset, out_dir: &Path, opts: &OptionValues, progress: &mut Progress) -> Result<()> {
        let segment = is_segment(opts);
        let copy_images = get_bool(opts, "images", false);
        fs::create_dir_all(out_dir.join("labels"))
            .map_err(|e| AppError::Generic(format!("create labels dir: {e}")))?;
        if copy_images {
            let _ = fs::create_dir_all(out_dir.join("images"));
        }

        // data.yaml
        let mut yaml = String::from("path: .\ntrain: images\nval: images\nnames:\n");
        for l in &dataset.labels {
            yaml.push_str(&format!("  {}: {}\n", l.index.saturating_sub(1), l.name));
        }
        yaml.push_str(&format!("nc: {}\n", dataset.labels.len()));
        fs::write(out_dir.join("data.yaml"), yaml)
            .map_err(|e| AppError::Generic(format!("write data.yaml: {e}")))?;

        let total = dataset.frames.len() as u32;
        for (i, frame) in dataset.frames.iter().enumerate() {
            progress(i as u32, total, &frame.relative_path);
            let (fw, fh) = (frame.width as f64, frame.height as f64);
            if fw == 0.0 || fh == 0.0 {
                continue;
            }
            let stem = Path::new(&frame.relative_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("frame");
            let mut lines = String::new();

            for lm in &frame.label_masks {
                let cls = lm.label_index.saturating_sub(1);
                let by_instance = dataset.label(lm.label_index).map(|l| l.is_instance).unwrap_or(false);
                for region in regions_from_mask(&lm.values, frame.width, frame.height, by_instance) {
                    if segment {
                        for ring in &region.polygons {
                            let mut line = cls.to_string();
                            for p in ring {
                                line.push_str(&format!(" {:.6} {:.6}", p[0] / fw, p[1] / fh));
                            }
                            lines.push_str(&line);
                            lines.push('\n');
                        }
                    } else {
                        let [x, y, w, h] = region.bbox;
                        lines.push_str(&format!(
                            "{} {:.6} {:.6} {:.6} {:.6}\n",
                            cls,
                            (x + w / 2.0) / fw,
                            (y + h / 2.0) / fh,
                            w / fw,
                            h / fh
                        ));
                    }
                }
            }

            for shape in &frame.shapes {
                let cls = shape.label_index.saturating_sub(1);
                if shape.points.len() < 3 {
                    continue;
                }
                if segment {
                    let mut line = cls.to_string();
                    for p in &shape.points {
                        line.push_str(&format!(" {:.6} {:.6}", p[0] / fw, p[1] / fh));
                    }
                    lines.push_str(&line);
                    lines.push('\n');
                } else {
                    let [x, y, w, h] = polygon_bounds(&shape.points);
                    lines.push_str(&format!(
                        "{} {:.6} {:.6} {:.6} {:.6}\n",
                        cls,
                        (x + w / 2.0) / fw,
                        (y + h / 2.0) / fh,
                        w / fw,
                        h / fh
                    ));
                }
            }

            if !lines.is_empty() {
                let _ = fs::write(out_dir.join("labels").join(format!("{stem}.txt")), lines);
            }
            if copy_images {
                if let Some(bytes) = &frame.image {
                    let _ = fs::write(out_dir.join("images").join(&frame.relative_path), bytes);
                }
            }
        }

        progress(total, total, "Done");
        Ok(())
    }
}

// ── Import ──────────────────────────────────────────────────────────────────

impl ImportFormat for Yolo {
    fn id(&self) -> &str {
        "yolo"
    }
    fn name(&self) -> &str {
        "YOLO"
    }
    fn description(&self) -> &str {
        "YOLO dataset folder (data.yaml + images/ + labels/)."
    }

    fn import(&self, path: &Path, _opts: &OptionValues, progress: &mut Progress) -> Result<Dataset> {
        if !path.is_dir() {
            return Err(AppError::Generic("Select the YOLO dataset folder (with data.yaml).".into()));
        }
        let names = parse_yaml_names(&path.join("data.yaml"));
        let labels: Vec<LabelDef> = names
            .iter()
            .enumerate()
            .map(|(i, n)| LabelDef {
                index: (i + 1) as u32,
                name: n.clone(),
                color: super::default_color(i),
                is_instance: false,
            })
            .collect();

        let images_dir = path.join("images");
        let labels_dir = path.join("labels");
        let entries: Vec<PathBuf> = fs::read_dir(&images_dir)
            .map(|it| it.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        let total = entries.len() as u32;

        let mut frames = Vec::new();
        for (i, img_path) in entries.iter().enumerate() {
            let ext = img_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !IMAGE_EXTS.contains(&ext.as_str()) {
                continue;
            }
            if i % 64 == 0 {
                progress(i as u32, total, "Reading labels");
            }
            let (w, h) = image::image_dimensions(img_path).unwrap_or((0, 0));
            let (wf, hf) = (w as f64, h as f64);
            let stem = img_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let file_name = img_path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();

            let mut shapes = Vec::new();
            let txt = labels_dir.join(format!("{stem}.txt"));
            if let Ok(content) = fs::read_to_string(&txt) {
                for line in content.lines() {
                    let toks: Vec<f64> = line.split_whitespace().filter_map(|t| t.parse().ok()).collect();
                    if toks.len() < 5 {
                        continue;
                    }
                    let label_index = (toks[0] as usize + 1) as u32;
                    let coords = &toks[1..];
                    if coords.len() == 4 {
                        // detection box (normalized center + size)
                        let (cx, cy, nw, nh) = (coords[0] * wf, coords[1] * hf, coords[2] * wf, coords[3] * hf);
                        let (x, y) = (cx - nw / 2.0, cy - nh / 2.0);
                        shapes.push(PolygonShape {
                            label_index,
                            closed: true,
                            filled: false,
                            points: vec![[x, y], [x + nw, y], [x + nw, y + nh], [x, y + nh]],
                        });
                    } else if coords.len() >= 6 && coords.len() % 2 == 0 {
                        let points: Vec<[f64; 2]> =
                            coords.chunks_exact(2).map(|c| [c[0] * wf, c[1] * hf]).collect();
                        shapes.push(PolygonShape { label_index, closed: true, filled: true, points });
                    }
                }
            }

            frames.push(FrameData {
                relative_path: file_name,
                width: w,
                height: h,
                shapes,
                ..Default::default()
            });
        }

        progress(total, total, "Done");
        Ok(Dataset { name: "YOLO import".to_string(), labels, frames })
    }
}

/// Minimal `names:` reader — handles the dict form (`  0: name`) and the inline
/// list (`names: [a, b]`). Good enough without pulling in a YAML dependency.
fn parse_yaml_names(yaml_path: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(yaml_path) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    let mut in_names = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if let Some(rest) = trimmed.strip_prefix("names:") {
            let rest = rest.trim();
            if rest.starts_with('[') {
                // inline list
                return rest
                    .trim_matches(|c| c == '[' || c == ']')
                    .split(',')
                    .map(|s| s.trim().trim_matches(|c| c == '\'' || c == '"').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
            in_names = true;
            continue;
        }
        if in_names {
            if line.starts_with(' ') || line.starts_with('\t') {
                // "  0: name"  or  "  - name"
                let value = trimmed
                    .split_once(':')
                    .map(|(_, v)| v)
                    .unwrap_or_else(|| trimmed.trim_start().trim_start_matches('-'));
                let name = value.trim().trim_matches(|c| c == '\'' || c == '"');
                if !name.is_empty() {
                    names.push(name.to_string());
                }
            } else {
                in_names = false;
            }
        }
    }
    names
}
