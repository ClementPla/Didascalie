//! Adapter between the SQLite (`.dida`) store and the canonical [`Dataset`] IR.
//! Only this module knows the schema; formats never touch the database.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::commands::annotation::decode_to_uint8;
use crate::commands::vector::{self, flatten_shape, VectorNode, VectorShape};
use crate::storage::{queries, rle};
use crate::types::dataset::{Classification, Dataset, FrameData, LabelDef, LabelMask, PolygonShape};
use crate::types::export::ImportResult;
use crate::types::image::MaskEncoding;
use crate::utils::error::Result;

/// Read a project into the IR. `only_reviewed` limits to reviewed frames.
pub fn build_dataset(conn: &Connection, name: &str, only_reviewed: bool) -> Result<Dataset> {
    let labels = load_labels(conn)?;
    // label_id -> 1-based index used across formats.
    let index_by_id: HashMap<i64, u32> = labels.iter().map(|(id, l)| (*id, l.index)).collect();

    let label_defs: Vec<LabelDef> = labels.into_iter().map(|(_, l)| l).collect();
    let frames = load_frames(conn, only_reviewed, &index_by_id)?;

    Ok(Dataset { name: name.to_string(), labels: label_defs, frames })
}

fn load_labels(conn: &Connection) -> Result<Vec<(i64, LabelDef)>> {
    let mut stmt =
        conn.prepare("SELECT id, name, color, is_instance FROM labels ORDER BY sort_order")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, bool>(3)?,
        ))
    })?;

    let mut out = Vec::new();
    for (i, row) in rows.enumerate() {
        let (id, name, color, is_instance) = row?;
        out.push((
            id,
            LabelDef { index: (i + 1) as u32, name, color, is_instance },
        ));
    }
    Ok(out)
}

