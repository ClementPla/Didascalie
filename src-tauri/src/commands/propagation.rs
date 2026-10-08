//! Copy-propagation of a frame's segmentation annotations onto other frames.
//!
//! Propagation happens here rather than in the frontend because the stored
//! forms are already the cheap ones: a raster mask is a compressed `rle8` BLOB
//! and a vector row is opaque JSON. Copying is a row copy — no decode, and no
//! mask ever crosses the IPC boundary (a full mask is ~136 MB at 8k×17k, so
//! doing this frame-by-frame through the editor would be unusable).
//!
//! Two invariants make raster and vector behave as one thing:
//!
//! 1. **Both tables move together, in one transaction.** A frame's segmentation
//!    state is (raster rows ∪ vector rows) — the editor converts freely between
//!    them — so propagating one without the other yields inconsistent frames.
//! 2. **Replace deletes labels the source doesn't have.** If the source has no
//!    row for a label in scope, the target's row for it is removed. Otherwise
//!    the target keeps stale labels and isn't a copy of the source at all.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::storage::{DbState, queries};
use crate::utils::error::Result;

/// How source annotations combine with what the target already has.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PropagationMode {
    /// The target's annotations for every label in scope become exactly the
    /// source's (including "absent" — see the module invariants).
    #[default]
    Replace,
}

/// Why a requested target was left untouched.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// Target frame dimensions differ from the source's. Raster masks are flat
    /// `width*height` arrays and vector nodes are image-pixel coordinates, so
    /// neither means anything on a differently sized frame.
    SizeMismatch,
    /// No such frame (deleted between the UI listing it and the call landing).
    NotFound,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFrame {
    pub frame_id: i64,
    pub reason: SkipReason,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PropagationReport {
    /// Frames actually written, in the order requested.
    pub applied: Vec<i64>,
    pub skipped: Vec<SkippedFrame>,
}

/// A source frame's annotations for one label, as stored.
struct SourceLabel {
    label_id: i64,
    /// `(encoding, mask_data)` copied verbatim — legacy encodings stay readable,
    /// so there is no reason to decode and re-encode on the way through.
    raster: Option<(String, Vec<u8>)>,
    /// The `shapes` JSON array, or `None` when the label has no vector row.
    vectors: Option<serde_json::Value>,
}

/// Copy `source_frame_id`'s annotations onto `target_frame_ids`.
///
/// `label_ids` restricts the copy to those labels (`None` = every label).
/// Labels outside the scope are untouched on the targets.
#[tauri::command]
pub fn propagate_annotations(
    db: State<DbState>,
    source_frame_id: i64,
    target_frame_ids: Vec<i64>,
    label_ids: Option<Vec<i64>>,
    mode: PropagationMode,
) -> Result<PropagationReport> {
    db.with_conn(|conn| {
        propagate(
            conn,
            source_frame_id,
            &target_frame_ids,
            label_ids.as_deref(),
            mode,
        )
    })
}

pub(crate) fn propagate(
    conn: &Connection,
    source_frame_id: i64,
    target_frame_ids: &[i64],
    label_ids: Option<&[i64]>,
    mode: PropagationMode,
) -> Result<PropagationReport> {
    let PropagationMode::Replace = mode;

    let (src_width, src_height) = queries::get_frame_dimensions(conn, source_frame_id)?;

    let scope: Vec<i64> = match label_ids {
        Some(ids) => ids.to_vec(),
        None => all_label_ids(conn)?,
    };
    let source = read_source(conn, source_frame_id, &scope)?;

    let mut report = PropagationReport::default();
    let tx = conn.unchecked_transaction()?;

    for &target in target_frame_ids {
        // Propagating onto the source would delete-then-reinsert its own rows;
        // harmless, but reporting it as "applied" would be misleading.
        if target == source_frame_id {
            continue;
        }

        match frame_dimensions_opt(&tx, target)? {
            None => {
                report.skipped.push(SkippedFrame {
                    frame_id: target,
                    reason: SkipReason::NotFound,
                });
                continue;
            }
            Some(dims) if dims != (src_width, src_height) => {
                report.skipped.push(SkippedFrame {
                    frame_id: target,
                    reason: SkipReason::SizeMismatch,
                });
                continue;
            }
            Some(_) => {}
        }

        for label in &source {
            write_label(&tx, target, label)?;
        }
        report.applied.push(target);
    }

    tx.commit()?;
    Ok(report)
}

fn all_label_ids(conn: &Connection) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM labels ORDER BY sort_order")?;
    let ids = stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(ids)
}

