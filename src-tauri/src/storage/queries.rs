use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;
use crate::utils::AppError;
use crate::utils::error::Result;
use crate::types::project::ProjectConfig;
use crate::types::image::{AnnotationData, MaskEncoding};

/// Current on-disk schema version. Bump this whenever the schema changes and
/// add a matching arm in `run_migrations`.
pub const SCHEMA_VERSION: i64 = 3;

/// Common configuration for all connections
fn configure_connection(conn: &Connection) -> Result<()> {
    // Use execute_batch for PRAGMAs that return values to avoid the "results returned" error
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
    ").map_err(AppError::Database)?;

    Ok(())
}

/// Read SQLite's `user_version` header field (0 on a fresh / pre-versioning DB).
fn user_version(conn: &Connection) -> Result<i64> {
    conn.query_row("PRAGMA user_version;", [], |row| row.get(0))
        .map_err(AppError::Database)
}

/// Bring a database up to `SCHEMA_VERSION`. Safe to call on fresh, legacy
/// (unversioned) and already-current databases. Migrating forward only:
/// a DB stamped with a newer version is refused rather than silently corrupted.
fn run_migrations(conn: &Connection) -> Result<()> {
    let version = user_version(conn)?;

    if version > SCHEMA_VERSION {
        return Err(AppError::Generic(format!(
            "This project was created with a newer version of Didascalie \
             (schema v{}, this build supports v{}). Please update the application.",
            version, SCHEMA_VERSION
        )));
    }

    // Always ensure the baseline tables exist, regardless of stored version.
    // The baseline SCHEMA is entirely `CREATE ... IF NOT EXISTS`, so this is a
    // no-op when everything is present but backfills tables that were added to
    // SCHEMA after a project was created (e.g. `registrations` on a project
    // made before registration existed) without needing a version bump.
    conn.execute_batch(super::schema::SCHEMA)
        .map_err(AppError::Database)?;

    if version == SCHEMA_VERSION {
        return Ok(());
    }

    // Apply migrations atomically so a partial/interrupted upgrade can't leave
    // the project in a half-migrated state.
    let tx = conn.unchecked_transaction().map_err(AppError::Database)?;
    let mut v = version;

    // v0 -> v1: baseline. The baseline SCHEMA was already applied above, so this
    // only stamps the version (also the adoption path for legacy unversioned DBs).
    if v < 1 {
        v = 1;
    }

    // v1 -> v2: vector annotations table.
    if v < 2 {
        tx.execute_batch(super::schema::MIGRATION_V2)
            .map_err(AppError::Database)?;
        v = 2;
    }

    // v2 -> v3: uint8-per-label masks. No DDL change — the `annotations`
    // table is unchanged and its `encoding` column already accepts the new
    // `rle8` value. Bumping the version only stamps the file so older builds
    // (which support up to v2) refuse to open it rather than mis-reading the
    // new encoding. New masks are written as `rle8`; legacy `rle`/`png` rows
    // stay readable and are upgraded lazily on the next save.
    if v < 3 {
        v = 3;
    }

    // Future migrations go here, one block per version:
    //   if v < 4 { tx.execute_batch(MIGRATION_V4)?; v = 4; }

    // PRAGMA doesn't accept bound parameters; v is an internal integer.
    tx.execute_batch(&format!("PRAGMA user_version = {};", v))
        .map_err(AppError::Database)?;
    tx.commit().map_err(AppError::Database)?;
    Ok(())
}

pub fn create_database(path: &Path) -> Result<Connection> {
    // Instead of deleting, we use SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE
    // If you WANT to overwrite, your logic is fine, but usually,
    // apps should prompt "File exists, overwrite?" in the UI first.
    let conn = Connection::open(path)
        .map_err(|e| AppError::Database(e))?;

    configure_connection(&conn)?;
    run_migrations(&conn)?;

    Ok(conn)
}

pub fn open_database(path: &Path) -> Result<Connection> {
    if !path.exists() {
        return Err(AppError::Generic(format!("Project not found: {}", path.display())));
    }

    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX
    ).map_err(|e| AppError::Database(e))?;

    configure_connection(&conn)?;
    run_migrations(&conn)?;

    Ok(conn)
}