fn load_frames(
    conn: &Connection,
    only_reviewed: bool,
    index_by_id: &HashMap<i64, u32>,
) -> Result<Vec<FrameData>> {
    let sql = if only_reviewed {
        "SELECT id, relative_path, width, height, reviewed, embedded_data
         FROM frames WHERE reviewed = 1 ORDER BY id"
    } else {
        "SELECT id, relative_path, width, height, reviewed, embedded_data
         FROM frames ORDER BY id"
    };

    struct Row {
        id: i64,
        relative_path: Option<String>,
        width: u32,
        height: u32,
        reviewed: bool,
        image: Option<Vec<u8>>,
    }

    let mut stmt = conn.prepare(sql)?;
    let rows: Vec<Row> = stmt
        .query_map([], |row| {
            Ok(Row {
                id: row.get(0)?,
                relative_path: row.get(1)?,
                width: row.get(2)?,
                height: row.get(3)?,
                reviewed: row.get(4)?,
                image: row.get(5)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut frames = Vec::with_capacity(rows.len());
    for row in rows {
        let relative_path = row.relative_path.unwrap_or_else(|| format!("frame_{}", row.id));

        // Masks.
        let mut label_masks = Vec::new();
        for a in queries::load_annotations(conn, row.id)? {
            let Some(&label_index) = index_by_id.get(&a.label_id) else {
                continue;
            };
            let values = decode_to_uint8(&a.mask_data, &a.encoding, row.width, row.height);
            if values.iter().any(|&v| v != 0) {
                label_masks.push(LabelMask { label_index, values });
            }
        }

        // Vector shapes, flattened to pixel polylines.
        let mut shapes = Vec::new();
        for s in vector::load_frame_shapes(conn, row.id)? {
            let Some(&label_index) = index_by_id.get(&s.label_id) else {
                continue;
            };
            let points: Vec<[f64; 2]> =
                flatten_shape(&s, 24).into_iter().map(|(x, y)| [x, y]).collect();
            if points.len() >= 2 {
                shapes.push(PolygonShape { label_index, closed: s.closed, filled: s.filled, points });
            }
        }

        let classifications = load_classifications(conn, row.id)?;

        frames.push(FrameData {
            relative_path,
            width: row.width,
            height: row.height,
            reviewed: row.reviewed,
            label_masks,
            shapes,
            classifications,
            image: row.image,
        });
    }
    Ok(frames)
}

// ── Write side: overlay an imported IR onto the OPEN project ────────────────
//
// Frames are matched to the project by filename, so import doesn't need to
// re-load the images (they're already in the project — the CVAT "import into a
// task" model). Missing labels are created; shapes go to `vector_annotations`,
// masks to `annotations` (rle8).

pub fn write_dataset(conn: &Connection, dataset: &Dataset) -> Result<ImportResult> {
    let mut result = ImportResult::default();

    // Existing labels by name.
    let mut label_id_by_name: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, name FROM labels")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, name) = row?;
            label_id_by_name.insert(name, id);
        }
    }

    // Map IR label index -> db label id, creating labels that don't exist yet.
    let mut next_sort: i32 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM labels", [], |r| r.get(0))
        .unwrap_or(0);
    let mut db_label_by_index: HashMap<u32, i64> = HashMap::new();
    for label in &dataset.labels {
        let id = match label_id_by_name.get(&label.name) {
            Some(&id) => id,
            None => {
                conn.execute(
                    "INSERT INTO labels (name, color, is_instance, sort_order) VALUES (?1, ?2, ?3, ?4)",
                    (&label.name, &label.color, label.is_instance, next_sort),
                )?;
                let id = conn.last_insert_rowid();
                label_id_by_name.insert(label.name.clone(), id);
                next_sort += 1;
                result.labels_created += 1;
                id
            }
        };
        db_label_by_index.insert(label.index, id);
    }

    // Frame lookup by relative path and by bare filename.
    let mut id_by_path: HashMap<String, i64> = HashMap::new();
    let mut id_by_name: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, relative_path FROM frames")?;
        let rows =
            stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)))?;
        for row in rows {
            let (id, path) = row?;
            if let Some(p) = path {
                id_by_name.entry(file_name(&p)).or_insert(id);
                id_by_path.insert(p, id);
            }
        }
    }

    for frame in &dataset.frames {
        let frame_id = id_by_path
            .get(&frame.relative_path)
            .or_else(|| id_by_name.get(&file_name(&frame.relative_path)))
            .copied();
        let Some(frame_id) = frame_id else {
            result.frames_unmatched += 1;
            continue;
        };
        result.frames_matched += 1;

        // Vector shapes -> vector_annotations (append to any existing).
        if !frame.shapes.is_empty() {
            let mut by_label: HashMap<i64, Vec<VectorShape>> = HashMap::new();
            for s in &frame.shapes {
                if let Some(&label_id) = db_label_by_index.get(&s.label_index) {
                    by_label.entry(label_id).or_default().push(polygon_to_shape(s, label_id));
                }
            }
            for (label_id, new_shapes) in by_label {
                result.annotations_imported += new_shapes.len() as u32;
                let mut all = load_shapes_for(conn, frame_id, label_id)?;
                all.extend(new_shapes);
                let json = serde_json::to_string(&all)?;
                conn.execute(
                    "INSERT INTO vector_annotations (frame_id, label_id, shapes, modified_at)
                     VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
                     ON CONFLICT(frame_id, label_id)
                     DO UPDATE SET shapes = excluded.shapes, modified_at = CURRENT_TIMESTAMP",
                    (frame_id, label_id, &json),
                )?;
            }
        }

        // Label value masks -> annotations (rle8).
        for lm in &frame.label_masks {
            if let Some(&label_id) = db_label_by_index.get(&lm.label_index) {
                let encoded = rle::encode8(&lm.values);
                queries::save_annotation(conn, frame_id, label_id, &encoded, MaskEncoding::Rle8)?;
                result.annotations_imported += 1;
            }
        }

        // Classifications.
        for c in &frame.classifications {
            let json = serde_json::to_string(&c.values).unwrap_or_else(|_| "[]".to_string());
            conn.execute(
                "INSERT INTO classifications (frame_id, task_name, selected_classes, modified_at)
                 VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP)
                 ON CONFLICT(frame_id, task_name)
                 DO UPDATE SET selected_classes = excluded.selected_classes, modified_at = CURRENT_TIMESTAMP",
                (frame_id, &c.task, &json),
            )?;
        }
    }

    Ok(result)
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

/// A polygon becomes a vector shape with straight-segment corner nodes.
fn polygon_to_shape(shape: &PolygonShape, label_id: i64) -> VectorShape {
    let nodes = shape
        .points
        .iter()
        .map(|p| VectorNode {
            x: p[0],
            y: p[1],
            in_x: p[0],
            in_y: p[1],
            out_x: p[0],
            out_y: p[1],
            smooth: false,
        })
        .collect();
    VectorShape {
        id: uuid::Uuid::new_v4().to_string(),
        label_id,
        closed: shape.closed,
        filled: shape.filled,
        nodes,
    }
}

fn load_shapes_for(conn: &Connection, frame_id: i64, label_id: i64) -> Result<Vec<VectorShape>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT shapes FROM vector_annotations WHERE frame_id = ?1 AND label_id = ?2",
            (frame_id, label_id),
            |r| r.get(0),
        )
        .ok();
    Ok(match json {
        Some(s) => serde_json::from_str(&s).unwrap_or_default(),
        None => Vec::new(),
    })
}

fn load_classifications(conn: &Connection, frame_id: i64) -> Result<Vec<Classification>> {
    let mut stmt = conn
        .prepare("SELECT task_name, selected_classes FROM classifications WHERE frame_id = ?1")?;
    let rows = stmt.query_map([frame_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (task, json) = row?;
        let values: Vec<String> = serde_json::from_str(&json).unwrap_or_default();
        out.push(Classification { task, values });
    }
    Ok(out)
}
