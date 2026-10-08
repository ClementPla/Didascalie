//! Editing the configuration of the open project.
//!
//! # One edit, one transaction
//!
//! A project's definitions live in two places that must agree: the JSON
//! `project.config`, and the rows that refer to it by name or id (`labels`,
//! `classifications.task_name`, the class names inside
//! `classifications.selected_classes`, `text_descriptions.label_name`). Editing
//! the config alone is how a rename turns into data loss: the next open syncs
//! the `labels` table from the config *by name*, sees a label it does not know,
//! and the annotations stay attached to a label nobody can reach.
//!
//! So every change is a [`ProjectEdit`], applied by [`apply_edit`] to the config
//! and to the rows that depend on it inside a single transaction. There is no
//! command that writes a whole `ProjectConfig` back, on purpose.
//!
//! # Every user at once
//!
//! Definitions are shared by all the project's users, so an edit reaches every
//! user's annotations: a renamed class is renamed in everyone's answers, a
//! deleted label takes everyone's masks, and the impact counts say so. That is
//! why every statement here names `main.<table>` — the unqualified name is the
//! logged-in user's view of it (see `queries::install_user_scope`).
//!
//! # Destructive edits
//!
//! Deleting a label, a task, a class or a text field deletes what was annotated
//! with it, on every frame, and cannot be undone. [`edit_impact`] reports what
//! an edit would destroy so the frontend can say so before it happens. Nothing
//! here asks for confirmation: that is the caller's job.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use crate::commands::ml::predict::MlState;
use crate::storage::{queries, DbState};
use crate::types::project::{LabelConfig, MulticlassConfig, MultilabelConfig, ProjectConfig};
use crate::utils::error::{AppError, Result};

// ==========================================
// Types
// ==========================================

/// A task family that can be switched on or off without touching its data.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub enum TaskKind {
    Classification,
    Segmentation,
    TextDescription,
}

/// One change to the project's configuration.
///
/// Labels are addressed by id, which never changes. Tasks, classes and text
/// fields have no id — their name is their identity in the stored annotations —
/// so they are addressed by their current name.
#[derive(Deserialize, Debug, Clone, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub enum ProjectEdit {
    RenameProject {
        name: String,
    },

    AddLabel {
        name: String,
        color: String,
    },
    RenameLabel {
        #[ts(type = "number")]
        id: i64,
        name: String,
    },
    RecolorLabel {
        #[ts(type = "number")]
        id: i64,
        color: String,
    },
    DeleteLabel {
        #[ts(type = "number")]
        id: i64,
    },
    /// Every label id, once, in the new order.
    ReorderLabels {
        #[ts(type = "Array<number>")]
        ids: Vec<i64>,
    },

    /// Show or hide a task family. Hides the tools, keeps the annotations.
    SetTaskEnabled {
        task: TaskKind,
        enabled: bool,
    },

    AddMulticlassTask {
        name: String,
    },
    AddMultilabelTask {
        name: String,
    },
    /// Multiclass or multilabel: task names are unique across both.
    RenameTask {
        name: String,
        #[serde(rename = "newName")]
        new_name: String,
    },
    DeleteTask {
        name: String,
    },
    AddClass {
        task: String,
        name: String,
    },
    RenameClass {
        task: String,
        name: String,
        #[serde(rename = "newName")]
        new_name: String,
    },
    DeleteClass {
        task: String,
        name: String,
    },

    AddTextField {
        name: String,
    },
    RenameTextField {
        name: String,
        #[serde(rename = "newName")]
        new_name: String,
    },
    DeleteTextField {
        name: String,
    },
}

/// What an edit would permanently delete. All zero for a harmless edit.
#[derive(Serialize, Debug, Default, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct EditImpact {
    /// Frames carrying a non-empty mask of the label.
    pub mask_frames: usize,
    /// Frames carrying at least one vector shape of the label.
    pub shape_frames: usize,
    /// Frames whose classification would be removed or changed.
    pub classification_frames: usize,
    /// Frames whose text would be removed.
    pub text_frames: usize,
    /// The trained segmentation model predicts this label and would be dropped.
    pub discards_model: bool,
}

// ==========================================
// Commands
// ==========================================

/// What `edit` would destroy if applied now. Reads only.
#[tauri::command]
pub fn project_edit_impact(db: State<DbState>, edit: ProjectEdit) -> Result<EditImpact> {
    db.with_conn(|conn| edit_impact(conn, &edit))
}