fn frame_dimensions_opt(conn: &Connection, frame_id: i64) -> Result<Option<(u32, u32)>> {
    let dims = conn
        .query_row(
            "SELECT width, height FROM frames WHERE id = ?1",
            params![frame_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    Ok(dims)
}

/// Read the source frame's rows for every label in scope. A label with no rows
/// is still present in the result — that absence is what `Replace` propagates.
fn read_source(conn: &Connection, frame_id: i64, scope: &[i64]) -> Result<Vec<SourceLabel>> {
    let mut raster = conn.prepare(
        "SELECT encoding, mask_data FROM annotations WHERE frame_id = ?1 AND label_id = ?2",
    )?;
    let mut vectors = conn
        .prepare("SELECT shapes FROM vector_annotations WHERE frame_id = ?1 AND label_id = ?2")?;

    let mut out = Vec::with_capacity(scope.len());
    for &label_id in scope {
        let mask = raster
            .query_row(params![frame_id, label_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .ok();

        let shapes = match vectors
            .query_row(params![frame_id, label_id], |row| row.get::<_, String>(0))
            .ok()
        {
            Some(json) => serde_json::from_str::<serde_json::Value>(&json).ok(),
            None => None,
        };

        out.push(SourceLabel {
            label_id,
            raster: mask,
            vectors: shapes,
        });
    }
    Ok(out)
}

/// Apply one label's source state to one target frame: delete first, then write
/// back whatever the source had. The delete is what makes an absent source
/// label erase the target's.
fn write_label(conn: &Connection, frame_id: i64, label: &SourceLabel) -> Result<()> {
    // Reads above went through the user-scoped views; writes name the user.
    let user = queries::current_user_id(conn)?;
    conn.execute(
        "DELETE FROM main.annotations WHERE frame_id = ?1 AND label_id = ?2 AND user_id = ?3",
        params![frame_id, label.label_id, user],
    )?;
    conn.execute(
        "DELETE FROM main.vector_annotations
         WHERE frame_id = ?1 AND label_id = ?2 AND user_id = ?3",
        params![frame_id, label.label_id, user],
    )?;

    if let Some((encoding, mask_data)) = &label.raster {
        conn.execute(
            "INSERT INTO main.annotations
             (frame_id, label_id, user_id, encoding, mask_data, modified_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            params![frame_id, label.label_id, user, encoding, mask_data],
        )?;
    }

    if let Some(shapes) = &label.vectors {
        let shapes = with_fresh_shape_ids(shapes);
        // An empty array is stored as no row at all (see `save_vector_annotations`).
        if shapes.as_array().is_some_and(|a| a.is_empty()) {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO main.vector_annotations (frame_id, label_id, user_id, shapes, modified_at)
             VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)",
            params![frame_id, label.label_id, user, serde_json::to_string(&shapes)?],
        )?;
    }

    Ok(())
}

/// Shape ids are frame-local identities (selection, per-frame undo). Give each
/// copy its own so two frames never disagree about what a given id means.
fn with_fresh_shape_ids(shapes: &serde_json::Value) -> serde_json::Value {
    let mut copy = shapes.clone();
    if let Some(array) = copy.as_array_mut() {
        for shape in array {
            if let Some(object) = shape.as_object_mut() {
                object.insert(
                    "id".to_string(),
                    serde_json::Value::String(Uuid::new_v4().to_string()),
                );
            }
        }
    }
    copy
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::schema::SCHEMA;

    /// Two labels, and frames 1..=3 in one sequence, all 4×4 unless overridden.
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO labels (id, name, color, sort_order) VALUES
                (1, 'a', '#fff', 0), (2, 'b', '#000', 1);
             INSERT INTO sequences (id, name, sort_order) VALUES (1, 'seq', 0);
             INSERT INTO frames (id, sequence_id, frame_index, width, height) VALUES
                (1, 1, 0, 4, 4), (2, 1, 1, 4, 4), (3, 1, 2, 4, 4);",
        )
        .unwrap();
        conn
    }

    fn put_mask(conn: &Connection, frame: i64, label: i64, data: &[u8]) {
        conn.execute(
            "INSERT INTO annotations (frame_id, label_id, encoding, mask_data)
             VALUES (?1, ?2, 'rle8', ?3)",
            params![frame, label, data],
        )
        .unwrap();
    }

    fn put_shapes(conn: &Connection, frame: i64, label: i64, shapes: &str) {
        conn.execute(
            "INSERT INTO vector_annotations (frame_id, label_id, shapes) VALUES (?1, ?2, ?3)",
            params![frame, label, shapes],
        )
        .unwrap();
    }

    fn mask_of(conn: &Connection, frame: i64, label: i64) -> Option<Vec<u8>> {
        conn.query_row(
            "SELECT mask_data FROM annotations WHERE frame_id = ?1 AND label_id = ?2",
            params![frame, label],
            |r| r.get(0),
        )
        .ok()
    }

    fn shapes_of(conn: &Connection, frame: i64, label: i64) -> Option<String> {
        conn.query_row(
            "SELECT shapes FROM vector_annotations WHERE frame_id = ?1 AND label_id = ?2",
            params![frame, label],
            |r| r.get(0),
        )
        .ok()
    }

    #[test]
    fn copies_raster_and_vector_together() {
        let conn = fixture();
        put_mask(&conn, 1, 1, &[1, 2, 3]);
        put_shapes(&conn, 1, 2, r#"[{"id":"s1","labelId":2,"nodes":[]}]"#);

        let report = propagate(&conn, 1, &[2, 3], None, PropagationMode::Replace).unwrap();

        assert_eq!(report.applied, vec![2, 3]);
        assert!(report.skipped.is_empty());
        for frame in [2, 3] {
            assert_eq!(mask_of(&conn, frame, 1).as_deref(), Some(&[1, 2, 3][..]));
            assert!(shapes_of(&conn, frame, 2).is_some());
        }
    }

    #[test]
    fn replace_erases_labels_the_source_lacks() {
        let conn = fixture();
        // Source has nothing; target has both a mask and shapes.
        put_mask(&conn, 2, 1, &[9]);
        put_shapes(&conn, 2, 2, r#"[{"id":"s1","labelId":2,"nodes":[]}]"#);

        propagate(&conn, 1, &[2], None, PropagationMode::Replace).unwrap();

        assert!(mask_of(&conn, 2, 1).is_none());
        assert!(shapes_of(&conn, 2, 2).is_none());
    }

    #[test]
    fn labels_outside_scope_are_untouched() {
        let conn = fixture();
        put_mask(&conn, 1, 1, &[1]);
        put_mask(&conn, 2, 2, &[9]);

        propagate(&conn, 1, &[2], Some(&[1]), PropagationMode::Replace).unwrap();

        assert_eq!(mask_of(&conn, 2, 1).as_deref(), Some(&[1][..]));
        assert_eq!(mask_of(&conn, 2, 2).as_deref(), Some(&[9][..]));
    }

    #[test]
    fn differently_sized_frames_are_skipped_not_corrupted() {
        let conn = fixture();
        conn.execute("UPDATE frames SET width = 8 WHERE id = 3", [])
            .unwrap();
        put_mask(&conn, 1, 1, &[1, 2, 3]);
        put_mask(&conn, 3, 1, &[7]);

        let report = propagate(&conn, 1, &[2, 3, 99], None, PropagationMode::Replace).unwrap();

        assert_eq!(report.applied, vec![2]);
        assert_eq!(report.skipped.len(), 2);
        assert_eq!(report.skipped[0].reason, SkipReason::SizeMismatch);
        assert_eq!(report.skipped[1].reason, SkipReason::NotFound);
        // The mismatched frame kept its own annotation.
        assert_eq!(mask_of(&conn, 3, 1).as_deref(), Some(&[7][..]));
    }

    #[test]
    fn each_copy_gets_its_own_shape_ids() {
        let conn = fixture();
        put_shapes(&conn, 1, 1, r#"[{"id":"s1","labelId":1,"nodes":[]}]"#);

        propagate(&conn, 1, &[2, 3], None, PropagationMode::Replace).unwrap();

        let a = shapes_of(&conn, 2, 1).unwrap();
        let b = shapes_of(&conn, 3, 1).unwrap();
        assert!(!a.contains("\"s1\""));
        assert_ne!(a, b);
        // The source itself is unchanged.
        assert!(shapes_of(&conn, 1, 1).unwrap().contains("\"s1\""));
    }

    #[test]
    fn source_frame_is_never_a_target() {
        let conn = fixture();
        put_mask(&conn, 1, 1, &[1]);

        let report = propagate(&conn, 1, &[1, 2], None, PropagationMode::Replace).unwrap();

        assert_eq!(report.applied, vec![2]);
        assert_eq!(mask_of(&conn, 1, 1).as_deref(), Some(&[1][..]));
    }
}
