//! Undo for operations that write many frames (propagation, clearing a
//! sequence, Boolean on all frames).
//!
//! A snapshot is a copy of the current user's stored annotation rows, raster
//! and vector, for a set of frames: compressed `rle8` BLOBs and JSON, so a
//! long sequence costs little. The editor takes one before an operation and
//! one after; undo restores the first, redo the second.
//!
//! Restoring is per frame and guarded: a frame whose rows no longer match the
//! `expected` snapshot was edited since, and is left alone. Undo never throws
//! away later work.
//!
//! Snapshots live in memory only, and are dropped when the editor changes
//! sequence or closes the project.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use crate::storage::{DbState, queries};
use crate::utils::error::Result;

/// Past this many bytes, the oldest snapshots are dropped.
const BUDGET_BYTES: usize = 256 * 1024 * 1024;

/// One label's stored state on a frame.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
struct LabelRows {
    /// `(encoding, mask_data)`.
    raster: Option<(String, Vec<u8>)>,
    /// The `shapes` JSON.
    vectors: Option<String>,
}

/// A frame's rows, by label id.
type FrameRows = BTreeMap<i64, LabelRows>;

struct Snapshot {
    frames: BTreeMap<i64, FrameRows>,
    bytes: usize,
}

#[derive(Default)]
pub struct SnapshotStore {
    inner: Mutex<StoreInner>,
}

#[derive(Default)]
struct StoreInner {
    next_id: u32,
    snapshots: HashMap<u32, Snapshot>,
    /// Ids, oldest first.
    order: Vec<u32>,
}

impl StoreInner {
    fn insert(&mut self, snapshot: Snapshot) -> u32 {
        self.next_id += 1;
        let id = self.next_id;
        self.snapshots.insert(id, snapshot);
        self.order.push(id);
        // Keep the newest within budget, and always the one just taken.
        while self.order.len() > 1 && self.total_bytes() > BUDGET_BYTES {
            let oldest = self.order.remove(0);
            self.snapshots.remove(&oldest);
        }
        id
    }

    fn total_bytes(&self) -> usize {
        self.snapshots.values().map(|s| s.bytes).sum()
    }

    fn drop_ids(&mut self, ids: &[u32]) {
        for id in ids {
            self.snapshots.remove(id);
        }
        self.order.retain(|id| self.snapshots.contains_key(id));
    }

    fn clear(&mut self) {
        self.snapshots.clear();
        self.order.clear();
    }
}

#[derive(Serialize, Deserialize, Debug, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct RestoreReport {
    /// Frames put back to the snapshot.
    #[ts(type = "number[]")]
    pub restored: Vec<i64>,
    /// Frames left alone: edited since the operation.
    #[ts(type = "number[]")]
    pub kept: Vec<i64>,
    /// The snapshot was dropped (over budget, or the sequence changed):
    /// nothing was done.
    pub gone: bool,
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Copy the stored annotations of `frame_ids` and return the snapshot's id.
#[tauri::command]
pub fn snapshot_take(
    db: State<DbState>,
    store: State<SnapshotStore>,
    frame_ids: Vec<i64>,
) -> Result<u32> {
    let snapshot = db.with_conn(|conn| take(conn, &frame_ids))?;
    Ok(store.inner.lock().unwrap().insert(snapshot))
}

/// Put the frames of snapshot `target` back, except those whose rows differ
/// from snapshot `expected` (edited since).
#[tauri::command]
pub fn snapshot_restore(
    db: State<DbState>,
    store: State<SnapshotStore>,
    target: u32,
    expected: u32,
) -> Result<RestoreReport> {
    let inner = store.inner.lock().unwrap();
    let (Some(target), Some(expected)) =
        (inner.snapshots.get(&target), inner.snapshots.get(&expected))
    else {
        return Ok(RestoreReport { gone: true, ..Default::default() });
    };
    db.with_conn(|conn| restore(conn, target, expected))
}

#[tauri::command]
pub fn snapshot_drop(store: State<SnapshotStore>, ids: Vec<u32>) {
    store.inner.lock().unwrap().drop_ids(&ids);
}

#[tauri::command]
pub fn snapshot_clear(store: State<SnapshotStore>) {
    store.inner.lock().unwrap().clear();
}

// ── Work ────────────────────────────────────────────────────────────────────

fn take(conn: &Connection, frame_ids: &[i64]) -> Result<Snapshot> {
    let mut frames = BTreeMap::new();
    let mut bytes = 0;
    for &frame_id in frame_ids {
        let rows = read_frame(conn, frame_id)?;
        bytes += rows
            .values()
            .map(|r| {
                r.raster.as_ref().map_or(0, |(e, d)| e.len() + d.len())
                    + r.vectors.as_ref().map_or(0, String::len)
            })
            .sum::<usize>()
            + 64;
        frames.insert(frame_id, rows);
    }
    Ok(Snapshot { frames, bytes })
}

