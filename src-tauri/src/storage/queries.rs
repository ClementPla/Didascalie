use rusqlite::{params, Connection, OpenFlags};
use super::migrate::run_migrations;
use std::path::Path;
use crate::utils::AppError;
use crate::utils::error::Result;
use crate::types::project::ProjectConfig;
use crate::types::image::{AnnotationData, MaskEncoding};

/// The account every project has. See the `users` table in `schema.rs`.
pub const DEFAULT_USER_ID: i64 = 1;

/// SQL condition: frame `f` carries a raster or a vector annotation. A frame
/// may hold vector paths only.
pub const FRAME_HAS_ANNOTATION: &str = "(EXISTS (SELECT 1 FROM annotations a WHERE a.frame_id = f.id) \
     OR EXISTS (SELECT 1 FROM vector_annotations v WHERE v.frame_id = f.id))";

pub(super) fn configure_connection(conn: &Connection) -> Result<()> {
    // `execute_batch`: these PRAGMAs return rows.
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
    ").map_err(AppError::Database)?;

    Ok(())
}

// ============ User scope ============

/// Make this connection see one user's annotations only.
///
/// Each per-user table gets a `TEMP` view of the same name, filtered on the
/// logged-in user; SQLite resolves an unqualified name in `temp` before
/// `main`. So:
///
/// - Reads are scoped without any per-query `AND user_id = ?`.
/// - A view cannot be written to: writers target `main.<table>` and pass
///   [`current_user_id`].
/// - `main.<table>` is everyone's rows, for project edits, the inter-grader
///   report and account deletion.
///
/// The views live in the connection, not in the file. Until
/// [`set_session_user`] is called they are empty and writes are refused.
/// Must run after the migrations, or `CREATE TABLE IF NOT EXISTS annotations`
/// would take the view for the table.
pub fn install_user_scope(conn: &Connection) -> Result<()> {
    let mut sql = String::from(
        "CREATE TEMP TABLE IF NOT EXISTS dida_session (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             user_id INTEGER
         );
         INSERT OR IGNORE INTO dida_session (id, user_id) VALUES (1, NULL);",
    );
    for (table, columns) in super::schema::USER_SCOPED_TABLES {
        sql.push_str(&format!(
            "CREATE TEMP VIEW IF NOT EXISTS {table} AS
               SELECT {columns} FROM main.{table}
               WHERE user_id = (SELECT user_id FROM temp.dida_session);"
        ));
    }
    conn.execute_batch(&sql)?;
    Ok(())
}

fn has_user_scope(conn: &Connection) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_temp_master WHERE name = 'dida_session'",
        [],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

/// Log a user in on this connection (`None` logs out).
pub fn set_session_user(conn: &Connection, user_id: Option<i64>) -> Result<()> {
    conn.execute("UPDATE temp.dida_session SET user_id = ?1", params![user_id])?;
    Ok(())
}

/// The logged-in user, or `None` when nobody is.
pub fn session_user(conn: &Connection) -> Result<Option<i64>> {
    if !has_user_scope(conn)? {
        return Ok(Some(DEFAULT_USER_ID));
    }
    Ok(conn.query_row("SELECT user_id FROM temp.dida_session", [], |row| row.get(0))?)
}

/// Whose rows a write belongs to: the logged-in user. A connection without
/// [`install_user_scope`] (a script, a test) acts as the default account.
pub fn current_user_id(conn: &Connection) -> Result<i64> {
    session_user(conn)?.ok_or_else(|| AppError::Other("Nobody is logged in.".into()))
}

