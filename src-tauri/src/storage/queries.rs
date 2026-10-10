use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;
use crate::utils::AppError;
use crate::utils::error::Result;
use crate::types::project::ProjectConfig;
use crate::types::image::{AnnotationData, MaskEncoding};

/// On-disk schema version. Bump it with the schema, and add an arm to
/// `run_migrations`.
pub const SCHEMA_VERSION: i64 = 6;

/// The account every project has. See the `users` table in `schema.rs`.
pub const DEFAULT_USER_ID: i64 = 1;

fn configure_connection(conn: &Connection) -> Result<()> {
    // `execute_batch`: these PRAGMAs return rows.
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
    ").map_err(AppError::Database)?;

    Ok(())
}

/// SQLite's `user_version` (0 on a fresh or unversioned database).
fn user_version(conn: &Connection) -> Result<i64> {
    conn.query_row("PRAGMA user_version;", [], |row| row.get(0))
        .map_err(AppError::Database)
}

/// Bring a database up to `SCHEMA_VERSION`. Forward only: a database stamped
/// with a newer version is refused.
fn run_migrations(conn: &Connection) -> Result<()> {
    let version = user_version(conn)?;

    if version > SCHEMA_VERSION {
        return Err(AppError::Generic(format!(
            "This project was created with a newer version of Didascalie \
             (schema v{}, this build supports v{}). Please update the application.",
            version, SCHEMA_VERSION
        )));
    }

    // The baseline is all `CREATE ... IF NOT EXISTS`: this backfills tables added
    // to SCHEMA after a project was created, without a version bump.
    conn.execute_batch(super::schema::SCHEMA)
        .map_err(AppError::Database)?;

    if version == SCHEMA_VERSION {
        return Ok(());
    }

    // One transaction, so an interrupted upgrade leaves nothing half-migrated.
    let tx = conn.unchecked_transaction().map_err(AppError::Database)?;
    let mut v = version;

    // v0 -> v1: the baseline, applied above. Only stamps the version.
    if v < 1 {
        v = 1;
    }

    // v1 -> v2: vector annotations table.
    if v < 2 {
        tx.execute_batch(super::schema::MIGRATION_V2)
            .map_err(AppError::Database)?;
        v = 2;
    }

    // v2 -> v3: uint8-per-label masks (`rle8`). No DDL change: the bump makes
    // older builds refuse the file instead of misreading the new encoding.
    if v < 3 {
        v = 3;
    }

    // v3 -> v4: user accounts. What the project held goes to the account created
    // here.
    if v < 4 {
        migrate_to_user_accounts(&tx)?;
        v = 4;
    }

    // v4 -> v5: frames decoded from video files.
    if v < 5 {
        if !has_column(&tx, "frames", "video_id")? {
            tx.execute_batch(super::schema::MIGRATION_V5_FRAME_COLUMNS)
                .map_err(AppError::Database)?;
        }
        tx.execute_batch(super::schema::VIDEO_FRAMES_INDEX)
            .map_err(AppError::Database)?;
        v = 5;
    }

    // v5 -> v6: how much earlier than a video frame decoding starts.
    if v < 6 {
        if !has_column(&tx, "videos", "seek_preroll")? {
            tx.execute_batch(super::schema::MIGRATION_V6_SEEK_PREROLL)
                .map_err(AppError::Database)?;
        }
        tx.execute_batch(super::schema::VIDEO_FRAMES_INDEX)
            .map_err(AppError::Database)?;
        v = 6;
    }

    // PRAGMA takes no bound parameters.
    tx.execute_batch(&format!("PRAGMA user_version = {};", v))
        .map_err(AppError::Database)?;
    tx.commit().map_err(AppError::Database)?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        params![table, column],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

/// v3 -> v4. On a fresh database only the first account is missing.
fn migrate_to_user_accounts(conn: &Connection) -> Result<()> {
    // What the project held before accounts goes to its first administrator.
    let owner: i64 = conn.query_row(
        "SELECT id FROM users ORDER BY role = 'admin' DESC, id LIMIT 1",
        [],
        |row| row.get(0),
    )?;

    let outdated: Vec<&(&str, &str)> = super::schema::V3_PER_USER_TABLES
        .iter()
        .filter(|(table, _)| !has_column(conn, table, "user_id").unwrap_or(true))
        .collect();
    if !outdated.is_empty() {
        for (table, _) in &outdated {
            conn.execute_batch(&format!("ALTER TABLE {table} RENAME TO {table}_v3;"))?;
        }
        // Recreates the tables just moved aside, in their current shape.
        conn.execute_batch(super::schema::SCHEMA)?;
        for (table, columns) in &outdated {
            conn.execute(
                &format!(
                    "INSERT INTO {table} ({columns}, user_id)
                     SELECT {columns}, ?1 FROM {table}_v3"
                ),
                params![owner],
            )?;
            conn.execute_batch(&format!("DROP TABLE {table}_v3;"))?;
        }
        // Once more for the indexes: each kept its name while its table was renamed,
        // so it was skipped above and then went with the dropped table.
        conn.execute_batch(super::schema::SCHEMA)?;
    }

    // "Reviewed" used to be one flag per frame; it becomes the owner's review.
    if has_column(conn, "frames", "reviewed")? {
        conn.execute(
            "INSERT OR IGNORE INTO frame_reviews (frame_id, user_id)
             SELECT id, ?1 FROM frames WHERE reviewed = 1",
            params![owner],
        )?;
    }
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

    // Remove labels not in config (only if no annotations reference them)
    let label_names: Vec<String> = labels.iter().map(|l| l.name.clone()).collect();
    if !label_names.is_empty() {
        let placeholders = label_names.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM labels 
             WHERE name NOT IN ({}) 
             AND id NOT IN (SELECT DISTINCT label_id FROM main.annotations)",
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

/// Erase every annotation the current user made on the frames of
/// `sequence_id`, raster and vector, and return how many frames carried one.
pub fn clear_sequence_annotations(conn: &Connection, sequence_id: i64) -> Result<usize> {
    let affected: i64 = conn.query_row(
        "SELECT COUNT(*) FROM frames f WHERE f.sequence_id = ?1 \
           AND (EXISTS (SELECT 1 FROM annotations a WHERE a.frame_id = f.id) \
             OR EXISTS (SELECT 1 FROM vector_annotations v WHERE v.frame_id = f.id))",
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

    /// A project as v3 left it: no accounts, one annotation set per frame.
    fn v3_project() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id INTEGER PRIMARY KEY CHECK (id = 1), config JSON NOT NULL,
                 created_at TEXT DEFAULT CURRENT_TIMESTAMP);
             CREATE TABLE labels (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                 color TEXT NOT NULL, is_instance BOOLEAN DEFAULT FALSE, sort_order INTEGER DEFAULT 0);
             CREATE TABLE sequences (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                 sort_order INTEGER DEFAULT 0);
             CREATE TABLE frames (id INTEGER PRIMARY KEY,
                 sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
                 frame_index INTEGER NOT NULL, relative_path TEXT, content_hash TEXT,
                 embedded_data BLOB, width INTEGER NOT NULL, height INTEGER NOT NULL,
                 reviewed BOOLEAN DEFAULT FALSE, UNIQUE(sequence_id, frame_index));
             CREATE TABLE annotations (id INTEGER PRIMARY KEY,
                 frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
                 label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
                 encoding TEXT NOT NULL DEFAULT 'rle', mask_data BLOB NOT NULL,
                 modified_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(frame_id, label_id));
             CREATE TABLE vector_annotations (id INTEGER PRIMARY KEY,
                 frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
                 label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
                 shapes JSON NOT NULL, modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
                 UNIQUE(frame_id, label_id));
             CREATE TABLE classifications (id INTEGER PRIMARY KEY,
                 frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
                 task_name TEXT NOT NULL, selected_classes JSON NOT NULL,
                 is_multilabel BOOLEAN DEFAULT FALSE, modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
                 UNIQUE(frame_id, task_name));
             CREATE TABLE text_descriptions (id INTEGER PRIMARY KEY,
                 frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
                 label_name TEXT NOT NULL, content TEXT NOT NULL,
                 modified_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(frame_id, label_name));
             CREATE INDEX idx_annotations_frame ON annotations(frame_id);

             INSERT INTO labels (id, name, color) VALUES (1, 'a', '#ff0000');
             INSERT INTO sequences (id, name) VALUES (1, 's');
             INSERT INTO frames (id, sequence_id, frame_index, width, height, reviewed)
               VALUES (1, 1, 0, 2, 2, 1), (2, 1, 1, 2, 2, 0);
             INSERT INTO annotations (id, frame_id, label_id, encoding, mask_data, modified_at)
               VALUES (7, 1, 1, 'rle8', x'0102', '2024-01-02 03:04:05');
             INSERT INTO vector_annotations (frame_id, label_id, shapes) VALUES (2, 1, '[{}]');
             INSERT INTO classifications (frame_id, task_name, selected_classes, is_multilabel)
               VALUES (1, 'quality', '[\"good\"]', 0);
             INSERT INTO text_descriptions (frame_id, label_name, content) VALUES (1, 'notes', 'hi');
             PRAGMA user_version = 3;",
        )
        .unwrap();
        conn
    }

    /// An older project gains what video frames need; its image frames are
    /// untouched.
    #[test]
    fn an_older_project_gains_the_video_columns() {
        let conn = v3_project();
        run_migrations(&conn).unwrap();
        for column in ["video_id", "video_frame", "video_time"] {
            assert!(has_column(&conn, "frames", column).unwrap(), "{column}");
        }
        assert_eq!(n(&conn, "SELECT COUNT(*) FROM frames WHERE video_id IS NULL"), 2);
        assert_eq!(n(&conn, "SELECT COUNT(*) FROM videos"), 0);
        // Deleting a video takes its frames along.
        conn.execute_batch(
            "INSERT INTO videos (id, relative_path, frame_count, fps, seek_margin, seek_preroll)
               VALUES (1, 'clip.mp4', 1, 30, 0.01, 0.1);
             INSERT INTO frames (sequence_id, frame_index, width, height, video_id, video_frame, video_time)
               VALUES (1, 2, 2, 2, 1, 0, 0);
             DELETE FROM videos;",
        )
        .unwrap();
        assert_eq!(n(&conn, "SELECT COUNT(*) FROM frames"), 2);
    }

    fn n(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// A project from before accounts keeps every annotation and gains one
    /// administrator who owns them.
    #[test]
    fn a_project_without_accounts_gains_one_that_owns_everything() {
        let conn = v3_project();
        run_migrations(&conn).unwrap();
        assert_eq!(read_version(&conn), SCHEMA_VERSION);

        assert_eq!(n(&conn, "SELECT COUNT(*) FROM users WHERE role = 'admin'"), 1);
        for table in ["annotations", "vector_annotations", "classifications", "text_descriptions"] {
            assert_eq!(n(&conn, &format!("SELECT COUNT(*) FROM {table}")), 1, "{table} kept its row");
            assert_eq!(
                n(&conn, &format!("SELECT COUNT(*) FROM {table} WHERE user_id = {DEFAULT_USER_ID}")),
                1,
                "{table} row belongs to the first account"
            );
        }

        // Rows survive verbatim, ids and timestamps included.
        let (id, mask, at): (i64, Vec<u8>, String) = conn
            .query_row("SELECT id, mask_data, modified_at FROM annotations", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!((id, mask, at.as_str()), (7, vec![1, 2], "2024-01-02 03:04:05"));

        // The one reviewed frame becomes that account's review.
        assert_eq!(n(&conn, "SELECT frame_id FROM frame_reviews"), 1);
        assert_eq!(n(&conn, "SELECT COUNT(*) FROM frame_reviews"), 1);

        assert_eq!(n(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%_v3'"), 0);
        assert_eq!(
            n(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_annotations_frame'"),
            1,
            "the index was rebuilt on the new table"
        );
    }

    /// A second user annotating the same frame and label used to violate
    /// `UNIQUE(frame_id, label_id)`.
    #[test]
    fn a_migrated_project_accepts_a_second_users_annotation_of_the_same_frame() {
        let conn = v3_project();
        run_migrations(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO users (id, name) VALUES (2, 'second');
             INSERT INTO annotations (frame_id, label_id, user_id, encoding, mask_data)
               VALUES (1, 1, 2, 'rle8', x'09');",
        )
        .unwrap();
        assert_eq!(n(&conn, "SELECT COUNT(*) FROM annotations WHERE frame_id = 1"), 2);
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let conn = v3_project();
        run_migrations(&conn).unwrap();
        run_migrations(&conn).unwrap();
        assert_eq!(n(&conn, "SELECT COUNT(*) FROM users"), 1);
        assert_eq!(n(&conn, "SELECT COUNT(*) FROM annotations"), 1);
        assert_eq!(n(&conn, "SELECT COUNT(*) FROM frame_reviews"), 1);
    }

    #[test]
    fn refuses_database_from_newer_build() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION + 1))
            .unwrap();
        assert!(run_migrations(&conn).is_err());
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