/// Insert project config as JSON
pub fn insert_project(conn: &Connection, config: &ProjectConfig) -> Result<()> {
    let config_json = serde_json::to_string(config)
        .map_err(|e| AppError::Generic(format!("Failed to serialize config: {}", e)))?;

    conn.execute(
        "INSERT INTO project (id, config) VALUES (1, ?1)",
        params![config_json],
    ).map_err(|e| AppError::Database(e))?;

    Ok(())
}

/// Get total frame count
pub fn get_frames_count(conn: &Connection) -> Result<i64> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM frames",
        [],
        |row| row.get(0),
    ).map_err(|e| AppError::Database(e))?;

    Ok(count)
}

/// Get sequence count
pub fn get_sequences_count(conn: &Connection) -> Result<i64> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sequences",
        [],
        |row| row.get(0),
    ).map_err(|e| AppError::Database(e))?;

    Ok(count)
}

pub fn get_project_config(conn: &Connection) -> Result<ProjectConfig> {
    let json: String = conn.query_row(
        "SELECT config FROM project WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(&json)?)
}



pub fn sync_labels_from_config(conn: &Connection, config: &ProjectConfig) -> Result<()> {
    let labels = match &config.segmentation_labels {
        Some(labels) => labels,
        None => return Ok(()),
    };

    // Upsert each label
    for (i, label) in labels.iter().enumerate() {
        // Derived from the project flag, not from the presence of `shades`.
        // Shades are deterministic and regenerated from the label colour on
        // load, so the launcher writes labels with none — which made this come
        // out false for every project created through the UI. The palette then
        // mapped every instance id to the label's base colour and instances
        // were indistinguishable once committed. `shades` is still honoured so
        // older project files keep their flag.
        let is_instance = config.instance_segmentation_enabled || label.shades.is_some();
        conn.execute(
            "INSERT INTO labels (name, color, is_instance, sort_order)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(name) DO UPDATE SET
                color = excluded.color,
                is_instance = excluded.is_instance,
                sort_order = excluded.sort_order",
            params![label.name, label.color, is_instance, i as i32],
        )?;
    }

    // Remove labels not in config (only if no annotations reference them)
    let label_names: Vec<String> = labels.iter().map(|l| l.name.clone()).collect();
    if !label_names.is_empty() {
        let placeholders = label_names.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM labels 
             WHERE name NOT IN ({}) 
             AND id NOT IN (SELECT DISTINCT label_id FROM annotations)",
            placeholders
        );
        let params: Vec<&dyn rusqlite::ToSql> = label_names
            .iter()
            .map(|s| s as &dyn rusqlite::ToSql)
            .collect();
        conn.execute(&sql, params.as_slice())?;
    }

    Ok(())
}



// ============ Images ============


// ============ Annotations ============

pub fn save_annotation(
    conn: &Connection,
    frame_id: i64,
    label_id: i64,
    mask_data: &[u8],
    encoding: MaskEncoding,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO annotations 
         (frame_id, label_id, encoding, mask_data, modified_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        params![frame_id, label_id, encoding.as_str(), mask_data],
    )?;
    Ok(())
}

/// Erase every annotation on every frame of `sequence_id`, returning how many
/// frames actually carried one.
///
/// Both tables, because a label's annotation is raster *and* vector; clearing
/// one alone leaves the frame looking annotated. The count is of frames rather
/// than deleted rows so the caller can report something a user recognises.
pub fn clear_sequence_annotations(conn: &Connection, sequence_id: i64) -> Result<usize> {
    let affected: i64 = conn.query_row(
        "SELECT COUNT(*) FROM frames f WHERE f.sequence_id = ?1 \
           AND (EXISTS (SELECT 1 FROM annotations a WHERE a.frame_id = f.id) \
             OR EXISTS (SELECT 1 FROM vector_annotations v WHERE v.frame_id = f.id))",
        params![sequence_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "DELETE FROM annotations WHERE frame_id IN \
           (SELECT id FROM frames WHERE sequence_id = ?1)",
        params![sequence_id],
    )?;
    conn.execute(
        "DELETE FROM vector_annotations WHERE frame_id IN \
           (SELECT id FROM frames WHERE sequence_id = ?1)",
        params![sequence_id],
    )?;
    Ok(affected as usize)
}

/// Store the fitted head, replacing whatever was there.
///
/// `meta` is opaque JSON to this layer: the storage module has no business
/// knowing a head's architecture, and letting the ML module change its own
/// metadata without a schema migration is the point of keeping it that way.
pub fn save_ml_model(conn: &Connection, meta: &str, weights: &[u8]) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ml_models (id, meta, weights, modified_at)
         VALUES (1, ?1, ?2, datetime('now'))",
        params![meta, weights],
    )?;
    Ok(())
}

