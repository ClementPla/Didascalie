//! Adapter between the SQLite (`.dida`) store and the [`Dataset`] IR. Only
//! this module knows the schema.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use crate::commands::annotation::decode_to_uint8;
use crate::commands::project_edit;
use crate::commands::vector::{self, flatten_shape, VectorNode, VectorShape};
use crate::storage::{queries, rle};
use crate::storage::DbState;
use crate::types::dataset::{
    Classification, Dataset, DatasetInfo, FrameData, FrameSource, LabelDef, LabelMask, PolygonShape,
};
use crate::types::export::ImportResult;
use crate::types::image::MaskEncoding;
use crate::utils::error::Result;

/// The open project as an export reads it: its labels now, its frames one
/// at a time. `only_reviewed` limits to reviewed frames; without
/// `with_images` the embedded image bytes are never read.
pub fn export_source<'a>(
    db: &'a DbState,
    name: &str,
    only_reviewed: bool,
    with_images: bool,
) -> Result<(DatasetInfo, DbFrames<'a>)> {
    db.with_conn(|conn| {
        let labels = load_labels(conn)?;
        // label_id -> 1-based index used across formats.
        let index_by_id: HashMap<i64, u32> = labels.iter().map(|(id, l)| (*id, l.index)).collect();
        let sql = if only_reviewed {
            "SELECT f.id FROM frames f
             WHERE EXISTS (SELECT 1 FROM frame_reviews r WHERE r.frame_id = f.id)
             ORDER BY f.id"
        } else {
            "SELECT id FROM frames ORDER BY id"
        };
        let ids = conn
            .prepare(sql)?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<i64>>>()?;
        let info = DatasetInfo {
            name: name.to_string(),
            labels: labels.into_iter().map(|(_, l)| l).collect(),
        };
        Ok((info, DbFrames { db, ids, index_by_id, with_images }))
    })
}

/// The frames of an export, each read under the connection lock only while
/// it loads.
pub struct DbFrames<'a> {
    db: &'a DbState,
    ids: Vec<i64>,
    index_by_id: HashMap<i64, u32>,
    with_images: bool,
}

impl FrameSource for DbFrames<'_> {
    fn len(&self) -> usize {
        self.ids.len()
    }

    fn load(&mut self, i: usize) -> Result<FrameData> {
        let id = self.ids[i];
        self.db.with_conn(|conn| load_frame(conn, id, &self.index_by_id, self.with_images))
    }
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

fn load_frame(
    conn: &Connection,
    id: i64,
    index_by_id: &HashMap<i64, u32>,
    with_images: bool,
) -> Result<FrameData> {
    let (relative_path, width, height, reviewed, image): (Option<String>, u32, u32, bool, Option<Vec<u8>>) =
        conn.query_row(
            "SELECT relative_path, width, height,
                    EXISTS (SELECT 1 FROM frame_reviews r WHERE r.frame_id = f.id),
                    CASE WHEN ?2 THEN embedded_data END
             FROM frames f WHERE id = ?1",
            rusqlite::params![id, with_images],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )?;
    let relative_path = relative_path.unwrap_or_else(|| format!("frame_{id}"));

    let mut label_masks = Vec::new();
    for a in queries::load_annotations(conn, id)? {
        let Some(&label_index) = index_by_id.get(&a.label_id) else {
            continue;
        };
        let values = decode_to_uint8(&a.mask_data, &a.encoding, width, height);
        if values.iter().any(|&v| v != 0) {
            label_masks.push(LabelMask { label_index, values });
        }
    }

    // Vector shapes, flattened to pixel polylines.
    let mut shapes = Vec::new();
    for s in vector::load_frame_shapes(conn, id)? {
        let Some(&label_index) = index_by_id.get(&s.label_id) else {
            continue;
        };
        let points: Vec<[f64; 2]> = flatten_shape(&s, 24).into_iter().map(|(x, y)| [x, y]).collect();
        if points.len() >= 2 {
            shapes.push(PolygonShape { label_index, closed: s.closed, filled: s.filled, points });
        }
    }

    Ok(FrameData {
        relative_path,
        width,
        height,
        reviewed,
        label_masks,
        shapes,
        classifications: load_classifications(conn, id)?,
        image,
    })
}

