//! Frames and where their pixels are: embedded in the project, a file in its
//! image folder, or a frame of a video. Below `commands`, so the caches, the
//! Python bridge and the importers can read frames without reaching up.

use rusqlite::params;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use ts_rs::TS;

use crate::storage::DbState;
use crate::types::project::ProjectConfig;
use crate::utils::error::{AppError, Result};

#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct Frame {
  #[ts(type = "number")]
  pub id: i64,
  #[ts(type = "number")]
  pub sequence_id: i64,
  pub frame_index: i32,
  pub relative_path: Option<String>,
  pub width: i32,
  pub height: i32,
  pub reviewed: bool,
  pub is_embedded: bool,
}


pub struct FrameMeta { pub frame: Frame }

pub fn read_frame_bytes(
    db: &DbState,
    frame_id: i64,
) -> Result<(FrameMeta, Vec<u8>)> {
    read_frame_bytes_with(db, frame_id, false)
}

/// [`read_frame_bytes`], for a caller going through a sequence in order: a
/// video frame is decoded together with the ones that follow it (see
/// `crate::video::read_run`).
pub fn read_frame_bytes_ahead(
    db: &DbState,
    frame_id: i64,
) -> Result<(FrameMeta, Vec<u8>)> {
    read_frame_bytes_with(db, frame_id, true)
}

fn read_frame_bytes_with(
    db: &DbState,
    frame_id: i64,
    ahead: bool,
) -> Result<(FrameMeta, Vec<u8>)> {
    use crate::video::RunFrame;

    /// Where a frame's pixels are, once the row has been read.
    enum Source {
        Embedded(Vec<u8>),
        File(std::path::PathBuf),
        Video {
            path: std::path::PathBuf,
            seek_margin: f64,
            seek_preroll: f64,
            frame: RunFrame,
            ahead: Vec<RunFrame>,
        },
    }

    let image_root = db.image_root();
    // Only the row is read under the connection lock: decoding can take a while.
    let (frame, source) = db.with_conn(|conn| {
        let row = conn.query_row(
            "SELECT f.id, f.sequence_id, f.frame_index, f.relative_path,
                    f.embedded_data, f.width, f.height,
                    EXISTS (SELECT 1 FROM frame_reviews r WHERE r.frame_id = f.id),
                    json_extract(p.config, '$.input_folder'),
                    v.relative_path, f.video_time, v.seek_margin,
                    f.video_id, f.video_frame, v.seek_preroll
             FROM frames f
             JOIN sequences s ON f.sequence_id = s.id
             JOIN project p ON p.id = 1
             LEFT JOIN videos v ON v.id = f.video_id
             WHERE f.id = ?1",
            params![frame_id],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i32>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<Vec<u8>>>(4)?,
                row.get::<_, i32>(5)?,
                row.get::<_, i32>(6)?,
                row.get::<_, bool>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<f64>>(10)?,
                row.get::<_, Option<f64>>(11)?,
                row.get::<_, Option<i64>>(12)?,
                row.get::<_, Option<i64>>(13)?,
                row.get::<_, Option<f64>>(14)?,
            )),
        ).map_err(AppError::Database)?;

        let (id, sequence_id, frame_index, relative_path,
             embedded_data, width, height, reviewed, input_folder,
             video_path, video_time, seek_margin, video_id, video_frame, seek_preroll) = row;

        let is_embedded = embedded_data.is_some();
        // The folder as this computer reaches it, when the project was opened
        // through `open_project`; the one it was created with otherwise.
        let input_folder = image_root.or(input_folder.map(PathBuf::from));
        let in_input_folder = |rel: &str| {
            input_folder
                .as_deref()
                .map(|folder| join_relative(folder, rel))
                .ok_or_else(|| AppError::Generic("Project has no input_folder in config".into()))
        };
        let source = if let Some(data) = embedded_data {
            Source::Embedded(data)
        } else if let (Some(video), Some(time)) = (&video_path, video_time) {
            let path = in_input_folder(video)?;
            let video_frame = video_frame.unwrap_or(0);
            // The following frames are looked up only when this one must be decoded.
            let following = if ahead && !crate::video::is_cached(&path, time) {
                let limit = crate::video::run_length(width.max(0) as u32, height.max(0) as u32);
                let mut stmt = conn.prepare_cached(
                    "SELECT video_time, video_frame FROM frames
                     WHERE video_id = ?1 AND video_frame > ?2
                     ORDER BY video_frame LIMIT ?3",
                )?;
                let rows = stmt.query_map(params![video_id, video_frame, limit as i64], |row| {
                    Ok(RunFrame {
                        time: row.get(0)?,
                        video_frame: row.get::<_, i64>(1)?.max(0) as usize,
                    })
                })?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            } else {
                Vec::new()
            };
            Source::Video {
                path,
                seek_margin: seek_margin.unwrap_or(0.0),
                seek_preroll: seek_preroll.unwrap_or(0.0),
                frame: RunFrame { time, video_frame: video_frame.max(0) as usize },
                ahead: following,
            }
        } else if let Some(ref rel) = relative_path {
            Source::File(in_input_folder(rel)?)
        } else {
            return Err(AppError::Generic("Frame has no image data".into()));
        };

        Ok((
            Frame {
                id, sequence_id, frame_index, relative_path,
                width, height, reviewed, is_embedded,
            },
            source,
        ))
    })?;

    let bytes = match source {
        Source::Embedded(data) => data,
        Source::File(full) => fs::read(&full).map_err(|e| AppError::Io(
            std::io::Error::new(e.kind(),
                format!("Failed to read image: {}", full.display()))
        ))?,
        Source::Video { path, seek_margin, seek_preroll, frame, ahead } => {
            if !path.is_file() {
                return Err(AppError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("Failed to read video: {}", path.display()),
                )));
            }
            crate::video::read_run(&path, seek_margin, seek_preroll, frame, &ahead)?
        }
    };

    Ok((FrameMeta { frame }, bytes))
}

/// Where this computer finds the project's image folder: the first of the
/// paths the project knows it by that exists here (a network share has a
/// different path on each system), or else the one it was created with.
pub fn resolve_image_folder(config: &ProjectConfig) -> Option<PathBuf> {
    let known = || config.input_folder.iter().chain(&config.input_folder_alternates);
    known()
        .map(PathBuf::from)
        .find(|folder| folder.is_dir())
        .or_else(|| known().next().map(PathBuf::from))
}

/// `folder/relative`, for a path stored by whichever system imported it
/// (Windows writes `a\b.png`).
pub fn join_relative(folder: &Path, relative: &str) -> PathBuf {
    if cfg!(windows) {
        folder.join(relative)
    } else {
        folder.join(relative.replace('\\', "/"))
    }
}
