//! User accounts: who is annotating the open project.
//!
//! A project is one file that several people open in turn, each annotating the
//! same frames independently. An account is how the app knows whose
//! annotations to show and write: logging in points the connection's
//! user-scoped views at that account (see `queries::install_user_scope`), and
//! from then on every command in the app works on that user's data.
//!
//! # What this is not
//!
//! Security. The file is an ordinary SQLite database on a disk the user
//! controls, and passwords are stored as typed. A password stops a colleague
//! from clicking the wrong account; a role stops an annotator from deleting a
//! label by accident. Neither stops anyone who opens the file with another
//! tool, and nothing here should be read as if it did.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use crate::storage::{queries, DbState};
use crate::utils::error::{AppError, Result};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub enum Role {
    /// Manages accounts and the project's definitions, and reads the
    /// inter-grader report.
    Admin,
    /// Annotates.
    Editor,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Editor => "editor",
        }
    }

    fn from_str(s: &str) -> Self {
        if s == "admin" {
            Role::Admin
        } else {
            Role::Editor
        }
    }
}

/// An account as the frontend sees it. The password never leaves the backend,
/// only whether there is one.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct UserInfo {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub role: Role,
    pub has_password: bool,
}

/// One change to an account.
#[derive(Deserialize, Debug, Clone, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub enum UserChange {
    Rename { name: String },
    /// `None` (or an empty string) removes the password.
    SetPassword { password: Option<String> },
    SetRole { role: Role },
}

/// What an account has annotated: what deleting it would erase.
#[derive(Serialize, Debug, Default, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct UserFootprint {
    /// Frames carrying a mask or a shape of theirs.
    pub annotated_frames: usize,
    pub classified_frames: usize,
    pub text_frames: usize,
    pub reviewed_frames: usize,
}

// ── Commands ───────────────────────────────────────────────────────────────

/// Every account. Callable before logging in: it is what the picker shows.
#[tauri::command]
pub fn list_users(db: State<DbState>) -> Result<Vec<UserInfo>> {
    db.with_conn(all_users)
}

/// The logged-in account, or `None` when the project is waiting for one.
#[tauri::command]
pub fn current_user(db: State<DbState>) -> Result<Option<UserInfo>> {
    db.with_conn(session_account)
}

#[tauri::command]
pub fn login(db: State<DbState>, user_id: i64, password: Option<String>) -> Result<UserInfo> {
    db.with_conn(|conn| log_in(conn, user_id, password.as_deref()))
}

#[tauri::command]
pub fn logout(db: State<DbState>) -> Result<()> {
    db.with_conn(|conn| queries::set_session_user(conn, None))
}

/// Create an editor account. Open to anyone who has the project: registering
/// is how a new annotator joins, and it grants nothing over anyone else's work.
#[tauri::command]
pub fn register_user(
    db: State<DbState>,
    name: String,
    password: Option<String>,
) -> Result<UserInfo> {
    db.with_conn(|conn| create_user(conn, &name, password.as_deref()))
}

#[tauri::command]
pub fn update_user(db: State<DbState>, user_id: i64, change: UserChange) -> Result<UserInfo> {
    db.with_conn(|conn| change_user(conn, user_id, &change))
}

#[tauri::command]
pub fn user_footprint(db: State<DbState>, user_id: i64) -> Result<UserFootprint> {
    db.with_conn(|conn| footprint(conn, user_id))
}

/// Delete an account and everything it annotated. Not undoable.
#[tauri::command]
pub fn delete_user(db: State<DbState>, user_id: i64) -> Result<()> {
    db.with_conn(|conn| remove_user(conn, user_id))
}

// ── Session ────────────────────────────────────────────────────────────────

fn read_user(row: &rusqlite::Row) -> rusqlite::Result<UserInfo> {
    Ok(UserInfo {
        id: row.get(0)?,
        name: row.get(1)?,
        role: Role::from_str(&row.get::<_, String>(2)?),
        has_password: row.get(3)?,
    })
}