/// Apply `edit` and return the configuration as it now stands.
#[tauri::command]
pub fn apply_project_edit(
    db: State<DbState>,
    ml: State<MlState>,
    edit: ProjectEdit,
) -> Result<ProjectConfig> {
    log::info!("[project] edit: {:?}", edit);
    let config = db.with_conn(|conn| {
        // Definitions are shared by every user, and an edit can erase all of
        // their work with it.
        crate::commands::users::require_admin(conn)?;
        apply_edit(conn, &edit)
    })?;

    // The stored model went with the label inside the transaction; the copy
    // already loaded for predicting has to go too, or it keeps returning masks
    // for a label id that no longer exists.
    if let ProjectEdit::DeleteLabel { id } = &edit {
        let mut model = ml.model.lock();
        if model.as_ref().is_some_and(|m| m.label_order.contains(id)) {
            *model = None;
        }
    }
    Ok(config)
}

// ==========================================
// Impact
// ==========================================

pub fn edit_impact(conn: &Connection, edit: &ProjectEdit) -> Result<EditImpact> {
    let mut impact = EditImpact::default();
    match edit {
        ProjectEdit::DeleteLabel { id } => {
            impact.mask_frames = frames_with_mask(conn, *id)?;
            impact.shape_frames = count(
                conn,
                "SELECT COUNT(*) FROM main.vector_annotations
                 WHERE label_id = ?1 AND json_array_length(shapes) > 0",
                params![id],
            )?;
            impact.discards_model = saved_model_uses_label(conn, *id)?;
        }
        ProjectEdit::DeleteTask { name } => {
            impact.classification_frames = count(
                conn,
                "SELECT COUNT(*) FROM main.classifications WHERE task_name = ?1",
                params![name],
            )?;
        }
        ProjectEdit::DeleteClass { task, name } => {
            impact.classification_frames = count(
                conn,
                "SELECT COUNT(*) FROM main.classifications c
                 WHERE c.task_name = ?1
                   AND EXISTS (SELECT 1 FROM json_each(c.selected_classes) WHERE value = ?2)",
                params![task, name],
            )?;
        }
        ProjectEdit::DeleteTextField { name } => {
            impact.text_frames = count(
                conn,
                "SELECT COUNT(*) FROM main.text_descriptions WHERE label_name = ?1",
                params![name],
            )?;
        }
        _ => {}
    }
    Ok(impact)
}

