use std::fs;
use std::path::Path;
use image::{ImageFormat, GrayImage, RgbImage};
use tauri::{State, Emitter, AppHandle};

use crate::storage::{DbState, queries};
use crate::types::image::{AnnotationData, MaskEncoding};
use crate::utils::error::Result;
use crate::utils::AppError;
use crate::storage::rle;
use crate::commands::vector::{self, VectorShape, flatten_shape, rasterize_shape};

use crate::types::export::{ExportOptions, ExportResult, ExportProgress, ClassificationTaskInfo, FrameClassification};
struct FrameInfo {
    id: i64,
    width: u32,
    height: u32,
    relative_path: Option<String>,
}

struct LabelInfo {
    id: i64,
    name: String,
    color: String,
}

/// Parse hex color string (#RRGGBB or #RGB) to RGB tuple
fn parse_hex_color(color: &str) -> Result<(u8, u8, u8)> {
    let hex = color.trim_start_matches('#');
    
    match hex.len() {
        6 => {
            let r = u8::from_str_radix(&hex[0..2], 16)
                .map_err(|_| AppError::Generic(format!("Invalid color: {}", color)))?;
            let g = u8::from_str_radix(&hex[2..4], 16)
                .map_err(|_| AppError::Generic(format!("Invalid color: {}", color)))?;
            let b = u8::from_str_radix(&hex[4..6], 16)
                .map_err(|_| AppError::Generic(format!("Invalid color: {}", color)))?;
            Ok((r, g, b))
        }
        3 => {
            let r = u8::from_str_radix(&hex[0..1], 16)
                .map_err(|_| AppError::Generic(format!("Invalid color: {}", color)))?;
            let g = u8::from_str_radix(&hex[1..2], 16)
                .map_err(|_| AppError::Generic(format!("Invalid color: {}", color)))?;
            let b = u8::from_str_radix(&hex[2..3], 16)
                .map_err(|_| AppError::Generic(format!("Invalid color: {}", color)))?;
            Ok((r * 17, g * 17, b * 17))
        }
        _ => Err(AppError::Generic(format!("Invalid color format: {}", color)))
    }
}