/// The current user's rows of one frame (through the user-scoped views).
fn read_frame(conn: &Connection, frame_id: i64) -> Result<FrameRows> {
    let mut rows = FrameRows::new();
    let mut raster =
        conn.prepare("SELECT label_id, encoding, mask_data FROM annotations WHERE frame_id = ?1")?;
    for row in raster.query_map(params![frame_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Vec<u8>>(2)?))
    })? {
        let (label, encoding, data) = row?;
        rows.entry(label).or_default().raster = Some((encoding, data));
    }
    let mut vectors =
        conn.prepare("SELECT label_id, shapes FROM vector_annotations WHERE frame_id = ?1")?;
    for row in vectors.query_map(params![frame_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })? {
        let (label, shapes) = row?;
        rows.entry(label).or_default().vectors = Some(shapes);
    }
    Ok(rows)
}

fn restore(conn: &Connection, target: &Snapshot, expected: &Snapshot) -> Result<RestoreReport> {
    let user = queries::current_user_id(conn)?;
    let mut report = RestoreReport::default();
    let tx = conn.unchecked_transaction()?;
    for (&frame_id, rows) in &target.frames {
        let Some(expected_rows) = expected.frames.get(&frame_id) else {
            continue;
        };
        if &read_frame(&tx, frame_id)? != expected_rows {
            report.kept.push(frame_id);
            continue;
        }
        if rows == expected_rows {
            continue; // the operation did not change this frame
        }
        write_frame(&tx, frame_id, user, rows)?;
        report.restored.push(frame_id);
    }
    tx.commit()?;
    Ok(report)
}

fn write_frame(conn: &Connection, frame_id: i64, user: i64, rows: &FrameRows) -> Result<()> {
    conn.execute(
        "DELETE FROM main.annotations WHERE frame_id = ?1 AND user_id = ?2",
        params![frame_id, user],
    )?;
    conn.execute(
        "DELETE FROM main.vector_annotations WHERE frame_id = ?1 AND user_id = ?2",
        params![frame_id, user],
    )?;
    for (&label_id, row) in rows {
        if let Some((encoding, data)) = &row.raster {
            conn.execute(
                "INSERT INTO main.annotations
                 (frame_id, label_id, user_id, encoding, mask_data, modified_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
                params![frame_id, label_id, user, encoding, data],
            )?;
        }
        if let Some(shapes) = &row.vectors {
            conn.execute(
                "INSERT INTO main.vector_annotations
                 (frame_id, label_id, user_id, shapes, modified_at)
                 VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)",
                params![frame_id, label_id, user, shapes],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::schema::SCHEMA;

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
            "INSERT OR REPLACE INTO annotations (frame_id, label_id, encoding, mask_data)
             VALUES (?1, ?2, 'rle8', ?3)",
            params![frame, label, data],
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

    #[test]
    fn undo_and_redo_a_multi_frame_write() {
        let conn = fixture();
        put_mask(&conn, 1, 1, &[1]);
        let before = take(&conn, &[1, 2, 3]).unwrap();
        // The "operation": overwrite frame 1, add frame 2.
        put_mask(&conn, 1, 1, &[7]);
        put_mask(&conn, 2, 2, &[8]);
        let after = take(&conn, &[1, 2, 3]).unwrap();

        let undo = restore(&conn, &before, &after).unwrap();
        assert_eq!(undo.restored, vec![1, 2]);
        assert!(undo.kept.is_empty());
        assert_eq!(mask_of(&conn, 1, 1).as_deref(), Some(&[1][..]));
        assert_eq!(mask_of(&conn, 2, 2), None);

        let redo = restore(&conn, &after, &before).unwrap();
        assert_eq!(redo.restored, vec![1, 2]);
        assert_eq!(mask_of(&conn, 2, 2).as_deref(), Some(&[8][..]));
    }

    #[test]
    fn keeps_frames_edited_since() {
        let conn = fixture();
        let before = take(&conn, &[1, 2]).unwrap();
        put_mask(&conn, 1, 1, &[7]);
        put_mask(&conn, 2, 1, &[7]);
        let after = take(&conn, &[1, 2]).unwrap();
        // Frame 2 is fixed by hand after the operation.
        put_mask(&conn, 2, 1, &[5]);

        let undo = restore(&conn, &before, &after).unwrap();
        assert_eq!(undo.restored, vec![1]);
        assert_eq!(undo.kept, vec![2]);
        assert_eq!(mask_of(&conn, 1, 1), None);
        assert_eq!(mask_of(&conn, 2, 1).as_deref(), Some(&[5][..]));
    }

    #[test]
    fn drops_the_oldest_over_budget() {
        let mut inner = StoreInner::default();
        let big = || Snapshot { frames: BTreeMap::new(), bytes: BUDGET_BYTES / 2 + 1 };
        let a = inner.insert(big());
        let b = inner.insert(big());
        assert!(!inner.snapshots.contains_key(&a));
        assert!(inner.snapshots.contains_key(&b));
    }
}