fn count(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<usize> {
    let n: i64 = conn.query_row(sql, params, |row| row.get(0))?;
    Ok(n as usize)
}

/// Frames whose mask of `label_id` has at least one pixel set.
///
/// Not a plain row count: erasing everything a label had on a frame still
/// leaves its row behind, holding an all-zero mask. Counting those would make
/// the warning cry wolf on labels that were tried once and wiped.
fn frames_with_mask(conn: &Connection, label_id: i64) -> Result<usize> {
    let mut stmt =
        conn.prepare("SELECT encoding, mask_data FROM main.annotations WHERE label_id = ?1")?;
    let rows = stmt.query_map(params![label_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    let mut frames = 0;
    for row in rows {
        let (encoding, data) = row?;
        // `rle8` is a list of (value, u32 run length) records, so emptiness can
        // be read without decoding. Legacy encodings are assumed to hold
        // something: overstating a deletion is the safe direction.
        let empty = encoding == "rle8" && data.chunks_exact(5).all(|record| record[0] == 0);
        if !empty {
            frames += 1;
        }
    }
    Ok(frames)
}

/// Whether the model stored in the project was trained to predict `label_id`.
fn saved_model_uses_label(conn: &Connection, label_id: i64) -> Result<bool> {
    let Some((meta, _)) = queries::load_ml_model(conn)? else {
        return Ok(false);
    };
    // Read as loose JSON: this module has no business knowing the head's
    // metadata beyond the one list it needs. A model this build cannot read is
    // treated as using the label, so it is dropped rather than left dangling.
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta) else {
        return Ok(true);
    };
    Ok(meta
        .get("label_order")
        .and_then(|v| v.as_array())
        .is_some_and(|ids| ids.iter().any(|v| v.as_i64() == Some(label_id))))
}

// ==========================================
// Applying
// ==========================================

/// Apply `edit` to the config and to every row that depends on it, atomically.
pub fn apply_edit(conn: &Connection, edit: &ProjectEdit) -> Result<ProjectConfig> {
    let tx = conn.unchecked_transaction()?;
    let mut config = queries::get_project_config(&tx)?;

    match edit {
        ProjectEdit::RenameProject { name } => {
            config.name = clean_name(name, "project")?;
        }

        ProjectEdit::AddLabel { name, color } => {
            let name = clean_name(name, "label")?;
            let color = clean_color(color)?;
            ensure_label_name_free(&tx, &name, None)?;
            tx.execute(
                "INSERT INTO labels (name, color, is_instance, sort_order)
                 VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM labels))",
                params![name, color, config.instance_segmentation_enabled],
            )?;
            write_labels_to_config(&tx, &mut config, None)?;
        }
        ProjectEdit::RenameLabel { id, name } => {
            let name = clean_name(name, "label")?;
            let old = label_name(&tx, *id)?;
            if old != name {
                ensure_label_name_free(&tx, &name, Some(*id))?;
                tx.execute("UPDATE labels SET name = ?1 WHERE id = ?2", params![name, id])?;
                write_labels_to_config(&tx, &mut config, Some((&old, &name)))?;
            }
        }
        ProjectEdit::RecolorLabel { id, color } => {
            let color = clean_color(color)?;
            label_name(&tx, *id)?; // must exist
            // Colour is applied at composite time from this column and is not in
            // the mask pixels, so this one row recolours every frame.
            tx.execute("UPDATE labels SET color = ?1 WHERE id = ?2", params![color, id])?;
            write_labels_to_config(&tx, &mut config, None)?;
        }
        ProjectEdit::DeleteLabel { id } => {
            label_name(&tx, *id)?; // must exist
            if saved_model_uses_label(&tx, *id)? {
                queries::delete_ml_model(&tx)?;
            }
            // `annotations` and `vector_annotations` cascade.
            tx.execute("DELETE FROM labels WHERE id = ?1", params![id])?;
            write_labels_to_config(&tx, &mut config, None)?;
        }

        ProjectEdit::ReorderLabels { ids } => {
            // Position is meaning here: it is the class number in exports and in
            // a model being trained. A list that drops or repeats a label would
            // leave two labels sharing a position, so it is refused whole.
            let mut current: Vec<i64> = {
                let mut stmt = tx.prepare("SELECT id FROM labels")?;
                let rows = stmt.query_map([], |row| row.get(0))?;
                rows.collect::<std::result::Result<_, _>>()?
            };
            let mut wanted = ids.clone();
            current.sort_unstable();
            wanted.sort_unstable();
            if current != wanted {
                return Err(AppError::Other(
                    "The label list changed in the meantime; nothing was reordered.".into(),
                ));
            }
            for (position, id) in ids.iter().enumerate() {
                tx.execute(
                    "UPDATE labels SET sort_order = ?1 WHERE id = ?2",
                    params![position as i64, id],
                )?;
            }
            write_labels_to_config(&tx, &mut config, None)?;
        }

        ProjectEdit::SetTaskEnabled { task, enabled } => match task {
            TaskKind::Classification => config.classification_enabled = *enabled,
            TaskKind::Segmentation => config.segmentation_enabled = *enabled,
            TaskKind::TextDescription => config.text_description_enabled = *enabled,
        },

        ProjectEdit::AddMulticlassTask { name } => {
            let name = clean_name(name, "task")?;
            ensure_task_name_free(&config, &name)?;
            forget_orphan_classifications(&tx, &name)?;
            config
                .classification_tasks
                .get_or_insert_with(Vec::new)
                .push(MulticlassConfig { name, classes: Vec::new(), default: None });
        }
        ProjectEdit::AddMultilabelTask { name } => {
            let name = clean_name(name, "task")?;
            if config.multilabel_task.is_some() {
                return Err(AppError::Other("This project already has a multilabel task.".into()));
            }
            ensure_task_name_free(&config, &name)?;
            forget_orphan_classifications(&tx, &name)?;
            config.multilabel_task =
                Some(MultilabelConfig { name, classes: Vec::new(), default: None });
        }
        ProjectEdit::RenameTask { name, new_name } => {
            let new_name = clean_name(new_name, "task")?;
            if *name != new_name {
                ensure_task_name_free(&config, &new_name)?;
                *task_name_mut(&mut config, name)? = new_name.clone();
                forget_orphan_classifications(&tx, &new_name)?;
                tx.execute(
                    "UPDATE main.classifications SET task_name = ?1 WHERE task_name = ?2",
                    params![new_name, name],
                )?;
            }
        }
        ProjectEdit::DeleteTask { name } => {
            task_name_mut(&mut config, name)?; // must exist
            if config.multilabel_task.as_ref().is_some_and(|t| t.name == *name) {
                config.multilabel_task = None;
            } else if let Some(tasks) = config.classification_tasks.as_mut() {
                tasks.retain(|t| t.name != *name);
            }
            tx.execute("DELETE FROM main.classifications WHERE task_name = ?1", params![name])?;
        }

        ProjectEdit::AddClass { task, name } => {
            let name = clean_name(name, "class")?;
            let classes = task_classes_mut(&mut config, task)?;
            ensure_class_name_free(classes, &name)?;
            classes.push(name);
        }
        ProjectEdit::RenameClass { task, name, new_name } => {
            let new_name = clean_name(new_name, "class")?;
            if *name != new_name {
                let classes = task_classes_mut(&mut config, task)?;
                ensure_class_name_free(classes, &new_name)?;
                let slot = classes
                    .iter_mut()
                    .find(|c| *c == name)
                    .ok_or_else(|| missing("class", name))?;
                *slot = new_name.clone();
                rewrite_task_defaults(&mut config, task, name, Some(&new_name));
                rewrite_selected_classes(&tx, task, name, Some(&new_name))?;
            }
        }
        ProjectEdit::DeleteClass { task, name } => {
            let classes = task_classes_mut(&mut config, task)?;
            if !classes.contains(name) {
                return Err(missing("class", name));
            }
            classes.retain(|c| c != name);
            rewrite_task_defaults(&mut config, task, name, None);
            rewrite_selected_classes(&tx, task, name, None)?;
        }

        ProjectEdit::AddTextField { name } => {
            let name = clean_name(name, "text field")?;
            let fields = config.text_fields.get_or_insert_with(Vec::new);
            ensure_text_field_free(fields, &name)?;
            fields.push(name.clone());
            forget_orphan_texts(&tx, &name)?;
        }
        ProjectEdit::RenameTextField { name, new_name } => {
            let new_name = clean_name(new_name, "text field")?;
            if *name != new_name {
                let fields = config.text_fields.get_or_insert_with(Vec::new);
                ensure_text_field_free(fields, &new_name)?;
                let slot = fields
                    .iter_mut()
                    .find(|f| *f == name)
                    .ok_or_else(|| missing("text field", name))?;
                *slot = new_name.clone();
                forget_orphan_texts(&tx, &new_name)?;
                tx.execute(
                    "UPDATE main.text_descriptions SET label_name = ?1 WHERE label_name = ?2",
                    params![new_name, name],
                )?;
            }
        }
        ProjectEdit::DeleteTextField { name } => {
            let fields = config.text_fields.get_or_insert_with(Vec::new);
            if !fields.contains(name) {
                return Err(missing("text field", name));
            }
            fields.retain(|f| f != name);
            tx.execute("DELETE FROM main.text_descriptions WHERE label_name = ?1", params![name])?;
        }
    }

    tx.execute(
        "UPDATE project SET config = ?1 WHERE id = 1",
        params![serde_json::to_string(&config)?],
    )?;
    tx.commit()?;
    Ok(config)
}