#[tauri::command]
pub async fn export_annotations(
    app: AppHandle,
    db: State<'_, DbState>,
    options: ExportOptions,
) -> Result<ExportResult> {
    let output_path = Path::new(&options.output_folder);
    
    // Create output directory
    fs::create_dir_all(output_path)
        .map_err(|e| AppError::Generic(format!("Failed to create output folder: {}", e)))?;

    // For instance segmentation, we only export individual masks
    let export_individual = options.individual_mask || options.instance_segmentation;
    let export_combined = options.combined_mask && !options.instance_segmentation;
    let export_colormap = options.colormap && !options.instance_segmentation;

    // Create subfolders based on options
    let individual_folder = output_path.join("individual_masks");
    let combined_folder = output_path.join("combined_masks");
    let colormap_folder = output_path.join("colormap");

    if export_individual {
        fs::create_dir_all(&individual_folder)
            .map_err(|e| AppError::Generic(format!("Failed to create individual_masks folder: {}", e)))?;
    }
    if export_combined {
        fs::create_dir_all(&combined_folder)
            .map_err(|e| AppError::Generic(format!("Failed to create combined_masks folder: {}", e)))?;
    }
    if export_colormap {
        fs::create_dir_all(&colormap_folder)
            .map_err(|e| AppError::Generic(format!("Failed to create colormap folder: {}", e)))?;
    }

    let vector_folder = output_path.join("vector");
    if options.vectors {
        fs::create_dir_all(&vector_folder)
            .map_err(|e| AppError::Generic(format!("Failed to create vector folder: {}", e)))?;
    }

    // Get frames to export
    let frames = db.with_conn(|conn| {
        let query = if options.only_reviewed {
            "SELECT f.id, f.width, f.height, f.relative_path
             FROM frames f
             WHERE f.reviewed = 1
             ORDER BY f.id"
        } else {
            "SELECT f.id, f.width, f.height, f.relative_path
             FROM frames f
             ORDER BY f.id"
        };
        
        let mut stmt = conn.prepare(query)?;
        let frames: Vec<FrameInfo> = stmt
            .query_map([], |row| {
                Ok(FrameInfo {
                    id: row.get(0)?,
                    width: row.get(1)?,
                    height: row.get(2)?,
                    relative_path: row.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(frames)
    })?;

    // Get labels
    let labels = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, color FROM labels ORDER BY sort_order"
        )?;
        let labels: Vec<LabelInfo> = stmt
            .query_map([], |row| {
                Ok(LabelInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(labels)
    })?;

    // Export colormap.json
    if export_colormap {
        let colormap_json_path = colormap_folder.join("colormap.json");
        let colormap: Vec<serde_json::Value> = labels
            .iter()
            .enumerate()
            .map(|(i, label)| {
                let (r, g, b) = parse_hex_color(&label.color).unwrap_or((0, 0, 0));
                serde_json::json!({
                    "index": i + 1,
                    "label_id": label.id,
                    "name": label.name,
                    "color": label.color,
                    "rgb": [r, g, b]
                })
            })
            .collect();
        
        fs::write(&colormap_json_path, serde_json::to_string_pretty(&colormap).unwrap())
            .map_err(|e| AppError::Generic(format!("Failed to write colormap: {}", e)))?;
    }

    let total = frames.len() as u32;
    let mut exported = 0u32;
    let mut errors: Vec<String> = Vec::new();

    // Process each frame
    for frame in &frames {
        // Get original path structure
        let relative_path = match &frame.relative_path {
            Some(p) => Path::new(p),
            None => {
                errors.push(format!("Frame {} has no relative path", frame.id));
                continue;
            }
        };

        let parent = relative_path.parent().unwrap_or(Path::new(""));
        let fallback_name = format!("frame_{}", frame.id);
        let file_stem = relative_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&fallback_name);

        // Emit progress
        let _ = app.emit("export-progress", ExportProgress {
            current: exported,
            total,
            current_file: relative_path.to_string_lossy().to_string(),
        });

        // Load annotations for this frame
        let annotations = match db.with_conn(|conn| queries::load_annotations(conn, frame.id)) {
            Ok(a) => a,
            Err(e) => {
                errors.push(format!("Failed to load annotations for {}: {}", relative_path.display(), e));
                continue;
            }
        };

        // Load this frame's vector shapes if either vector output is requested.
        let shapes: Vec<VectorShape> = if options.vectors || options.rasterize_vectors {
            match db.with_conn(|conn| vector::load_frame_shapes(conn, frame.id)) {
                Ok(s) => s,
                Err(e) => {
                    errors.push(format!("Failed to load vectors for {}: {}", relative_path.display(), e));
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        // Emit the per-frame vector JSON (exact nodes + flattened polygon),
        // independent of whether the frame has raster masks.
        if options.vectors && !shapes.is_empty() {
            let frame_folder = vector_folder.join(parent);
            if let Err(e) = fs::create_dir_all(&frame_folder) {
                errors.push(format!("Failed to create folder {}: {}", frame_folder.display(), e));
            } else {
                let json_path = frame_folder.join(format!("{}.json", file_stem));
                if let Err(e) = write_vector_json(&shapes, &labels, &json_path) {
                    errors.push(format!("Failed to write vector JSON {}: {}", json_path.display(), e));
                }
            }
        }

        // Bake vector shapes into the raster masks (regular segmentation only).
        let annotations = if options.rasterize_vectors && !options.instance_segmentation && !shapes.is_empty() {
            match augment_annotations_with_vectors(annotations, &shapes, &labels, frame.width, frame.height) {
                Ok(a) => a,
                Err(e) => {
                    errors.push(format!("Failed to rasterize vectors for {}: {}", relative_path.display(), e));
                    continue;
                }
            }
        } else {
            annotations
        };

        if annotations.is_empty() {
            exported += 1;
            continue;
        }

        // Export individual masks
        if export_individual {
            for annotation in &annotations {
                let label_folder = individual_folder.join(&annotation.label_name).join(parent);
                if let Err(e) = fs::create_dir_all(&label_folder) {
                    errors.push(format!("Failed to create folder {}: {}", label_folder.display(), e));
                    continue;
                }

                let mask_filename = format!("{}.png", file_stem);
                let mask_path = label_folder.join(&mask_filename);

                let result = if options.instance_segmentation {
                    // Instance segmentation: grayscale instance-id PNG
                    export_instance_mask(
                        &annotation.mask_data,
                        &annotation.encoding,
                        frame.width,
                        frame.height,
                        &mask_path,
                    )
                } else {
                    // Regular segmentation
                    export_individual_mask(
                        &annotation.mask_data,
                        &annotation.encoding,
                        frame.width,
                        frame.height,
                        &mask_path,
                    )
                };

                if let Err(e) = result {
                    errors.push(format!("Failed to export {}: {}", mask_path.display(), e));
                }
            }
        }

        // Export combined mask (not for instance segmentation)
        if export_combined {
            let frame_folder = combined_folder.join(parent);
            if let Err(e) = fs::create_dir_all(&frame_folder) {
                errors.push(format!("Failed to create folder {}: {}", frame_folder.display(), e));
                continue;
            }

            let combined_filename = format!("{}.png", file_stem);
            let combined_path = frame_folder.join(&combined_filename);

            if let Err(e) = export_combined_mask(
                &annotations,
                &labels,
                frame.width,
                frame.height,
                &combined_path,
            ) {
                errors.push(format!("Failed to export combined mask {}: {}", combined_path.display(), e));
            }
        }

        // Export colormap mask (not for instance segmentation)
        if export_colormap {
            let frame_folder = colormap_folder.join(parent);
            if let Err(e) = fs::create_dir_all(&frame_folder) {
                errors.push(format!("Failed to create folder {}: {}", frame_folder.display(), e));
                continue;
            }

            let colormap_filename = format!("{}.png", file_stem);
            let colormap_path = frame_folder.join(&colormap_filename);

            if let Err(e) = export_colormap_mask(
                &annotations,
                &labels,
                frame.width,
                frame.height,
                &colormap_path,
            ) {
                errors.push(format!("Failed to export colormap mask {}: {}", colormap_path.display(), e));
            }
        }

        exported += 1;
    }

    // Emit final progress
    let _ = app.emit("export-progress", ExportProgress {
        current: exported,
        total,
        current_file: "Done".to_string(),
    });
    let classifications_folder = output_path.join("classifications");
    if options.classifications {
        fs::create_dir_all(&classifications_folder)
            .map_err(|e| AppError::Generic(format!("Failed to create classifications folder: {}", e)))?;
    }

    // Load classification tasks from project config
    let classification_tasks = if options.classifications {
        db.with_conn(|conn| load_classification_tasks(conn))?
    } else {
        vec![]
    };


        if options.classifications && !classification_tasks.is_empty() {
        if let Err(e) = export_classifications(
            &db,
            &classification_tasks,
            &frames,
            &classifications_folder,
            options.only_reviewed,
        ) {
            errors.push(format!("Failed to export classifications: {}", e));
        }
    }


    Ok(ExportResult {
        total_exported: exported,
        errors,
    })
}

/// Export an instance segmentation mask as a grayscale PNG whose pixel value is
/// the instance id (0 = background). Any stored encoding is decoded to the uint8
/// id mask first, so legacy RGBA-shade PNGs are remapped to ids on the way out.
fn export_instance_mask(
    mask_data: &[u8],
    encoding: &MaskEncoding,
    width: u32,
    height: u32,
    output_path: &Path,
) -> Result<()> {
    let ids = crate::commands::annotation::decode_to_uint8(mask_data, encoding, width, height);
    let img = GrayImage::from_raw(width, height, ids)
        .ok_or_else(|| AppError::Generic("Invalid instance mask dimensions".to_string()))?;
    img.save(output_path)
        .map_err(|e| AppError::Generic(format!("Failed to save mask: {}", e)))?;
    Ok(())
}

/// Export individual mask as grayscale PNG (for regular segmentation)
fn export_individual_mask(
    mask_data: &[u8],
    encoding: &MaskEncoding,
    width: u32,
    height: u32,
    output_path: &Path,
) -> Result<()> {
    match encoding {
        MaskEncoding::Rle => {
            let pixels = rle::decode(mask_data, width as usize, height as usize);
            let img = GrayImage::from_raw(width, height, pixels)
                .ok_or_else(|| AppError::Generic("Invalid mask dimensions".to_string()))?;
            img.save(output_path)
                .map_err(|e| AppError::Generic(format!("Failed to save mask: {}", e)))?;
        }
        MaskEncoding::Rle8 => {
            // Regular segmentation: normalize present pixels to 255 so the
            // grayscale mask stays visible (values are 1 in the uint8 model).
            let pixels: Vec<u8> = rle::decode8(mask_data, width as usize, height as usize)
                .into_iter()
                .map(|v| if v > 0 { 255 } else { 0 })
                .collect();
            let img = GrayImage::from_raw(width, height, pixels)
                .ok_or_else(|| AppError::Generic("Invalid mask dimensions".to_string()))?;
            img.save(output_path)
                .map_err(|e| AppError::Generic(format!("Failed to save mask: {}", e)))?;
        }
        MaskEncoding::Png => {
            // Legacy: write stored PNG directly
            fs::write(output_path, mask_data)
                .map_err(|e| AppError::Generic(format!("Failed to save mask: {}", e)))?;
        }
    }
    Ok(())
}

/// Decode mask data to single-channel presence values (nonzero = foreground).
fn decode_to_alpha(
    mask_data: &[u8],
    encoding: &MaskEncoding,
    width: u32,
    height: u32,
) -> Result<Vec<u8>> {
    match encoding {
        MaskEncoding::Rle => Ok(rle::decode(mask_data, width as usize, height as usize)),
        MaskEncoding::Rle8 => Ok(rle::decode8(mask_data, width as usize, height as usize)),
        MaskEncoding::Png => {
            let img = image::load_from_memory_with_format(mask_data, ImageFormat::Png)
                .map_err(|e| AppError::Generic(format!("Failed to decode PNG: {}", e)))?;
            let rgba = img.to_rgba8();
            let alpha: Vec<u8> = rgba.pixels().map(|p| p[3]).collect();
            Ok(alpha)
        }
    }
}

/// Export combined mask as indexed PNG (label index as pixel value, 0 = background)
fn export_combined_mask(
    annotations: &[AnnotationData],
    labels: &[LabelInfo],
    width: u32,
    height: u32,
    output_path: &Path,
) -> Result<()> {
    let mut combined = vec![0u8; (width * height) as usize];

    for annotation in annotations {
        let label_index = labels
            .iter()
            .position(|l| l.name == annotation.label_name)
            .map(|i| (i + 1) as u8)
            .unwrap_or(0);

        if label_index == 0 {
            continue;
        }

        let pixels = decode_to_alpha(&annotation.mask_data, &annotation.encoding, width, height)?;

        for (i, &alpha) in pixels.iter().enumerate() {
            if alpha > 0 {
                combined[i] = label_index;
            }
        }
    }

    let img = GrayImage::from_raw(width, height, combined)
        .ok_or_else(|| AppError::Generic("Invalid combined mask dimensions".to_string()))?;
    img.save(output_path)
        .map_err(|e| AppError::Generic(format!("Failed to save combined mask: {}", e)))?;

    Ok(())
}

/// Export colormap mask as RGB PNG (each label has its color)
fn export_colormap_mask(
    annotations: &[AnnotationData],
    labels: &[LabelInfo],
    width: u32,
    height: u32,
    output_path: &Path,
) -> Result<()> {
    let mut rgb = vec![0u8; (width * height * 3) as usize];

    for annotation in annotations {
        let (r, g, b) = labels
            .iter()
            .find(|l| l.name == annotation.label_name)
            .and_then(|l| parse_hex_color(&l.color).ok())
            .unwrap_or((128, 128, 128));

        let pixels = decode_to_alpha(&annotation.mask_data, &annotation.encoding, width, height)?;

        for (i, &alpha) in pixels.iter().enumerate() {
            if alpha > 0 {
                rgb[i * 3] = r;
                rgb[i * 3 + 1] = g;
                rgb[i * 3 + 2] = b;
            }
        }
    }

    let img = RgbImage::from_raw(width, height, rgb)
        .ok_or_else(|| AppError::Generic("Invalid colormap mask dimensions".to_string()))?;
    img.save(output_path)
        .map_err(|e| AppError::Generic(format!("Failed to save colormap mask: {}", e)))?;

    Ok(())
}

/// Merge rasterized vector shapes into the per-label annotation alpha so the
/// mask exports (individual / combined / colormap) reflect them. Labels that
/// only have vectors gain a new RLE annotation.
fn augment_annotations_with_vectors(
    mut annotations: Vec<AnnotationData>,
    shapes: &[VectorShape],
    labels: &[LabelInfo],
    width: u32,
    height: u32,
) -> Result<Vec<AnnotationData>> {
    use std::collections::HashMap;

    let mut by_label: HashMap<i64, Vec<&VectorShape>> = HashMap::new();
    for s in shapes {
        by_label.entry(s.label_id).or_default().push(s);
    }

    for (label_id, label_shapes) in by_label {
        let mut valpha = vec![0u8; (width * height) as usize];
        for s in label_shapes {
            rasterize_shape(s, width, height, &mut valpha);
        }

        if let Some(ann) = annotations.iter_mut().find(|a| a.label_id == label_id) {
            // OR the vectors onto the existing raster alpha, re-encode as RLE.
            let mut existing = decode_to_alpha(&ann.mask_data, &ann.encoding, width, height)?;
            for (i, &v) in valpha.iter().enumerate() {
                if v > 0 {
                    existing[i] = 255;
                }
            }
            ann.mask_data = rle::encode(&existing, width as usize, height as usize);
            ann.encoding = MaskEncoding::Rle;
        } else if let Some(label) = labels.iter().find(|l| l.id == label_id) {
            // Vector-only label: synthesize an annotation from the raster.
            annotations.push(AnnotationData {
                label_id,
                label_name: label.name.clone(),
                color: label.color.clone(),
                encoding: MaskEncoding::Rle,
                mask_data: rle::encode(&valpha, width as usize, height as usize),
            });
        }
    }

    Ok(annotations)
}

/// Write a frame's vector shapes as JSON: the exact bezier nodes/handles plus a
/// flattened polygon for consumers that just want point lists.
fn write_vector_json(shapes: &[VectorShape], labels: &[LabelInfo], path: &Path) -> Result<()> {
    let arr: Vec<serde_json::Value> = shapes
        .iter()
        .map(|s| {
            let label_name = labels
                .iter()
                .find(|l| l.id == s.label_id)
                .map(|l| l.name.clone())
                .unwrap_or_default();
            let polygon: Vec<[f64; 2]> =
                flatten_shape(s, 24).into_iter().map(|(x, y)| [x, y]).collect();
            serde_json::json!({
                "label": label_name,
                "label_id": s.label_id,
                "closed": s.closed,
                "filled": s.filled,
                "nodes": s.nodes,
                "polygon": polygon,
            })
        })
        .collect();

    let text = serde_json::to_string_pretty(&arr)
        .map_err(|e| AppError::Generic(format!("Failed to serialize vector JSON: {}", e)))?;
    fs::write(path, text)
        .map_err(|e| AppError::Generic(format!("Failed to write {}: {}", path.display(), e)))?;
    Ok(())
}



/// Load classification task definitions from project config
fn load_classification_tasks(conn: &rusqlite::Connection) -> Result<Vec<ClassificationTaskInfo>> {
    let config_json: String = conn.query_row(
        "SELECT config FROM project WHERE id = 1",
        [],
        |row| row.get(0),
    ).map_err(|e| AppError::Database(e))?;

    let config: serde_json::Value = serde_json::from_str(&config_json)
        .map_err(|e| AppError::Generic(format!("Failed to parse config: {}", e)))?;

    let mut tasks = Vec::new();

    // Multiclass tasks
    if let Some(classification_tasks) = config.get("classification_tasks").and_then(|v| v.as_array()) {
        for task in classification_tasks {
            if let (Some(name), Some(classes)) = (
                task.get("name").and_then(|v| v.as_str()),
                task.get("classes").and_then(|v| v.as_array()),
            ) {
                tasks.push(ClassificationTaskInfo {
                    name: name.to_string(),
                    classes: classes.iter()
                        .filter_map(|c| c.as_str().map(|s| s.to_string()))
                        .collect(),
                    is_multilabel: false,
                });
            }
        }
    }

    // Multilabel task
    if let Some(multilabel) = config.get("multilabel_task") {
        if let (Some(name), Some(classes)) = (
            multilabel.get("name").and_then(|v| v.as_str()),
            multilabel.get("classes").and_then(|v| v.as_array()),
        ) {
            tasks.push(ClassificationTaskInfo {
                name: name.to_string(),
                classes: classes.iter()
                    .filter_map(|c| c.as_str().map(|s| s.to_string()))
                    .collect(),
                is_multilabel: true,
            });
        }
    }

    Ok(tasks)
}


/// Export all classifications
fn export_classifications(
    db: &DbState,
    tasks: &[ClassificationTaskInfo],
    frames: &[FrameInfo],
    output_folder: &Path,
    only_reviewed: bool,
) -> Result<()> {
    // Load all classifications from database
    let classifications = db.with_conn(|conn| {
        let query = if only_reviewed {
            "SELECT f.id, f.relative_path, c.task_name, c.selected_classes
             FROM classifications c
             JOIN frames f ON c.frame_id = f.id
             WHERE f.reviewed = 1
             ORDER BY f.id"
        } else {
            "SELECT f.id, f.relative_path, c.task_name, c.selected_classes
             FROM classifications c
             JOIN frames f ON c.frame_id = f.id
             ORDER BY f.id"
        };

        let mut stmt = conn.prepare(query)?;
        let classifications: Vec<FrameClassification> = stmt
            .query_map([], |row| {
                let selected_json: String = row.get(3)?;
                let selected: Vec<String> = serde_json::from_str(&selected_json).unwrap_or_default();
                Ok(FrameClassification {
                    frame_id: row.get(0)?,
                    relative_path: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    task_name: row.get(2)?,
                    selected_classes: selected,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(classifications)
    })?;

    // Export tasks.json
    let tasks_json: Vec<serde_json::Value> = tasks.iter().map(|t| {
        serde_json::json!({
            "name": t.name,
            "classes": t.classes,
            "is_multilabel": t.is_multilabel,
            "num_classes": t.classes.len()
        })
    }).collect();
    
    fs::write(
        output_folder.join("tasks.json"),
        serde_json::to_string_pretty(&tasks_json).unwrap(),
    ).map_err(|e| AppError::Generic(format!("Failed to write tasks.json: {}", e)))?;

    // Export per-task CSVs
    for task in tasks {
        export_task_csv(task, &classifications, frames, output_folder)?;
    }

    // Export long-format CSV
    export_long_format_csv(&classifications, output_folder)?;

    Ok(())
}

/// Export CSV for a single task
fn export_task_csv(
    task: &ClassificationTaskInfo,
    classifications: &[FrameClassification],
    frames: &[FrameInfo],
    output_folder: &Path,
) -> Result<()> {
    let filename = format!("{}.csv", sanitize_filename(&task.name));
    let filepath = output_folder.join(&filename);
    
    let mut csv_content = String::new();

    if task.is_multilabel {
        // Header: image_path,class1,class2,...
        csv_content.push_str("image_path");
        for class in &task.classes {
            csv_content.push(',');
            csv_content.push_str(&escape_csv_field(class));
        }
        csv_content.push('\n');

        // Build a map of frame classifications for this task
        let frame_classifications: std::collections::HashMap<i64, &FrameClassification> = 
            classifications.iter()
                .filter(|c| c.task_name == task.name)
                .map(|c| (c.frame_id, c))
                .collect();

        // Rows
        for frame in frames {
            let relative_path = match &frame.relative_path {
                Some(p) => p.clone(),
                None => continue,
            };

            csv_content.push_str(&escape_csv_field(&relative_path));

            let selected = frame_classifications.get(&frame.id)
                .map(|c| &c.selected_classes)
                .cloned()
                .unwrap_or_default();

            for class in &task.classes {
                csv_content.push(',');
                csv_content.push_str(if selected.contains(class) { "1" } else { "0" });
            }
            csv_content.push('\n');
        }
    } else {
        // Multiclass: image_path,class_index,class_name,class1,class2,...
        csv_content.push_str("image_path,class_index,class_name");
        for class in &task.classes {
            csv_content.push(',');
            csv_content.push_str(&escape_csv_field(class));
        }
        csv_content.push('\n');

        let frame_classifications: std::collections::HashMap<i64, &FrameClassification> = 
            classifications.iter()
                .filter(|c| c.task_name == task.name)
                .map(|c| (c.frame_id, c))
                .collect();

        for frame in frames {
            let relative_path = match &frame.relative_path {
                Some(p) => p.clone(),
                None => continue,
            };

            let selected = frame_classifications.get(&frame.id)
                .and_then(|c| c.selected_classes.first())
                .cloned();

            let class_index = selected.as_ref()
                .and_then(|s| task.classes.iter().position(|c| c == s))
                .map(|i| i as i32)
                .unwrap_or(-1);

            let class_name = selected.as_deref().unwrap_or("");

            csv_content.push_str(&escape_csv_field(&relative_path));
            csv_content.push(',');
            csv_content.push_str(&class_index.to_string());
            csv_content.push(',');
            csv_content.push_str(&escape_csv_field(class_name));

            for class in &task.classes {
                csv_content.push(',');
                csv_content.push_str(if Some(class.as_str()) == selected.as_deref() { "1" } else { "0" });
            }
            csv_content.push('\n');
        }
    }

    fs::write(&filepath, csv_content)
        .map_err(|e| AppError::Generic(format!("Failed to write {}: {}", filename, e)))?;

    Ok(())
}

/// Export long-format CSV with all classifications
fn export_long_format_csv(
    classifications: &[FrameClassification],
    output_folder: &Path,
) -> Result<()> {
    let filepath = output_folder.join("all_classifications.csv");
    
    let mut csv_content = String::from("image_path,task_name,class_name,value\n");

    for c in classifications {
        for class in &c.selected_classes {
            csv_content.push_str(&escape_csv_field(&c.relative_path));
            csv_content.push(',');
            csv_content.push_str(&escape_csv_field(&c.task_name));
            csv_content.push(',');
            csv_content.push_str(&escape_csv_field(class));
            csv_content.push_str(",1\n");
        }
    }

    fs::write(&filepath, csv_content)
        .map_err(|e| AppError::Generic(format!("Failed to write all_classifications.csv: {}", e)))?;

    Ok(())
}

/// Escape CSV field (quote if contains comma, quote, or newline)
fn escape_csv_field(field: &str) -> String {
    if field.contains(',') || field.contains('"') || field.contains('\n') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// Sanitize filename (remove/replace invalid characters)
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}