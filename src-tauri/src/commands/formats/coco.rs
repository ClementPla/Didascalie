//! COCO format: categories + images + annotations (bbox and polygon
//! segmentation). Proves the plugin path — it only touches the [`Dataset`] IR
//! and the shared geometry helpers.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use super::geometry::regions_from_mask;
use super::{
    bool_opt, get_bool, Capabilities, ExportFormat, ImportFormat, OptionSpec, OptionValues,
    Progress,
};
use crate::types::dataset::{Dataset, FrameData, LabelDef, PolygonShape};
use crate::utils::error::Result;
use crate::utils::AppError;

pub struct Coco;

impl Coco {
    fn caps() -> Capabilities {
        Capabilities {
            masks: false,
            polygons: true,
            bboxes: true,
            classifications: false,
            instances: true,
        }
    }
}

// ── Export ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct CocoImage {
    id: u32,
    file_name: String,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
struct CocoCategory {
    id: u32,
    name: String,
    supercategory: String,
}

#[derive(Serialize)]
struct CocoAnnotation {
    id: u32,
    image_id: u32,
    category_id: u32,
    bbox: [f64; 4],
    area: f64,
    iscrowd: u8,
    segmentation: Vec<Vec<f64>>,
}

#[derive(Serialize)]
struct CocoFile {
    info: Value,
    images: Vec<CocoImage>,
    annotations: Vec<CocoAnnotation>,
    categories: Vec<CocoCategory>,
}

impl ExportFormat for Coco {
    fn id(&self) -> &str {
        "coco"
    }
    fn name(&self) -> &str {
        "COCO"
    }
    fn description(&self) -> &str {
        "COCO JSON: bounding boxes + polygon segmentation."
    }
    fn capabilities(&self) -> Capabilities {
        Coco::caps()
    }
    fn options(&self) -> Vec<OptionSpec> {
        vec![
            bool_opt("segmentation", "Include polygon segmentation", true),
            bool_opt("images", "Copy image files", false),
        ]
    }

    fn export(
        &self,
        dataset: &Dataset,
        out_dir: &Path,
        opts: &OptionValues,
        progress: &mut Progress,
    ) -> Result<()> {
        let include_seg = get_bool(opts, "segmentation", true);
        let copy_images = get_bool(opts, "images", false);
        fs::create_dir_all(out_dir)
            .map_err(|e| AppError::Generic(format!("create output folder: {e}")))?;

        let categories: Vec<CocoCategory> = dataset
            .labels
            .iter()
            .map(|l| CocoCategory {
                id: l.index,
                name: l.name.clone(),
                supercategory: String::new(),
            })
            .collect();

        let mut images = Vec::new();
        let mut annotations = Vec::new();
        let mut ann_id: u32 = 1;
        let total = dataset.frames.len() as u32;

        for (i, frame) in dataset.frames.iter().enumerate() {
            let image_id = (i + 1) as u32;
            progress(i as u32, total, &frame.relative_path);

            images.push(CocoImage {
                id: image_id,
                file_name: frame.relative_path.clone(),
                width: frame.width,
                height: frame.height,
            });

            if copy_images {
                if let Some(bytes) = &frame.image {
                    let dst = out_dir.join("images").join(&frame.relative_path);
                    if let Some(parent) = dst.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::write(dst, bytes);
                }
            }

            for lm in &frame.label_masks {
                let by_instance =
                    dataset.label(lm.label_index).map(|l| l.is_instance).unwrap_or(false);
                for region in regions_from_mask(&lm.values, frame.width, frame.height, by_instance) {
                    let segmentation = if include_seg {
                        region
                            .polygons
                            .iter()
                            .map(|ring| ring.iter().flat_map(|p| [p[0], p[1]]).collect::<Vec<f64>>())
                            .filter(|r| r.len() >= 6)
                            .collect()
                    } else {
                        Vec::new()
                    };
                    annotations.push(CocoAnnotation {
                        id: ann_id,
                        image_id,
                        category_id: lm.label_index,
                        bbox: region.bbox,
                        area: region.area as f64,
                        iscrowd: 0,
                        segmentation,
                    });
                    ann_id += 1;
                }
            }

            if include_seg {
                for shape in &frame.shapes {
                    if shape.points.len() < 3 {
                        continue;
                    }
                    let (bbox, area) = bounds_and_area(&shape.points);
                    let seg = vec![shape.points.iter().flat_map(|p| [p[0], p[1]]).collect()];
                    annotations.push(CocoAnnotation {
                        id: ann_id,
                        image_id,
                        category_id: shape.label_index,
                        bbox,
                        area,
                        iscrowd: 0,
                        segmentation: seg,
                    });
                    ann_id += 1;
                }
            }
        }

        let file = CocoFile {
            info: json!({ "description": dataset.name, "generator": "Didascalie" }),
            images,
            annotations,
            categories,
        };
        let text = serde_json::to_string_pretty(&file)
            .map_err(|e| AppError::Generic(format!("serialize COCO: {e}")))?;
        fs::write(out_dir.join("annotations.json"), text)
            .map_err(|e| AppError::Generic(format!("write annotations.json: {e}")))?;

        progress(total, total, "Done");
        Ok(())
    }
}

// ── Import ──────────────────────────────────────────────────────────────────