pub fn create_database(path: &Path) -> Result<Connection> {
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

pub fn insert_project(conn: &Connection, config: &ProjectConfig) -> Result<()> {
    let config_json = serde_json::to_string(config)
        .map_err(|e| AppError::Generic(format!("Failed to serialize config: {}", e)))?;

    conn.execute(
        "INSERT INTO project (id, config) VALUES (1, ?1)",
        params![config_json],
    ).map_err(|e| AppError::Database(e))?;

    Ok(())
}

pub fn get_frames_count(conn: &Connection) -> Result<i64> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM frames",
        [],
        |row| row.get(0),
    ).map_err(|e| AppError::Database(e))?;

    Ok(count)
}

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

    for (i, label) in labels.iter().enumerate() {
        // From the project flag: the launcher writes labels without `shades`, which
        // are regenerated from the colour on load. `shades` is still honoured for
        // older files.
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

    // Remove labels not in config, unless masks or shapes reference them.
    let label_names: Vec<String> = labels.iter().map(|l| l.name.clone()).collect();
    if !label_names.is_empty() {
        let placeholders = label_names.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM labels 
             WHERE name NOT IN ({}) 
             AND id NOT IN (SELECT DISTINCT label_id FROM main.annotations)
             AND id NOT IN (SELECT DISTINCT label_id FROM main.vector_annotations)",
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

// ============ Annotations ============

pub fn save_annotation(
    conn: &Connection,
    frame_id: i64,
    label_id: i64,
    mask_data: &[u8],
    encoding: MaskEncoding,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO main.annotations
         (frame_id, label_id, user_id, encoding, mask_data, modified_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
        params![frame_id, label_id, current_user_id(conn)?, encoding.as_str(), mask_data],
    )?;
    Ok(())
}

/// A sequence's stored display settings (JSON), if any.
pub fn load_display_settings(conn: &Connection, sequence_id: i64) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            "SELECT settings FROM main.sequence_display WHERE sequence_id = ?1",
            params![sequence_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Store a sequence's display settings (JSON), or forget them with `None`.
pub fn save_display_settings(conn: &Connection, sequence_id: i64, settings: Option<&str>) -> Result<()> {
    match settings {
        Some(json) => conn.execute(
            "INSERT INTO main.sequence_display (sequence_id, settings, modified_at)
             VALUES (?1, ?2, CURRENT_TIMESTAMP)
             ON CONFLICT(sequence_id) DO UPDATE SET settings = excluded.settings,
                                                    modified_at = CURRENT_TIMESTAMP",
            params![sequence_id, json],
        )?,
        None => conn.execute(
            "DELETE FROM main.sequence_display WHERE sequence_id = ?1",
            params![sequence_id],
        )?,
    };
    Ok(())
}

/// The sequence a frame belongs to.
pub fn frame_sequence_id(conn: &Connection, frame_id: i64) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT sequence_id FROM main.frames WHERE id = ?1",
        params![frame_id],
        |row| row.get(0),
    )?)
}

/// Replace the current user's vector shapes of one (frame, label).
pub fn upsert_vector_shapes(
    conn: &Connection,
    frame_id: i64,
    label_id: i64,
    user_id: i64,
    shapes_json: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO main.vector_annotations (frame_id, label_id, user_id, shapes, modified_at)
         VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
         ON CONFLICT(frame_id, label_id, user_id)
         DO UPDATE SET shapes = excluded.shapes, modified_at = CURRENT_TIMESTAMP",
        (frame_id, label_id, user_id, shapes_json),
    )?;
    Ok(())
}

/// Erase every annotation the current user made on the frames of
/// `sequence_id`, raster and vector, and return how many frames carried one.
pub fn clear_sequence_annotations(conn: &Connection, sequence_id: i64) -> Result<usize> {
    let affected: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM frames f WHERE f.sequence_id = ?1 AND {FRAME_HAS_ANNOTATION}"),
        params![sequence_id],
        |row| row.get(0),
    )?;

    let user = current_user_id(conn)?;
    conn.execute(
        "DELETE FROM main.annotations WHERE user_id = ?2 AND frame_id IN \
           (SELECT id FROM frames WHERE sequence_id = ?1)",
        params![sequence_id, user],
    )?;
    conn.execute(
        "DELETE FROM main.vector_annotations WHERE user_id = ?2 AND frame_id IN \
           (SELECT id FROM frames WHERE sequence_id = ?1)",
        params![sequence_id, user],
    )?;
    Ok(affected as usize)
}

/// Store the fitted head, replacing the previous one. `meta` is opaque JSON
/// here.
pub fn save_ml_model(conn: &Connection, meta: &str, weights: &[u8]) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ml_models (id, meta, weights, modified_at)
         VALUES (1, ?1, ?2, datetime('now'))",
        params![meta, weights],
    )?;
    Ok(())
}

/// The stored head as `(meta json, weights)`.
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

    /// Config with one segmentation label and no shades, as the launcher writes.
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

    /// `is_instance` comes from the project flag, not from `shades.is_some()`.
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
