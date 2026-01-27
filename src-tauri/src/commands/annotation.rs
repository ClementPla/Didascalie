use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use image::{ImageFormat};
use serde::{Serialize, Deserialize};
use tauri::State;
use crate::utils::AppError;
use crate::utils::error::Result;
use crate::storage::{DbState, queries, rle};
use crate::types::image::{AnnotationResponse, MaskEncoding, LabelId};

#[tauri::command]
pub fn save_annotation(
    db: State<DbState>,
    frame_id: i64,
    label_id: i64,
    mask_data: Vec<u8>,
    encoding: MaskEncoding,
) -> Result<()> {

    
    db.with_conn(|conn| {
        let (width, height) = queries::get_frame_dimensions(conn, frame_id)?;
        
        let encoded_data = match encoding {
            MaskEncoding::Rle => {
                rle::encode(&mask_data, width as usize, height as usize)
            }
            MaskEncoding::Png => {
                let img = image::RgbaImage::from_raw(width, height, mask_data)
                    .ok_or_else(|| AppError::Generic("Invalid RGBA mask dimensions".to_string()))?;
                let mut png_bytes = Vec::new();
                img.write_to(&mut std::io::Cursor::new(&mut png_bytes), ImageFormat::Png)
                    .map_err(|e| AppError::Generic(format!("Failed to encode PNG: {}", e)))?;
                png_bytes
            }
        };
        
        queries::save_annotation(conn, frame_id, label_id, &encoded_data, encoding)
    })
}

#[tauri::command]
pub fn load_annotations(db: State<DbState>, frame_id: i64) -> Result<Vec<AnnotationResponse>> {
    db.with_conn(|conn| {
        let (width, height) = queries::get_frame_dimensions(conn, frame_id)?;
        let annotations = queries::load_annotations(conn, frame_id)?;

        annotations
            .into_iter()
            .map(|a| {
                let png_bytes = match a.encoding {
                    MaskEncoding::Png => {
                        // Instance segmentation: already RGBA PNG, return as-is
                        a.mask_data
                    }
                    MaskEncoding::Rle => {
                        // Regular segmentation: decode RLE, apply color, return RGBA PNG
                        let alpha = rle::decode(&a.mask_data, width as usize, height as usize);
                        let (r, g, b) = parse_hex_color(&a.color)?;
                        
                        // Build RGBA image
                        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
                        for a_val in alpha {
                            rgba.push(r);
                            rgba.push(g);
                            rgba.push(b);
                            rgba.push(a_val);
                        }
                        
                        let img = image::RgbaImage::from_raw(width, height, rgba)
                            .ok_or_else(|| AppError::Generic("Invalid mask dimensions".to_string()))?;
                        let mut png_bytes = Vec::new();
                        img.write_to(&mut std::io::Cursor::new(&mut png_bytes), ImageFormat::Png)
                            .map_err(|e| AppError::Generic(format!("Failed to encode PNG: {}", e)))?;
                        png_bytes
                    }
                };

                Ok(AnnotationResponse {
                    label_id: a.label_id,
                    label_name: a.label_name,
                    color: a.color,
                    mask_png_base64: BASE64_STANDARD.encode(&png_bytes),
                    width,
                    height,
                })
            })
            .collect()
    })
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
            Ok((r * 17, g * 17, b * 17))  // Expand #RGB to #RRGGBB
        }
        _ => Err(AppError::Generic(format!("Invalid color format: {}", color)))
    }
}
#[tauri::command]
pub fn mark_reviewed(db: State<DbState>, image_id: i64) -> Result<()> {
    db.with_conn(|conn| {
        queries::mark_image_opened(conn, image_id)?;
        queries::mark_image_reviewed(conn, image_id, true)
    })
}


#[tauri::command]
pub fn list_labels(db: State<DbState>) -> Result<Vec<LabelId>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name FROM labels ORDER BY sort_order"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(LabelId {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LabelInfo {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub is_instance: bool,
    pub sort_order: i32,
}

#[tauri::command]
pub fn get_labels(db: State<DbState>) -> Result<Vec<LabelInfo>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, color, is_instance, sort_order FROM labels ORDER BY sort_order"
        )?;
        
        let labels = stmt.query_map([], |row| {
            Ok(LabelInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_instance: row.get(3)?,
                sort_order: row.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
        
        Ok(labels)
    })
}