// ==========================================
// Validation
// ==========================================

fn missing(what: &str, name: &str) -> AppError {
    AppError::Other(format!("This project has no {what} named “{name}”."))
}

fn taken(what: &str, name: &str) -> AppError {
    AppError::Other(format!("There is already a {what} named “{name}”."))
}

/// Trimmed, and refused when nothing is left.
fn clean_name(name: &str, what: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Other(format!("A {what} needs a name.")));
    }
    Ok(name.to_string())
}

/// `#rrggbb`, lower-cased. The compositor and the exporters parse exactly this.
fn clean_color(color: &str) -> Result<String> {
    let color = color.trim();
    let hex = color.strip_prefix('#').unwrap_or("");
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::Other(format!("“{color}” is not a #rrggbb colour.")));
    }
    Ok(color.to_ascii_lowercase())
}

fn label_name(conn: &Connection, id: i64) -> Result<String> {
    conn.query_row("SELECT name FROM labels WHERE id = ?1", params![id], |row| row.get(0))
        .optional()?
        .ok_or_else(|| AppError::Other("This label no longer exists.".into()))
}

fn ensure_label_name_free(conn: &Connection, name: &str, except: Option<i64>) -> Result<()> {
    let holder: Option<i64> = conn
        .query_row("SELECT id FROM labels WHERE name = ?1", params![name], |row| row.get(0))
        .optional()?;
    match holder {
        Some(id) if Some(id) != except => Err(taken("label", name)),
        _ => Ok(()),
    }
}

/// Task names key the `classifications` rows, multiclass and multilabel alike,
/// so one name cannot serve two tasks.
fn ensure_task_name_free(config: &ProjectConfig, name: &str) -> Result<()> {
    let multiclass = config.classification_tasks.iter().flatten().any(|t| t.name == name);
    let multilabel = config.multilabel_task.as_ref().is_some_and(|t| t.name == name);
    if multiclass || multilabel {
        return Err(taken("task", name));
    }
    Ok(())
}

fn ensure_class_name_free(classes: &[String], name: &str) -> Result<()> {
    if classes.iter().any(|c| c == name) {
        return Err(taken("class", name));
    }
    Ok(())
}

