//! Regression values: the numbers a frame is given, one per task of the
//! project's `regression_tasks` and per user. See the `regressions` table.

use ts_rs::TS;
use rusqlite::{params, Connection};
use tauri::State;
use serde::{Deserialize, Serialize};

use crate::storage::{queries, DbState};
use crate::utils::AppError;
use crate::utils::error::Result;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct RegressionData {
    pub task_name: String,
    pub value: f64,
}

/// The current user's values for a frame. A task without a value is absent.
#[tauri::command]
pub fn load_regressions(db: State<DbState>, frame_id: i64) -> Result<Vec<RegressionData>> {
    db.with_conn(|conn| regressions_of(conn, frame_id))
}

/// Give a frame its value for a task, or remove it with `None`. Returns the
/// value as stored: rounded to the task's type.
#[tauri::command]
pub fn save_regression(
    db: State<DbState>,
    frame_id: i64,
    task_name: String,
    value: Option<f64>,
) -> Result<Option<f64>> {
    db.with_conn(|conn| store_regression(conn, frame_id, &task_name, value))
}

fn regressions_of(conn: &Connection, frame_id: i64) -> Result<Vec<RegressionData>> {
    let mut stmt = conn.prepare(
        "SELECT task_name, value FROM regressions WHERE frame_id = ?1 ORDER BY task_name",
    )?;
    let rows = stmt
        .query_map(params![frame_id], |row| {
            Ok(RegressionData { task_name: row.get(0)?, value: row.get(1)? })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn store_regression(
    conn: &Connection,
    frame_id: i64,
    task_name: &str,
    value: Option<f64>,
) -> Result<Option<f64>> {
    let user = queries::current_user_id(conn)?;
    let Some(value) = value else {
        conn.execute(
            "DELETE FROM main.regressions
             WHERE frame_id = ?1 AND task_name = ?2 AND user_id = ?3",
            params![frame_id, task_name, user],
        )?;
        return Ok(None);
    };

    let config = queries::get_project_config(conn)?;
    let task = config
        .regression_tasks
        .iter()
        .flatten()
        .find(|task| task.name == task_name)
        .ok_or_else(|| {
            AppError::Other(format!("This project has no regression value named \"{task_name}\"."))
        })?;
    let value = task.conform(value).map_err(AppError::Other)?;

    conn.execute(
        "INSERT INTO main.regressions (frame_id, user_id, task_name, value, modified_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))
         ON CONFLICT(frame_id, task_name, user_id)
         DO UPDATE SET value = excluded.value, modified_at = excluded.modified_at",
        params![frame_id, user, task_name, value],
    )?;
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::project::{ProjectConfig, RegressionConfig, RegressionType};

    /// One sequence of two frames; `age` is an int32 from 0, `score` a float32
    /// in [0, 1].
    fn fixture() -> Connection {
        let conn = queries::create_database(std::path::Path::new(":memory:")).unwrap();
        let config = ProjectConfig {
            name: "p".into(),
            regression_enabled: true,
            regression_tasks: Some(vec![
                RegressionConfig {
                    name: "age".into(),
                    dtype: RegressionType::Int32,
                    min: Some(0.0),
                    max: None,
                },
                RegressionConfig {
                    name: "score".into(),
                    dtype: RegressionType::Float32,
                    min: Some(0.0),
                    max: Some(1.0),
                },
            ]),
            ..Default::default()
        };
        queries::insert_project(&conn, &config).unwrap();
        queries::install_user_scope(&conn).unwrap();
        crate::commands::users::auto_login(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sequences (id, name) VALUES (1, 'a');
             INSERT INTO frames (id, sequence_id, frame_index, width, height)
               VALUES (1, 1, 0, 2, 2), (2, 1, 1, 2, 2);",
        )
        .unwrap();
        conn
    }

    fn value(conn: &Connection, frame_id: i64, task: &str) -> Option<f64> {
        regressions_of(conn, frame_id)
            .unwrap()
            .into_iter()
            .find(|r| r.task_name == task)
            .map(|r| r.value)
    }

    #[test]
    fn a_frame_holds_one_value_per_task_and_a_new_one_replaces_it() {
        let conn = fixture();
        store_regression(&conn, 1, "age", Some(41.0)).unwrap();
        store_regression(&conn, 1, "score", Some(0.5)).unwrap();
        store_regression(&conn, 1, "age", Some(42.0)).unwrap();

        assert_eq!(regressions_of(&conn, 1).unwrap().len(), 2);
        assert_eq!(value(&conn, 1, "age"), Some(42.0));
        assert_eq!(value(&conn, 1, "score"), Some(0.5));
        assert!(regressions_of(&conn, 2).unwrap().is_empty(), "the other frame is untouched");
    }

    #[test]
    fn a_value_is_stored_in_the_type_of_its_task() {
        let conn = fixture();
        assert_eq!(store_regression(&conn, 1, "age", Some(41.6)).unwrap(), Some(42.0));
        assert_eq!(value(&conn, 1, "age"), Some(42.0));

        let stored = store_regression(&conn, 1, "score", Some(0.1)).unwrap();
        assert_eq!(stored, Some(0.1f32 as f64));
        assert_eq!(value(&conn, 1, "score"), stored, "what is read is what was stored");
    }

    #[test]
    fn a_value_out_of_range_or_of_an_unknown_task_is_refused() {
        let conn = fixture();
        assert!(store_regression(&conn, 1, "age", Some(-1.0)).is_err());
        assert!(store_regression(&conn, 1, "score", Some(1.5)).is_err());
        assert!(store_regression(&conn, 1, "height", Some(1.0)).is_err());
        assert!(regressions_of(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn no_value_removes_the_answer() {
        let conn = fixture();
        store_regression(&conn, 1, "age", Some(41.0)).unwrap();
        assert_eq!(store_regression(&conn, 1, "age", None).unwrap(), None);
        assert_eq!(value(&conn, 1, "age"), None);
    }

    #[test]
    fn each_user_has_their_own_values() {
        let conn = fixture();
        store_regression(&conn, 1, "age", Some(41.0)).unwrap();

        conn.execute("INSERT INTO users (id, name) VALUES (2, 'second')", []).unwrap();
        queries::set_session_user(&conn, Some(2)).unwrap();
        assert_eq!(value(&conn, 1, "age"), None, "the first user's value is not shown");
        store_regression(&conn, 1, "age", Some(50.0)).unwrap();
        assert_eq!(value(&conn, 1, "age"), Some(50.0));

        queries::set_session_user(&conn, Some(1)).unwrap();
        assert_eq!(value(&conn, 1, "age"), Some(41.0));
    }
}
