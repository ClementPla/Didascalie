use serde::{Deserialize, Serialize};
use tauri::State;

use crate::storage::DbState;
use crate::utils::error::Result;
use crate::utils::AppError;

/// All vector shapes for a single (frame, label). `shapes` is an opaque JSON
/// array of `VectorShape`, owned and validated by the frontend — the backend
/// only stores and returns it verbatim.
#[derive(Serialize, Deserialize, Debug)]
pub struct VectorAnnotations {
    pub label_id: i64,
    pub shapes: serde_json::Value,
}

#[tauri::command]
pub fn save_vector_annotations(
    db: State<DbState>,
    frame_id: i64,
    label_id: i64,
    shapes: serde_json::Value,
) -> Result<()> {
    db.with_conn(|conn| {
        // No shapes for this label → drop the row so we don't keep empty records.
        let is_empty = shapes.as_array().map(|a| a.is_empty()).unwrap_or(true);
        if is_empty {
            conn.execute(
                "DELETE FROM vector_annotations WHERE frame_id = ?1 AND label_id = ?2",
                (frame_id, label_id),
            )?;
            return Ok(());
        }

        let shapes_json = serde_json::to_string(&shapes)
            .map_err(|e| AppError::Generic(format!("Failed to serialize shapes: {}", e)))?;

        conn.execute(
            "INSERT INTO vector_annotations (frame_id, label_id, shapes, modified_at)
             VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
             ON CONFLICT(frame_id, label_id)
             DO UPDATE SET shapes = excluded.shapes, modified_at = CURRENT_TIMESTAMP",
            (frame_id, label_id, &shapes_json),
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn load_vector_annotations(
    db: State<DbState>,
    frame_id: i64,
) -> Result<Vec<VectorAnnotations>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT label_id, shapes FROM vector_annotations WHERE frame_id = ?1",
        )?;

        let rows = stmt.query_map([frame_id], |row| {
            let label_id: i64 = row.get(0)?;
            let shapes_str: String = row.get(1)?;
            Ok((label_id, shapes_str))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (label_id, shapes_str) = row?;
            let shapes: serde_json::Value = serde_json::from_str(&shapes_str)
                .map_err(|e| AppError::Generic(format!("Bad shapes JSON: {}", e)))?;
            out.push(VectorAnnotations { label_id, shapes });
        }
        Ok(out)
    })
}

// ============================================================================
// Geometry + rasterization (used by export)
// ============================================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VectorNode {
    pub x: f64,
    pub y: f64,
    pub in_x: f64,
    pub in_y: f64,
    pub out_x: f64,
    pub out_y: f64,
    pub smooth: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VectorShape {
    pub id: String,
    pub label_id: i64,
    pub closed: bool,
    pub filled: bool,
    pub nodes: Vec<VectorNode>,
}

/// Default stroke half-width (px) when rasterizing open or unfilled paths.
const STROKE_RADIUS: f64 = 1.5;

/// Load every vector shape on a frame, flattened across labels.
pub fn load_frame_shapes(
    conn: &rusqlite::Connection,
    frame_id: i64,
) -> Result<Vec<VectorShape>> {
    let mut stmt = conn.prepare("SELECT shapes FROM vector_annotations WHERE frame_id = ?1")?;
    let rows = stmt.query_map([frame_id], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        let json = row?;
        let shapes: Vec<VectorShape> = serde_json::from_str(&json)
            .map_err(|e| AppError::Generic(format!("Bad shapes JSON: {}", e)))?;
        out.extend(shapes);
    }
    Ok(out)
}

fn cubic_point(
    p0: (f64, f64),
    p1: (f64, f64),
    p2: (f64, f64),
    p3: (f64, f64),
    t: f64,
) -> (f64, f64) {
    let mt = 1.0 - t;
    let a = mt * mt * mt;
    let b = 3.0 * mt * mt * t;
    let c = 3.0 * mt * t * t;
    let d = t * t * t;
    (
        a * p0.0 + b * p1.0 + c * p2.0 + d * p3.0,
        a * p0.1 + b * p1.1 + c * p2.1 + d * p3.1,
    )
}

/// Sample a shape into a polyline in image space. Closed shapes return a ring
/// whose last point equals the first.
pub fn flatten_shape(shape: &VectorShape, samples: usize) -> Vec<(f64, f64)> {
    let n = &shape.nodes;
    if n.is_empty() {
        return Vec::new();
    }
    if n.len() == 1 {
        return vec![(n[0].x, n[0].y)];
    }
    let mut pts = vec![(n[0].x, n[0].y)];
    let segs = if shape.closed { n.len() } else { n.len() - 1 };
    for i in 0..segs {
        let a = &n[i];
        let b = &n[(i + 1) % n.len()];
        let straight = a.out_x == a.x && a.out_y == a.y && b.in_x == b.x && b.in_y == b.y;
        if straight {
            pts.push((b.x, b.y));
        } else {
            for s in 1..=samples {
                let t = s as f64 / samples as f64;
                pts.push(cubic_point(
                    (a.x, a.y),
                    (a.out_x, a.out_y),
                    (b.in_x, b.in_y),
                    (b.x, b.y),
                    t,
                ));
            }
        }
    }
    pts
}

/// Rasterize a shape's coverage into an alpha buffer (sets covered pixels to
/// 255). Closed + filled shapes are filled (even-odd); all others are stroked.
pub fn rasterize_shape(shape: &VectorShape, width: u32, height: u32, alpha: &mut [u8]) {
    let poly = flatten_shape(shape, 24);
    if poly.len() < 2 {
        return;
    }
    if shape.closed && shape.filled {
        fill_polygon(&poly, width, height, alpha);
    } else {
        stroke_polyline(&poly, width, height, alpha, STROKE_RADIUS);
    }
}

fn fill_polygon(poly: &[(f64, f64)], width: u32, height: u32, alpha: &mut [u8]) {
    let w = width as i64;
    let h = height as i64;
    let (mut ymin, mut ymax) = (f64::MAX, f64::MIN);
    for &(_, y) in poly {
        ymin = ymin.min(y);
        ymax = ymax.max(y);
    }
    let y0 = (ymin.floor() as i64).max(0);
    let y1 = (ymax.ceil() as i64).min(h - 1);
    let n = poly.len();
    let mut xs: Vec<f64> = Vec::new();
    for y in y0..=y1 {
        let yc = y as f64 + 0.5;
        xs.clear();
        for i in 0..n {
            let (x1, y1p) = poly[i];
            let (x2, y2p) = poly[(i + 1) % n];
            if (y1p <= yc && y2p > yc) || (y2p <= yc && y1p > yc) {
                let t = (yc - y1p) / (y2p - y1p);
                xs.push(x1 + t * (x2 - x1));
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut k = 0;
        while k + 1 < xs.len() {
            // Fill pixels whose center lies between the pair of crossings.
            let xa = ((xs[k] - 0.5).ceil() as i64).max(0);
            let xb = ((xs[k + 1] - 0.5).ceil() as i64).min(w);
            for x in xa..xb {
                alpha[(y * w + x) as usize] = 255;
            }
            k += 2;
        }
    }
}

fn stroke_polyline(poly: &[(f64, f64)], width: u32, height: u32, alpha: &mut [u8], radius: f64) {
    for i in 0..poly.len() - 1 {
        stamp_segment(poly[i], poly[i + 1], radius, width, height, alpha);
    }
}

fn stamp_segment(
    a: (f64, f64),
    b: (f64, f64),
    r: f64,
    width: u32,
    height: u32,
    alpha: &mut [u8],
) {
    let w = width as i64;
    let h = height as i64;
    let minx = ((a.0.min(b.0) - r).floor() as i64).max(0);
    let maxx = ((a.0.max(b.0) + r).ceil() as i64).min(w - 1);
    let miny = ((a.1.min(b.1) - r).floor() as i64).max(0);
    let maxy = ((a.1.max(b.1) + r).ceil() as i64).min(h - 1);
    let r2 = r * r;
    for y in miny..=maxy {
        for x in minx..=maxx {
            let p = (x as f64 + 0.5, y as f64 + 0.5);
            if dist_sq_point_seg(p, a, b) <= r2 {
                alpha[(y * w + x) as usize] = 255;
            }
        }
    }
}

fn dist_sq_point_seg(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let cx = a.0 + t * dx;
    let cy = a.1 + t * dy;
    let ex = p.0 - cx;
    let ey = p.1 - cy;
    ex * ex + ey * ey
}
