//! Schema versioning: brings a project file up to [`SCHEMA_VERSION`] when it
//! is created or opened (see `queries::create_database` / `open_database`).

use rusqlite::{params, Connection};
use crate::utils::AppError;
use crate::utils::error::Result;

/// On-disk schema version. Bump it with the schema, and add an arm to
/// `run_migrations`.
pub const SCHEMA_VERSION: i64 = 8;

/// v1 -> v2: vector annotations. A no-op on a fresh database.
const MIGRATION_V2: &str = r#"
CREATE TABLE IF NOT EXISTS vector_annotations (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    shapes JSON NOT NULL,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(frame_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_vector_annotations_frame
    ON vector_annotations(frame_id);
"#;

/// v4 -> v5: frames decoded from video files. The columns the baseline could
/// not add to an existing `frames` table.
const MIGRATION_V5_FRAME_COLUMNS: &str = r#"
ALTER TABLE frames ADD COLUMN video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE frames ADD COLUMN video_frame INTEGER;
ALTER TABLE frames ADD COLUMN video_time REAL;
"#;

/// v5 -> v6: `videos.seek_preroll`. Videos of projects made under v5 get the
/// default, which is longer than needed.
const MIGRATION_V6_SEEK_PREROLL: &str =
    "ALTER TABLE videos ADD COLUMN seek_preroll REAL NOT NULL DEFAULT 1.0;";

/// The index finding a video's frames in order. Apart from the baseline
/// indexes, which are created before an older `frames` has these columns.
const VIDEO_FRAMES_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS idx_frames_video_frame ON frames(video_id, video_frame);";

/// The per-user tables as they were up to v3, with their columns. v4 rebuilds
/// them: SQLite cannot widen a `UNIQUE` constraint in place.
const V3_PER_USER_TABLES: &[(&str, &str)] = &[
    ("annotations", "id, frame_id, label_id, encoding, mask_data, modified_at"),
    ("vector_annotations", "id, frame_id, label_id, shapes, modified_at"),
    ("classifications", "id, frame_id, task_name, selected_classes, is_multilabel, modified_at"),
    ("text_descriptions", "id, frame_id, label_name, content, modified_at"),
    // Newer than v3, but the Python library creates projects in the v3 layout
    // and adds this table to them without `user_id`.
    ("regressions", "id, frame_id, task_name, value, modified_at"),
];

/// SQLite's `user_version` (0 on a fresh or unversioned database).
fn user_version(conn: &Connection) -> Result<i64> {
    conn.query_row("PRAGMA user_version;", [], |row| row.get(0))
        .map_err(AppError::Database)
}

/// Bring a database up to `SCHEMA_VERSION`. Forward only: a database stamped
/// with a newer version is refused.
pub(super) fn run_migrations(conn: &Connection) -> Result<()> {
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
        tx.execute_batch(MIGRATION_V2)
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
            tx.execute_batch(MIGRATION_V5_FRAME_COLUMNS)
                .map_err(AppError::Database)?;
        }
        tx.execute_batch(VIDEO_FRAMES_INDEX)
            .map_err(AppError::Database)?;
        v = 5;
    }

    // v5 -> v6: how much earlier than a video frame decoding starts.
    if v < 6 {
        if !has_column(&tx, "videos", "seek_preroll")? {
            tx.execute_batch(MIGRATION_V6_SEEK_PREROLL)
                .map_err(AppError::Database)?;
        }
        tx.execute_batch(VIDEO_FRAMES_INDEX)
            .map_err(AppError::Database)?;
        v = 6;
    }

    // v6 -> v7: frames converted from microscopy files, multi-page TIFFs
    // described by `frame_sources` (created by the baseline above). The bump
    // makes older builds refuse a project they would show one page of.
    if v < 7 {
        v = 7;
    }

    // v7 -> v8: regression values, in `regressions` (created by the baseline
    // above). The bump makes older builds refuse a project whose values they
    // would hide, and whose `regression_tasks` they would drop from the config
    // the next time they rewrote it.
    if v < 8 {
        v = 8;
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

    let outdated: Vec<&(&str, &str)> = V3_PER_USER_TABLES
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::queries::{configure_connection, DEFAULT_USER_ID};
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

    /// The Python library writes regression values into a v3 project, in a
    /// table without `user_id`.
    #[test]
    fn regression_values_of_a_project_without_accounts_go_to_the_first_one() {
        let conn = v3_project();
        conn.execute_batch(
            "CREATE TABLE regressions (id INTEGER PRIMARY KEY,
                 frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
                 task_name TEXT NOT NULL, value REAL NOT NULL,
                 modified_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(frame_id, task_name));
             CREATE INDEX idx_regressions_frame ON regressions(frame_id);
             INSERT INTO regressions (frame_id, task_name, value) VALUES (1, 'age', 42.0);",
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let (user, value): (i64, f64) = conn
            .query_row("SELECT user_id, value FROM regressions", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((user, value), (DEFAULT_USER_ID, 42.0));
        assert_eq!(
            n(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_regressions_frame'"),
            1,
            "the index was rebuilt on the new table"
        );
        // A second user can now give the same frame their own value.
        conn.execute_batch(
            "INSERT INTO users (id, name) VALUES (2, 'second');
             INSERT INTO regressions (frame_id, user_id, task_name, value) VALUES (1, 2, 'age', 50.0);",
        )
        .unwrap();
        assert_eq!(n(&conn, "SELECT COUNT(*) FROM regressions"), 2);
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
}