fn ensure_text_field_free(fields: &[String], name: &str) -> Result<()> {
    if fields.iter().any(|f| f == name) {
        return Err(taken("text field", name));
    }
    Ok(())
}

// ==========================================
// Config helpers
// ==========================================

fn task_name_mut<'a>(config: &'a mut ProjectConfig, name: &str) -> Result<&'a mut String> {
    if let Some(task) = config.multilabel_task.as_mut().filter(|t| t.name == name) {
        return Ok(&mut task.name);
    }
    config
        .classification_tasks
        .iter_mut()
        .flatten()
        .find(|t| t.name == name)
        .map(|t| &mut t.name)
        .ok_or_else(|| missing("task", name))
}

fn task_classes_mut<'a>(config: &'a mut ProjectConfig, task: &str) -> Result<&'a mut Vec<String>> {
    if let Some(t) = config.multilabel_task.as_mut().filter(|t| t.name == task) {
        return Ok(&mut t.classes);
    }
    config
        .classification_tasks
        .iter_mut()
        .flatten()
        .find(|t| t.name == task)
        .map(|t| &mut t.classes)
        .ok_or_else(|| missing("task", task))
}

/// Follow a class rename (`to = Some`) or removal (`to = None`) in the task's
/// default selection, so a default never names a class the task lacks.
fn rewrite_task_defaults(config: &mut ProjectConfig, task: &str, from: &str, to: Option<&str>) {
    if let Some(t) = config.multilabel_task.as_mut().filter(|t| t.name == task) {
        if let Some(default) = t.default.as_mut() {
            replace_class(default, from, to);
        }
    }
    for t in config.classification_tasks.iter_mut().flatten().filter(|t| t.name == task) {
        if t.default.as_deref() == Some(from) {
            t.default = to.map(str::to_string);
        }
    }
}

fn replace_class(classes: &mut Vec<String>, from: &str, to: Option<&str>) {
    match to {
        Some(to) => classes.iter_mut().filter(|c| *c == from).for_each(|c| *c = to.to_string()),
        None => classes.retain(|c| c != from),
    }
}

/// Rebuild `config.segmentation_labels` from the `labels` table.
///
/// The table is the source of truth while a project is open, but the config
/// copy is what `sync_labels_from_config` replays on the next open — matching
/// by name — so it has to say the same thing or that sync undoes the edit.
/// `renamed` is `(old, new)`, so a renamed label keeps its stored shades.
fn write_labels_to_config(
    conn: &Connection,
    config: &mut ProjectConfig,
    renamed: Option<(&str, &str)>,
) -> Result<()> {
    let mut shades: HashMap<String, Option<Vec<String>>> = config
        .segmentation_labels
        .take()
        .unwrap_or_default()
        .into_iter()
        .map(|l| (l.name, l.shades))
        .collect();

    let mut stmt = conn.prepare("SELECT name, color FROM labels ORDER BY sort_order, id")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut labels = Vec::new();
    for row in rows {
        let (name, color) = row?;
        let stored_as = match renamed {
            Some((old, new)) if new == name => old,
            _ => name.as_str(),
        };
        let shades = shades.remove(stored_as).flatten();
        labels.push(LabelConfig { name, color, shades });
    }
    config.segmentation_labels = Some(labels);
    Ok(())
}

// ==========================================
// Row helpers
// ==========================================