const USER_COLUMNS: &str = "id, name, role, password IS NOT NULL AND password != ''";

pub fn all_users(conn: &Connection) -> Result<Vec<UserInfo>> {
    let mut stmt = conn.prepare(&format!("SELECT {USER_COLUMNS} FROM users ORDER BY id"))?;
    let rows = stmt.query_map([], read_user)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn find_user(conn: &Connection, user_id: i64) -> Result<UserInfo> {
    conn.query_row(
        &format!("SELECT {USER_COLUMNS} FROM users WHERE id = ?1"),
        params![user_id],
        read_user,
    )
    .optional()?
    .ok_or_else(|| AppError::Other("This account no longer exists.".into()))
}

pub fn session_account(conn: &Connection) -> Result<Option<UserInfo>> {
    match queries::session_user(conn)? {
        Some(id) => Ok(Some(find_user(conn, id)?)),
        None => Ok(None),
    }
}

/// The logged-in account, required to be an administrator.
pub fn require_admin(conn: &Connection) -> Result<UserInfo> {
    let user = session_account(conn)?
        .ok_or_else(|| AppError::Other("Nobody is logged in.".into()))?;
    if user.role != Role::Admin {
        return Err(AppError::Other("Only an administrator can do this.".into()));
    }
    Ok(user)
}

pub fn log_in(conn: &Connection, user_id: i64, password: Option<&str>) -> Result<UserInfo> {
    let user = find_user(conn, user_id)?;
    let stored: Option<String> =
        conn.query_row("SELECT password FROM users WHERE id = ?1", params![user_id], |r| r.get(0))?;
    if let Some(stored) = stored.filter(|p| !p.is_empty()) {
        if password != Some(stored.as_str()) {
            return Err(AppError::Other("Wrong password.".into()));
        }
    }
    queries::set_session_user(conn, Some(user_id))?;
    Ok(user)
}

/// Log straight in when there is no one to choose between: a single account
/// with no password. That is every project that predates accounts and every
/// project one person works on alone, and for those nothing should have
/// changed — no picker, no extra click.
pub fn auto_login(conn: &Connection) -> Result<Option<UserInfo>> {
    let users = all_users(conn)?;
    match users.as_slice() {
        [only] if !only.has_password => {
            queries::set_session_user(conn, Some(only.id))?;
            Ok(Some(only.clone()))
        }
        _ => Ok(None),
    }
}

// ── Accounts ───────────────────────────────────────────────────────────────

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Other("An account needs a name.".into()));
    }
    Ok(name.to_string())
}

/// `users.name` is `UNIQUE COLLATE NOCASE`: "Anna" and "anna" are one person.
fn ensure_name_free(conn: &Connection, name: &str, except: Option<i64>) -> Result<()> {
    let holder: Option<i64> = conn
        .query_row("SELECT id FROM users WHERE name = ?1", params![name], |row| row.get(0))
        .optional()?;
    match holder {
        Some(id) if Some(id) != except => {
            Err(AppError::Other(format!("There is already an account named “{name}”.")))
        }
        _ => Ok(()),
    }
}

/// An empty password is no password.
fn clean_password(password: Option<&str>) -> Option<&str> {
    password.filter(|p| !p.is_empty())
}

pub fn create_user(conn: &Connection, name: &str, password: Option<&str>) -> Result<UserInfo> {
    let name = clean_name(name)?;
    ensure_name_free(conn, &name, None)?;
    conn.execute(
        "INSERT INTO users (name, role, password) VALUES (?1, 'editor', ?2)",
        params![name, clean_password(password)],
    )?;
    find_user(conn, conn.last_insert_rowid())
}

fn admin_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM users WHERE role = 'admin'", [], |r| r.get(0))?)
}

