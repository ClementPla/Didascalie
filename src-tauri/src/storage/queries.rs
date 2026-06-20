use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;
use crate::utils::AppError;
use crate::utils::error::Result;
use crate::types::project::ProjectConfig;
use crate::types::image::{AnnotationData, MaskEncoding};

/// Current on-disk schema version. Bump this whenever the schema changes and
/// add a matching arm in `run_migrations`.
pub const SCHEMA_VERSION: i64 = 1;

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
            "This project was created with a newer version of LabelMed \
             (schema v{}, this build supports v{}). Please update the application.",
            version, SCHEMA_VERSION
        )));
    }

    if version == SCHEMA_VERSION {
        return Ok(());
    }

    // Apply migrations atomically so a partial/interrupted upgrade can't leave
    // the project in a half-migrated state.
    let tx = conn.unchecked_transaction().map_err(AppError::Database)?;
    let mut v = version;

    // v0 -> v1: baseline. `CREATE TABLE IF NOT EXISTS`, so this is also the
    // adoption path for legacy databases that predate versioning.
    if v < 1 {
        tx.execute_batch(super::schema::SCHEMA)
            .map_err(AppError::Database)?;
        v = 1;
    }

    // Future migrations go here, one block per version:
    //   if v < 2 { tx.execute_batch(MIGRATION_V2)?; v = 2; }

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
        let is_instance = label.shades.is_some();
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

// ============ Review ============

pub fn mark_image_opened(conn: &Connection, image_id: i64) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO review_status (image_id) VALUES (?1)",
        params![image_id],
    )?;
    Ok(())
}

pub fn mark_image_reviewed(conn: &Connection, image_id: i64, reviewed: bool) -> Result<()> {
    conn.execute(
        "UPDATE review_status SET reviewed = ?1 WHERE image_id = ?2",
        params![reviewed, image_id],
    )?;
    Ok(())
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
    fn refuses_database_from_newer_build() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION + 1))
            .unwrap();
        assert!(run_migrations(&conn).is_err());
    }
}