/// Follow a class rename (`to = Some`) or removal (`to = None`) through every
/// frame classified with `task`. A row left with no class is deleted, which is
/// how "nothing selected" is stored everywhere else.
fn rewrite_selected_classes(
    conn: &Connection,
    task: &str,
    from: &str,
    to: Option<&str>,
) -> Result<()> {
    let rows: Vec<(i64, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, selected_classes FROM main.classifications WHERE task_name = ?1")?;
        let rows = stmt.query_map(params![task], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };

    for (id, json) in rows {
        let mut classes: Vec<String> = serde_json::from_str(&json).unwrap_or_default();
        if !classes.iter().any(|c| c == from) {
            continue;
        }
        replace_class(&mut classes, from, to);
        // A multilabel row can already hold the name being renamed to.
        let mut seen = HashSet::new();
        classes.retain(|c| seen.insert(c.clone()));

        if classes.is_empty() {
            conn.execute("DELETE FROM main.classifications WHERE id = ?1", params![id])?;
        } else {
            conn.execute(
                "UPDATE main.classifications
                 SET selected_classes = ?1, modified_at = datetime('now') WHERE id = ?2",
                params![serde_json::to_string(&classes)?, id],
            )?;
        }
    }
    Ok(())
}

/// Drop classifications stored under a name no task currently uses.
///
/// Only reachable for a name that is about to be taken. Rows like these come
/// from project files edited by hand or by an older build; left in place they
/// would silently become the new task's answers, or collide with a rename.
fn forget_orphan_classifications(conn: &Connection, task_name: &str) -> Result<()> {
    conn.execute("DELETE FROM main.classifications WHERE task_name = ?1", params![task_name])?;
    Ok(())
}

/// Same as [`forget_orphan_classifications`], for text fields.
fn forget_orphan_texts(conn: &Connection, field: &str) -> Result<()> {
    conn.execute("DELETE FROM main.text_descriptions WHERE label_name = ?1", params![field])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::rle;

    /// A project with two labels and two frames, annotated on both.
    fn project() -> Connection {
        let conn = queries::create_database(std::path::Path::new(":memory:")).unwrap();
        let config = ProjectConfig {
            name: "p".into(),
            classification_enabled: true,
            segmentation_labels: Some(vec![
                LabelConfig { name: "cell".into(), color: "#ff0000".into(), shades: None },
                LabelConfig { name: "vessel".into(), color: "#00ff00".into(), shades: None },
            ]),
            classification_tasks: Some(vec![MulticlassConfig {
                name: "quality".into(),
                classes: vec!["good".into(), "bad".into()],
                default: Some("good".into()),
            }]),
            multilabel_task: Some(MultilabelConfig {
                name: "findings".into(),
                classes: vec!["a".into(), "b".into()],
                default: None,
            }),
            text_fields: Some(vec!["notes".into()]),
            ..Default::default()
        };
        queries::insert_project(&conn, &config).unwrap();
        queries::sync_labels_from_config(&conn, &config).unwrap();

        let painted = rle::encode8(&[0, 1, 1, 0]);
        let wiped = rle::encode8(&[0, 0, 0, 0]);
        conn.execute_batch(
            "INSERT INTO sequences (id, name) VALUES (1, 's');
             INSERT INTO frames (id, sequence_id, frame_index, width, height)
               VALUES (1, 1, 0, 2, 2), (2, 1, 1, 2, 2);
             INSERT INTO vector_annotations (frame_id, label_id, shapes)
               VALUES (1, 1, '[{}]'), (2, 1, '[]');
             INSERT INTO classifications (frame_id, task_name, selected_classes, is_multilabel)
               VALUES (1, 'quality', '[\"good\"]', 0), (2, 'quality', '[\"bad\"]', 0),
                      (1, 'findings', '[\"a\",\"b\"]', 1), (2, 'findings', '[\"a\"]', 1);
             INSERT INTO text_descriptions (frame_id, label_name, content)
               VALUES (1, 'notes', 'hello');",
        )
        .unwrap();
        for (frame, label, data) in [(1, 1, &painted), (2, 1, &wiped), (1, 2, &painted)] {
            conn.execute(
                "INSERT INTO annotations (frame_id, label_id, encoding, mask_data)
                 VALUES (?1, ?2, 'rle8', ?3)",
                params![frame, label, data],
            )
            .unwrap();
        }
        conn
    }

    fn label_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT name FROM labels ORDER BY sort_order").unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn config_label_names(config: &ProjectConfig) -> Vec<String> {
        config.segmentation_labels.iter().flatten().map(|l| l.name.clone()).collect()
    }

    fn selected(conn: &Connection, frame: i64, task: &str) -> Option<String> {
        conn.query_row(
            "SELECT selected_classes FROM classifications WHERE frame_id = ?1 AND task_name = ?2",
            params![frame, task],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    /// The failure this module exists to prevent: a rename must survive the
    /// name-based label sync that runs on every open, annotations attached.
    #[test]
    fn a_renamed_label_keeps_its_annotations_across_a_reopen() {
        let conn = project();
        let config =
            apply_edit(&conn, &ProjectEdit::RenameLabel { id: 1, name: " nucleus ".into() })
                .unwrap();
        assert_eq!(config_label_names(&config), ["nucleus", "vessel"]);

        // What `open_project` does.
        let reopened = queries::get_project_config(&conn).unwrap();
        queries::sync_labels_from_config(&conn, &reopened).unwrap();

        assert_eq!(label_names(&conn), ["nucleus", "vessel"]);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM annotations WHERE label_id = 1", []).unwrap(), 2);
    }

    #[test]
    fn a_label_name_cannot_be_taken_twice_or_left_empty() {
        let conn = project();
        assert!(apply_edit(&conn, &ProjectEdit::RenameLabel { id: 1, name: "vessel".into() }).is_err());
        assert!(apply_edit(&conn, &ProjectEdit::RenameLabel { id: 1, name: "  ".into() }).is_err());
        assert!(apply_edit(
            &conn,
            &ProjectEdit::AddLabel { name: "cell".into(), color: "#000000".into() }
        )
        .is_err());
        assert_eq!(label_names(&conn), ["cell", "vessel"], "a refused edit changes nothing");
    }

    #[test]
    fn recolouring_touches_the_label_and_the_config_only() {
        let conn = project();
        let config =
            apply_edit(&conn, &ProjectEdit::RecolorLabel { id: 2, color: "#0000FF".into() })
                .unwrap();
        assert_eq!(config.segmentation_labels.unwrap()[1].color, "#0000ff");
        let stored: String =
            conn.query_row("SELECT color FROM labels WHERE id = 2", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, "#0000ff");
        assert!(apply_edit(&conn, &ProjectEdit::RecolorLabel { id: 2, color: "blue".into() }).is_err());
    }

    #[test]
    fn an_added_label_goes_last_and_into_the_config() {
        let conn = project();
        let config = apply_edit(
            &conn,
            &ProjectEdit::AddLabel { name: "debris".into(), color: "#123456".into() },
        )
        .unwrap();
        assert_eq!(config_label_names(&config), ["cell", "vessel", "debris"]);
        assert_eq!(label_names(&conn), ["cell", "vessel", "debris"]);
    }

    #[test]
    fn a_new_label_order_survives_a_reopen_and_keeps_annotations_on_their_label() {
        let conn = project();
        let config = apply_edit(&conn, &ProjectEdit::ReorderLabels { ids: vec![2, 1] }).unwrap();
        assert_eq!(config_label_names(&config), ["vessel", "cell"]);

        // What `open_project` does: sort_order is replayed from the config.
        let reopened = queries::get_project_config(&conn).unwrap();
        queries::sync_labels_from_config(&conn, &reopened).unwrap();
        assert_eq!(label_names(&conn), ["vessel", "cell"]);

        let cell: i64 =
            conn.query_row("SELECT id FROM labels WHERE name = 'cell'", [], |r| r.get(0)).unwrap();
        assert_eq!(cell, 1, "ids do not move, so annotations stay on their label");
    }

    #[test]
    fn a_reorder_must_name_every_label_exactly_once() {
        let conn = project();
        for ids in [vec![1], vec![1, 1], vec![1, 2, 3]] {
            assert!(apply_edit(&conn, &ProjectEdit::ReorderLabels { ids }).is_err());
        }
        assert_eq!(label_names(&conn), ["cell", "vessel"]);
    }

    #[test]
    fn the_impact_of_deleting_a_label_ignores_wiped_masks_and_empty_shape_rows() {
        let conn = project();
        let impact = edit_impact(&conn, &ProjectEdit::DeleteLabel { id: 1 }).unwrap();
        assert_eq!(
            impact,
            EditImpact { mask_frames: 1, shape_frames: 1, ..Default::default() },
            "frame 2 holds an all-zero mask and an empty shape list"
        );
    }

    #[test]
    fn deleting_a_label_removes_its_annotations_and_only_its() {
        let conn = project();
        let config = apply_edit(&conn, &ProjectEdit::DeleteLabel { id: 1 }).unwrap();
        assert_eq!(config_label_names(&config), ["vessel"]);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM annotations", []).unwrap(), 1);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM vector_annotations", []).unwrap(), 0);
        assert!(apply_edit(&conn, &ProjectEdit::DeleteLabel { id: 1 }).is_err(), "already gone");
    }

    #[test]
    fn deleting_a_label_drops_a_model_trained_on_it_and_spares_one_that_was_not() {
        let conn = project();
        queries::save_ml_model(&conn, r#"{"label_order":[2]}"#, &[1]).unwrap();
        assert!(!edit_impact(&conn, &ProjectEdit::DeleteLabel { id: 1 }).unwrap().discards_model);
        apply_edit(&conn, &ProjectEdit::DeleteLabel { id: 1 }).unwrap();
        assert!(queries::load_ml_model(&conn).unwrap().is_some());

        assert!(edit_impact(&conn, &ProjectEdit::DeleteLabel { id: 2 }).unwrap().discards_model);
        apply_edit(&conn, &ProjectEdit::DeleteLabel { id: 2 }).unwrap();
        assert!(queries::load_ml_model(&conn).unwrap().is_none());
    }

    #[test]
    fn renaming_a_task_carries_its_classifications() {
        let conn = project();
        let config = apply_edit(
            &conn,
            &ProjectEdit::RenameTask { name: "quality".into(), new_name: "grade".into() },
        )
        .unwrap();
        assert_eq!(config.classification_tasks.unwrap()[0].name, "grade");
        assert_eq!(selected(&conn, 1, "grade").as_deref(), Some(r#"["good"]"#));
        assert_eq!(selected(&conn, 1, "quality"), None);
        assert!(
            apply_edit(
                &conn,
                &ProjectEdit::RenameTask { name: "grade".into(), new_name: "findings".into() }
            )
            .is_err(),
            "the multilabel task already has that name"
        );
    }

    #[test]
    fn renaming_a_class_rewrites_selections_and_the_default() {
        let conn = project();
        let config = apply_edit(
            &conn,
            &ProjectEdit::RenameClass {
                task: "quality".into(),
                name: "good".into(),
                new_name: "fine".into(),
            },
        )
        .unwrap();
        let task = &config.classification_tasks.unwrap()[0];
        assert_eq!(task.classes, ["fine", "bad"]);
        assert_eq!(task.default.as_deref(), Some("fine"));
        assert_eq!(selected(&conn, 1, "quality").as_deref(), Some(r#"["fine"]"#));
        assert_eq!(selected(&conn, 2, "quality").as_deref(), Some(r#"["bad"]"#));
    }

    #[test]
    fn deleting_a_class_unselects_it_and_drops_rows_left_empty() {
        let conn = project();
        let edit = ProjectEdit::DeleteClass { task: "findings".into(), name: "a".into() };
        assert_eq!(edit_impact(&conn, &edit).unwrap().classification_frames, 2);

        let config = apply_edit(&conn, &edit).unwrap();
        assert_eq!(config.multilabel_task.unwrap().classes, ["b"]);
        assert_eq!(selected(&conn, 1, "findings").as_deref(), Some(r#"["b"]"#));
        assert_eq!(selected(&conn, 2, "findings"), None, "nothing left selected");
        assert_eq!(selected(&conn, 1, "quality").as_deref(), Some(r#"["good"]"#), "other task untouched");
    }

    #[test]
    fn deleting_a_task_deletes_its_classifications() {
        let conn = project();
        let edit = ProjectEdit::DeleteTask { name: "findings".into() };
        assert_eq!(edit_impact(&conn, &edit).unwrap().classification_frames, 2);
        let config = apply_edit(&conn, &edit).unwrap();
        assert!(config.multilabel_task.is_none());
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM classifications", []).unwrap(), 2);
    }

    #[test]
    fn a_new_task_does_not_inherit_rows_left_under_its_name() {
        let conn = project();
        conn.execute(
            "INSERT INTO classifications (frame_id, task_name, selected_classes)
             VALUES (1, 'stage', '[\"x\"]')",
            [],
        )
        .unwrap();
        apply_edit(&conn, &ProjectEdit::AddMulticlassTask { name: "stage".into() }).unwrap();
        assert_eq!(selected(&conn, 1, "stage"), None);
    }

    #[test]
    fn text_fields_rename_and_delete_with_their_content() {
        let conn = project();
        apply_edit(
            &conn,
            &ProjectEdit::RenameTextField { name: "notes".into(), new_name: "report".into() },
        )
        .unwrap();
        let edit = ProjectEdit::DeleteTextField { name: "report".into() };
        assert_eq!(edit_impact(&conn, &edit).unwrap().text_frames, 1);
        let config = apply_edit(&conn, &edit).unwrap();
        assert_eq!(config.text_fields.unwrap(), Vec::<String>::new());
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM text_descriptions", []).unwrap(), 0);
    }

    #[test]
    fn switching_a_task_family_off_keeps_its_data() {
        let conn = project();
        let config = apply_edit(
            &conn,
            &ProjectEdit::SetTaskEnabled { task: TaskKind::Classification, enabled: false },
        )
        .unwrap();
        assert!(!config.classification_enabled);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM classifications", []).unwrap(), 4);
        assert!(!queries::get_project_config(&conn).unwrap().classification_enabled, "persisted");
    }

    #[test]
    fn the_edit_type_reads_what_the_frontend_sends() {
        let edit: ProjectEdit =
            serde_json::from_str(r#"{"type":"renameClass","task":"t","name":"a","newName":"b"}"#)
                .unwrap();
        assert!(matches!(edit, ProjectEdit::RenameClass { new_name, .. } if new_name == "b"));
        let edit: ProjectEdit = serde_json::from_str(
            r#"{"type":"setTaskEnabled","task":"textDescription","enabled":true}"#,
        )
        .unwrap();
        assert!(matches!(
            edit,
            ProjectEdit::SetTaskEnabled { task: TaskKind::TextDescription, enabled: true }
        ));
    }
}