// ── Write side: overlay an imported IR onto the open project ────────────────
//
// Frames are matched to the project's by filename. Missing labels are
// created; shapes go to `vector_annotations`, masks to `annotations` (rle8).

pub fn write_dataset(conn: &Connection, dataset: &Dataset) -> Result<ImportResult> {
    let mut result = ImportResult::default();
    // Imported annotations become the importing user's.
    let user = queries::current_user_id(conn)?;

    let mut label_id_by_name: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, name FROM labels")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, name) = row?;
            label_id_by_name.insert(name, id);
        }
    }

    // IR label index -> db label id, creating missing labels.
    let mut next_sort: i32 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM labels", [], |r| r.get(0))?;
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
    if result.labels_created > 0 {
        project_edit::store_labels_in_config(conn)?;
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
                queries::upsert_vector_shapes(conn, frame_id, label_id, user, &json)?;
            }
        }

        for lm in &frame.label_masks {
            if let Some(&label_id) = db_label_by_index.get(&lm.label_index) {
                let encoded = rle::encode8(&lm.values);
                queries::save_annotation(conn, frame_id, label_id, &encoded, MaskEncoding::Rle8)?;
                result.annotations_imported += 1;
            }
        }

        for c in &frame.classifications {
            let json = serde_json::to_string(&c.values)?;
            conn.execute(
                "INSERT INTO main.classifications
                 (frame_id, user_id, task_name, selected_classes, modified_at)
                 VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
                 ON CONFLICT(frame_id, task_name, user_id)
                 DO UPDATE SET selected_classes = excluded.selected_classes, modified_at = CURRENT_TIMESTAMP",
                (frame_id, user, &c.task, &json),
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
        .optional()?;
    Ok(match json {
        Some(s) => serde_json::from_str(&s)?,
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
        let values: Vec<String> = serde_json::from_str(&json)?;
        out.push(Classification { task, values });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn project() -> DbState {
        let conn = queries::create_database(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO labels (id, name, color) VALUES (5, 'cell', '#ff0000');
             INSERT INTO sequences (id, name) VALUES (1, 's');
             INSERT INTO frames (id, sequence_id, frame_index, width, height, embedded_data)
                 VALUES (1, 1, 0, 2, 2, x'0102'), (2, 1, 1, 2, 2, NULL);",
        )
        .unwrap();
        queries::save_annotation(&conn, 1, 5, &rle::encode8(&[0, 1, 1, 0]), MaskEncoding::Rle8).unwrap();
        let db = DbState::new();
        db.set(conn);
        db
    }

    #[test]
    fn export_frames_load_one_at_a_time_and_images_only_on_request() {
        let db = project();
        let (info, mut frames) = export_source(&db, "p", false, false).unwrap();
        assert_eq!(info.labels.len(), 1);
        assert_eq!(frames.len(), 2);
        let first = frames.load(0).unwrap();
        assert_eq!(first.image, None, "image bytes are not read when not copied");
        assert_eq!(first.label_masks[0].values, vec![0, 1, 1, 0]);
        assert!(frames.load(1).unwrap().label_masks.is_empty());

        let (_, mut frames) = export_source(&db, "p", false, true).unwrap();
        assert_eq!(frames.load(0).unwrap().image, Some(vec![1, 2]));
    }

    #[test]
    fn only_reviewed_frames_are_exported_when_asked() {
        let db = project();
        db.with_conn(|conn| crate::commands::frame::mark_reviewed(conn, &[2], true)).unwrap();
        let (_, mut frames) = export_source(&db, "p", true, false).unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames.load(0).unwrap().reviewed);
    }
}