impl ImportFormat for Coco {
    fn id(&self) -> &str {
        "coco"
    }
    fn name(&self) -> &str {
        "COCO"
    }
    fn description(&self) -> &str {
        "COCO JSON: bounding boxes + polygon segmentation."
    }

    fn import(&self, path: &Path, _opts: &OptionValues, progress: &mut Progress) -> Result<Dataset> {
        let json_path = resolve_json(path)?;
        let text = fs::read_to_string(&json_path)
            .map_err(|e| AppError::Generic(format!("read {}: {e}", json_path.display())))?;
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| AppError::Generic(format!("parse COCO JSON: {e}")))?;

        // Categories → labels (1-based index, remembering the original id).
        let mut labels = Vec::new();
        let mut index_by_cat: HashMap<i64, u32> = HashMap::new();
        for (i, c) in v["categories"].as_array().into_iter().flatten().enumerate() {
            let cat_id = c["id"].as_i64().unwrap_or((i + 1) as i64);
            let index = (i + 1) as u32;
            index_by_cat.insert(cat_id, index);
            labels.push(LabelDef {
                index,
                name: c["name"].as_str().unwrap_or("label").to_string(),
                color: super::default_color(i),
                is_instance: false,
            });
        }

        // Images → frames, remembering original image id -> position.
        let mut frames: Vec<FrameData> = Vec::new();
        let mut pos_by_image: HashMap<i64, usize> = HashMap::new();
        for img in v["images"].as_array().into_iter().flatten() {
            let img_id = img["id"].as_i64().unwrap_or(0);
            pos_by_image.insert(img_id, frames.len());
            frames.push(FrameData {
                relative_path: img["file_name"].as_str().unwrap_or("").to_string(),
                width: img["width"].as_u64().unwrap_or(0) as u32,
                height: img["height"].as_u64().unwrap_or(0) as u32,
                ..Default::default()
            });
        }

        // Annotations → polygon shapes on their frame.
        let anns = v["annotations"].as_array().cloned().unwrap_or_default();
        let total = anns.len() as u32;
        for (i, ann) in anns.iter().enumerate() {
            if i % 256 == 0 {
                progress(i as u32, total, "Reading annotations");
            }
            let Some(&pos) = ann["image_id"].as_i64().and_then(|id| pos_by_image.get(&id)) else {
                continue;
            };
            let Some(&label_index) = ann["category_id"].as_i64().and_then(|c| index_by_cat.get(&c))
            else {
                continue;
            };

            let polygons = parse_segmentation(&ann["segmentation"]);
            if !polygons.is_empty() {
                for ring in polygons {
                    if ring.len() >= 3 {
                        frames[pos].shapes.push(PolygonShape {
                            label_index,
                            closed: true,
                            filled: true,
                            points: ring,
                        });
                    }
                }
            } else if let Some(bbox) = ann["bbox"].as_array() {
                // No segmentation — keep the box as a rectangle shape.
                if bbox.len() == 4 {
                    let (x, y, w, h) = (
                        bbox[0].as_f64().unwrap_or(0.0),
                        bbox[1].as_f64().unwrap_or(0.0),
                        bbox[2].as_f64().unwrap_or(0.0),
                        bbox[3].as_f64().unwrap_or(0.0),
                    );
                    frames[pos].shapes.push(PolygonShape {
                        label_index,
                        closed: true,
                        filled: false,
                        points: vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
                    });
                }
            }
        }

        progress(total, total, "Done");
        Ok(Dataset { name: "COCO import".to_string(), labels, frames })
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn resolve_json(path: &Path) -> Result<PathBuf> {
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    if path.is_dir() {
        for name in ["annotations.json", "instances_default.json"] {
            let candidate = path.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        // Fall back to the first *.json in the folder.
        if let Ok(entries) = fs::read_dir(path) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("json") {
                    return Ok(p);
                }
            }
        }
    }
    Err(AppError::Generic(format!(
        "No COCO JSON found at {}",
        path.display()
    )))
}

/// COCO `segmentation` is either a list of flat polygons (`[[x,y,...], ...]`) or
/// RLE (`{counts, size}`). We only decode polygons here.
fn parse_segmentation(seg: &Value) -> Vec<Vec<[f64; 2]>> {
    let Some(arr) = seg.as_array() else {
        return Vec::new();
    };
    let mut rings = Vec::new();
    for poly in arr {
        if let Some(flat) = poly.as_array() {
            let pts: Vec<[f64; 2]> = flat
                .chunks_exact(2)
                .map(|c| [c[0].as_f64().unwrap_or(0.0), c[1].as_f64().unwrap_or(0.0)])
                .collect();
            if !pts.is_empty() {
                rings.push(pts);
            }
        }
    }
    rings
}

/// Bounding box `[x, y, w, h]` and shoelace area of a polygon.
fn bounds_and_area(points: &[[f64; 2]]) -> ([f64; 4], f64) {
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    let mut area2 = 0.0;
    for i in 0..points.len() {
        let p = points[i];
        let q = points[(i + 1) % points.len()];
        minx = minx.min(p[0]);
        miny = miny.min(p[1]);
        maxx = maxx.max(p[0]);
        maxy = maxy.max(p[1]);
        area2 += p[0] * q[1] - q[0] * p[1];
    }
    ([minx, miny, maxx - minx, maxy - miny], area2.abs() / 2.0)
}