/// Apply `change` to `user_id`, on behalf of the logged-in user.
///
/// Anyone may rename themselves and set their own password. Everything else —
/// touching another account, changing a role — takes an administrator.
pub fn change_user(conn: &Connection, user_id: i64, change: &UserChange) -> Result<UserInfo> {
    let actor = session_account(conn)?
        .ok_or_else(|| AppError::Other("Nobody is logged in.".into()))?;
    let target = find_user(conn, user_id)?;
    let own = actor.id == target.id;
    let is_admin = actor.role == Role::Admin;

    match change {
        UserChange::Rename { name } => {
            if !own && !is_admin {
                return Err(AppError::Other("Only an administrator can rename someone else.".into()));
            }
            let name = clean_name(name)?;
            ensure_name_free(conn, &name, Some(user_id))?;
            conn.execute("UPDATE users SET name = ?1 WHERE id = ?2", params![name, user_id])?;
        }
        UserChange::SetPassword { password } => {
            if !own && !is_admin {
                return Err(AppError::Other(
                    "Only an administrator can change someone else's password.".into(),
                ));
            }
            conn.execute(
                "UPDATE users SET password = ?1 WHERE id = ?2",
                params![clean_password(password.as_deref()), user_id],
            )?;
        }
        UserChange::SetRole { role } => {
            if !is_admin {
                return Err(AppError::Other("Only an administrator can change roles.".into()));
            }
            // A project with no administrator could never get one back: nobody
            // would be left who is allowed to grant the role.
            if target.role == Role::Admin && *role != Role::Admin && admin_count(conn)? <= 1 {
                return Err(AppError::Other(
                    "A project needs at least one administrator.".into(),
                ));
            }
            conn.execute(
                "UPDATE users SET role = ?1 WHERE id = ?2",
                params![role.as_str(), user_id],
            )?;
        }
    }
    find_user(conn, user_id)
}

pub fn footprint(conn: &Connection, user_id: i64) -> Result<UserFootprint> {
    let count = |sql: &str| -> Result<usize> {
        let n: i64 = conn.query_row(sql, params![user_id], |row| row.get(0))?;
        Ok(n as usize)
    };
    Ok(UserFootprint {
        annotated_frames: count(
            "SELECT COUNT(*) FROM (
                 SELECT frame_id FROM main.annotations WHERE user_id = ?1
                 UNION
                 SELECT frame_id FROM main.vector_annotations WHERE user_id = ?1)",
        )?,
        classified_frames: count(
            "SELECT COUNT(DISTINCT frame_id) FROM main.classifications WHERE user_id = ?1",
        )?,
        text_frames: count(
            "SELECT COUNT(DISTINCT frame_id) FROM main.text_descriptions WHERE user_id = ?1",
        )?,
        reviewed_frames: count("SELECT COUNT(*) FROM main.frame_reviews WHERE user_id = ?1")?,
    })
}