/// The stored head as `(meta json, weights)`, or None when none was ever saved.
pub fn load_ml_model(conn: &Connection) -> Result<Option<(String, Vec<u8>)>> {
    let mut stmt = conn.prepare("SELECT meta, weights FROM ml_models WHERE id = 1")?;
    let mut rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// Forget the stored head. Returns whether there was one.
pub fn delete_ml_model(conn: &Connection) -> Result<bool> {
    Ok(conn.execute("DELETE FROM ml_models WHERE id = 1", [])? > 0)
}

pub fn get_frame_dimensions(conn: &Connection, frame_id: i64) -> Result<(u32, u32)> {
    let (width, height): (u32, u32) = conn.query_row(
        "SELECT width, height FROM frames WHERE id = ?1",
        params![frame_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((width, height))
}

pub fn load_annotations(conn: &Connection, frame_id: i64) -> Result<Vec<AnnotationData>> {
    let mut stmt = conn.prepare(
        "SELECT l.id, l.name, l.color, a.encoding, a.mask_data
         FROM annotations a
         JOIN labels l ON a.label_id = l.id
         WHERE a.frame_id = ?1
         ORDER BY l.sort_order"
    )?;
    
    let rows = stmt.query_map(params![frame_id], |row| {
        Ok(AnnotationData {
            label_id: row.get(0)?,
            label_name: row.get(1)?,
            color: row.get(2)?,
            encoding: MaskEncoding::from_str(&row.get::<_, String>(3)?),
            mask_data: row.get(4)?,
        })
    })?;
    
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn read_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version;", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn migrations_stamp_current_version_and_are_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();

        run_migrations(&conn).unwrap();
        assert_eq!(read_version(&conn), SCHEMA_VERSION);

        // Running again must be a no-op (no error, version unchanged).
        run_migrations(&conn).unwrap();
        assert_eq!(read_version(&conn), SCHEMA_VERSION);

        // Baseline schema actually created the core tables.
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN \
                 ('project','labels','sequences','frames','annotations')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 5);
    }

    #[test]
    fn the_saved_model_round_trips_and_keeps_only_the_latest() {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        run_migrations(&conn).unwrap();

        assert!(load_ml_model(&conn).unwrap().is_none(), "a fresh project has no model");
        assert!(!delete_ml_model(&conn).unwrap(), "nothing to delete yet");

        // Weights are binary and must survive as bytes, zeros included.
        let weights: Vec<u8> = (0..=255u8).chain([0, 0, 0]).collect();
        save_ml_model(&conn, r#"{"classes":3}"#, &weights).unwrap();
        let (meta, got) = load_ml_model(&conn).unwrap().expect("model must load");
        assert_eq!(meta, r#"{"classes":3}"#);
        assert_eq!(got, weights, "weights must survive verbatim");

        // Retraining replaces rather than accumulates.
        save_ml_model(&conn, r#"{"classes":5}"#, &[1, 2, 3]).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM ml_models", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "a second fit must overwrite the first");
        assert_eq!(load_ml_model(&conn).unwrap().unwrap().0, r#"{"classes":5}"#);

        assert!(delete_ml_model(&conn).unwrap());
        assert!(load_ml_model(&conn).unwrap().is_none());
    }

    /// Two sequences, two frames each. Sequence 1 is annotated (frame 1 raster,
    /// frame 2 vector), sequence 2 is annotated too so we can prove scoping.
    fn project_with_two_sequences() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        run_migrations(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO labels (id, name, color) VALUES (1, 'a', '#ff0000');
             INSERT INTO sequences (id, name) VALUES (1, 's1'), (2, 's2');
             INSERT INTO frames (id, sequence_id, frame_index, width, height)
               VALUES (1, 1, 0, 8, 8), (2, 1, 1, 8, 8),
                      (3, 2, 0, 8, 8), (4, 2, 1, 8, 8);
             INSERT INTO annotations (frame_id, label_id, encoding, mask_data)
               VALUES (1, 1, 'rle8', x'00'), (3, 1, 'rle8', x'00');
             INSERT INTO vector_annotations (frame_id, label_id, shapes)
               VALUES (2, 1, '[{}]'), (4, 1, '[{}]');",
        )
        .unwrap();
        conn
    }

    fn counts(conn: &Connection) -> (i64, i64) {
        (
            conn.query_row("SELECT COUNT(*) FROM annotations", [], |r| r.get(0)).unwrap(),
            conn.query_row("SELECT COUNT(*) FROM vector_annotations", [], |r| r.get(0))
                .unwrap(),
        )
    }

    #[test]
    fn clearing_a_sequence_removes_both_kinds_and_leaves_others_alone() {
        let conn = project_with_two_sequences();
        assert_eq!(counts(&conn), (2, 2));

        // Frames 1 and 2 carry annotations; frames 3 and 4 belong to sequence 2.
        assert_eq!(clear_sequence_annotations(&conn, 1).unwrap(), 2);
        assert_eq!(counts(&conn), (1, 1), "sequence 2 must be untouched");

        let survivors: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT frame_id FROM annotations UNION SELECT frame_id FROM vector_annotations ORDER BY 1")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(survivors, vec![3, 4]);
    }

    #[test]
    fn clearing_an_already_empty_sequence_reports_nothing() {
        let conn = project_with_two_sequences();
        clear_sequence_annotations(&conn, 1).unwrap();
        assert_eq!(
            clear_sequence_annotations(&conn, 1).unwrap(),
            0,
            "a second clear has nothing left to report"
        );
    }

    #[test]
    fn legacy_unversioned_db_is_adopted() {
        // Simulate a pre-versioning project: tables exist, user_version still 0.
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        conn.execute_batch(super::super::schema::SCHEMA).unwrap();
        assert_eq!(read_version(&conn), 0);

        run_migrations(&conn).unwrap();
        assert_eq!(read_version(&conn), SCHEMA_VERSION);
    }

    #[test]
    fn backfills_tables_added_after_versioning() {
        // Simulate an older project stamped at an earlier version whose baseline
        // predates the `registrations` table.
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id INTEGER PRIMARY KEY);
             PRAGMA user_version = 2;",
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let has_registrations: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='registrations'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_registrations, 1);
        assert_eq!(read_version(&conn), SCHEMA_VERSION);
    }

    #[test]
    fn refuses_database_from_newer_build() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION + 1))
            .unwrap();
        assert!(run_migrations(&conn).is_err());
    }
    /// Config with one segmentation label and no shades — what the launcher
    /// produces, since shades are regenerated from the colour on load.
    fn config_with_label(instance: bool) -> ProjectConfig {
        ProjectConfig {
            instance_segmentation_enabled: instance,
            segmentation_labels: Some(vec![crate::types::project::LabelConfig {
                name: "cell".into(),
                color: "#ff0000".into(),
                shades: None,
            }]),
            ..Default::default()
        }
    }

    fn synced_is_instance(config: &ProjectConfig) -> bool {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        run_migrations(&conn).unwrap();
        sync_labels_from_config(&conn, config).unwrap();
        conn.query_row("SELECT is_instance FROM labels WHERE name = 'cell'", [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    /// The bug this pins: `is_instance` was inferred from `shades.is_some()`, so
    /// a project created through the launcher — which writes no shades — got
    /// `false`, and every instance rendered in the label's base colour.
    #[test]
    fn instance_project_marks_its_labels_as_instances_without_shades() {
        assert!(synced_is_instance(&config_with_label(true)));
    }

    #[test]
    fn semantic_project_leaves_labels_as_semantic() {
        assert!(!synced_is_instance(&config_with_label(false)));
    }

    /// Older project files carry explicit shades and no reliable project flag.
    #[test]
    fn stored_shades_still_mark_a_label_as_an_instance() {
        let mut config = config_with_label(false);
        config.segmentation_labels.as_mut().unwrap()[0].shades =
            Some(vec!["#111111".into(), "#222222".into()]);
        assert!(synced_is_instance(&config));
    }
}