pub fn remove_user(conn: &Connection, user_id: i64) -> Result<()> {
    let actor = require_admin(conn)?;
    let target = find_user(conn, user_id)?;
    // Deleting the account you are logged in with would leave the session
    // pointing at nothing, mid-click. Log in as someone else to do it.
    if actor.id == target.id {
        return Err(AppError::Other("You cannot delete the account you are using.".into()));
    }
    if target.role == Role::Admin && admin_count(conn)? <= 1 {
        return Err(AppError::Other("A project needs at least one administrator.".into()));
    }
    // Every per-user table references `users` with ON DELETE CASCADE.
    conn.execute("DELETE FROM users WHERE id = ?1", params![user_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// An open project as the app holds it: migrated, scoped, nobody logged in.
    fn project() -> Connection {
        let conn = queries::create_database(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO labels (id, name, color) VALUES (1, 'cell', '#ff0000');
             INSERT INTO sequences (id, name) VALUES (1, 's');
             INSERT INTO frames (id, sequence_id, frame_index, width, height)
               VALUES (1, 1, 0, 2, 2), (2, 1, 1, 2, 2);",
        )
        .unwrap();
        queries::install_user_scope(&conn).unwrap();
        conn
    }

    fn mask_of(conn: &Connection, frame: i64) -> Option<Vec<u8>> {
        conn.query_row(
            "SELECT mask_data FROM annotations WHERE frame_id = ?1 AND label_id = 1",
            params![frame],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    fn save(conn: &Connection, frame: i64, data: &[u8]) -> Result<()> {
        queries::save_annotation(conn, frame, 1, data, crate::types::image::MaskEncoding::Rle8)
    }

    #[test]
    fn a_new_project_has_one_admin_and_logs_it_in_without_asking() {
        let conn = project();
        assert_eq!(session_account(&conn).unwrap(), None, "nobody until someone logs in");

        let user = auto_login(&conn).unwrap().expect("a lone passwordless account logs in");
        assert_eq!((user.id, user.role, user.has_password), (1, Role::Admin, false));
        assert_eq!(session_account(&conn).unwrap(), Some(user));
    }

    #[test]
    fn a_second_account_or_a_password_means_someone_has_to_choose() {
        let conn = project();
        create_user(&conn, "Anna", None).unwrap();
        assert_eq!(auto_login(&conn).unwrap(), None);

        let conn = project();
        log_in(&conn, 1, None).unwrap();
        change_user(&conn, 1, &UserChange::SetPassword { password: Some("s3cret".into()) }).unwrap();
        queries::set_session_user(&conn, None).unwrap();
        assert_eq!(auto_login(&conn).unwrap(), None);
    }

    #[test]
    fn a_password_is_checked_and_an_empty_one_is_none() {
        let conn = project();
        let anna = create_user(&conn, "Anna", Some("pw")).unwrap();
        assert!(anna.has_password);
        assert!(log_in(&conn, anna.id, None).is_err());
        assert!(log_in(&conn, anna.id, Some("nope")).is_err());
        assert_eq!(session_account(&conn).unwrap(), None, "a failed login logs nobody in");
        assert!(log_in(&conn, anna.id, Some("pw")).is_ok());

        let ben = create_user(&conn, "Ben", Some("")).unwrap();
        assert!(!ben.has_password);
        assert!(log_in(&conn, ben.id, None).is_ok());
    }

    /// The point of the whole feature.
    #[test]
    fn each_user_sees_and_writes_only_their_own_annotations() {
        let conn = project();
        let anna = create_user(&conn, "Anna", None).unwrap();

        log_in(&conn, 1, None).unwrap();
        save(&conn, 1, &[1]).unwrap();
        crate::commands::frame::mark_reviewed(&conn, &[1], true).unwrap();

        log_in(&conn, anna.id, None).unwrap();
        assert_eq!(mask_of(&conn, 1), None, "Anna has not annotated frame 1");
        let reviewed: i64 =
            conn.query_row("SELECT COUNT(*) FROM frame_reviews", [], |r| r.get(0)).unwrap();
        assert_eq!(reviewed, 0, "nor reviewed it");

        save(&conn, 1, &[2]).unwrap();
        assert_eq!(mask_of(&conn, 1), Some(vec![2]));

        log_in(&conn, 1, None).unwrap();
        assert_eq!(mask_of(&conn, 1), Some(vec![1]), "and did not overwrite the admin's");

        let everyone: i64 =
            conn.query_row("SELECT COUNT(*) FROM main.annotations", [], |r| r.get(0)).unwrap();
        assert_eq!(everyone, 2);
    }

    #[test]
    fn clearing_a_sequence_clears_only_the_current_users_work() {
        let conn = project();
        let anna = create_user(&conn, "Anna", None).unwrap();
        log_in(&conn, 1, None).unwrap();
        save(&conn, 1, &[1]).unwrap();
        log_in(&conn, anna.id, None).unwrap();
        save(&conn, 1, &[2]).unwrap();

        assert_eq!(queries::clear_sequence_annotations(&conn, 1).unwrap(), 1);
        assert_eq!(mask_of(&conn, 1), None);
        log_in(&conn, 1, None).unwrap();
        assert_eq!(mask_of(&conn, 1), Some(vec![1]));
    }

    #[test]
    fn nothing_can_be_written_while_nobody_is_logged_in() {
        let conn = project();
        assert!(save(&conn, 1, &[1]).is_err());
        assert!(crate::commands::frame::mark_reviewed(&conn, &[1], true).is_err());
        // And a writer that forgot to name the user is stopped by the view.
        assert!(conn
            .execute(
                "INSERT INTO annotations (frame_id, label_id, mask_data) VALUES (1, 1, x'00')",
                [],
            )
            .is_err());
    }

    #[test]
    fn names_are_unique_whatever_the_case() {
        let conn = project();
        create_user(&conn, " Anna ", None).unwrap();
        assert!(create_user(&conn, "anna", None).is_err());
        assert!(create_user(&conn, "  ", None).is_err());
    }

    #[test]
    fn editors_manage_themselves_and_nobody_else() {
        let conn = project();
        let anna = create_user(&conn, "Anna", None).unwrap();
        let ben = create_user(&conn, "Ben", None).unwrap();

        log_in(&conn, anna.id, None).unwrap();
        assert!(change_user(&conn, anna.id, &UserChange::Rename { name: "Anna K".into() }).is_ok());
        assert!(change_user(&conn, anna.id, &UserChange::SetPassword { password: Some("x".into()) }).is_ok());
        assert!(change_user(&conn, ben.id, &UserChange::Rename { name: "B".into() }).is_err());
        assert!(change_user(&conn, ben.id, &UserChange::SetPassword { password: None }).is_err());
        assert!(change_user(&conn, anna.id, &UserChange::SetRole { role: Role::Admin }).is_err());
        assert!(remove_user(&conn, ben.id).is_err());
        assert!(require_admin(&conn).is_err());
    }

    #[test]
    fn the_last_administrator_cannot_be_demoted_or_deleted() {
        let conn = project();
        let anna = create_user(&conn, "Anna", None).unwrap();
        log_in(&conn, 1, None).unwrap();
        assert!(change_user(&conn, 1, &UserChange::SetRole { role: Role::Editor }).is_err());

        change_user(&conn, anna.id, &UserChange::SetRole { role: Role::Admin }).unwrap();
        assert!(change_user(&conn, 1, &UserChange::SetRole { role: Role::Editor }).is_ok());

        // Now an editor, account 1 can no longer delete anyone; Anna can, but
        // not herself.
        log_in(&conn, anna.id, None).unwrap();
        assert!(remove_user(&conn, anna.id).is_err());
        assert!(remove_user(&conn, 1).is_ok());
    }

    #[test]
    fn deleting_an_account_erases_what_it_annotated_and_nothing_else() {
        let conn = project();
        let anna = create_user(&conn, "Anna", None).unwrap();
        log_in(&conn, anna.id, None).unwrap();
        save(&conn, 1, &[2]).unwrap();
        crate::commands::frame::mark_reviewed(&conn, &[1, 2], true).unwrap();

        log_in(&conn, 1, None).unwrap();
        save(&conn, 1, &[1]).unwrap();
        assert_eq!(
            footprint(&conn, anna.id).unwrap(),
            UserFootprint { annotated_frames: 1, reviewed_frames: 2, ..Default::default() }
        );

        remove_user(&conn, anna.id).unwrap();
        let left: Vec<i64> = {
            let mut stmt = conn.prepare("SELECT user_id FROM main.annotations").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(left, [1]);
        let reviews: i64 =
            conn.query_row("SELECT COUNT(*) FROM main.frame_reviews", [], |r| r.get(0)).unwrap();
        assert_eq!(reviews, 0);
    }
}
