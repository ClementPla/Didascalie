//! Microscopy frames at full resolution, for the Python bridge.
//!
//! A project may hold a series at a lower resolution level than the file has
//! (see [`SeriesPick::default_for`]): the editor needs the whole frame and its
//! masks in memory. A Python function has no such limit, so it is given the
//! finest level within [`BRIDGE_MAX_PIXELS`], read again from the file. The
//! masks are scaled between that level and the stored one by the caller.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use parking_lot::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use super::import::TempDir;
use super::{export, inspect, MicroscopySeries, SeriesPick};
use crate::frames::{join_relative, resolve_image_folder};
use crate::storage::{queries, DbState};
use crate::utils::error::{AppError, Result};

/// Largest frame sent (2³⁰ pixels, 3 GB as RGB). A message holds one buffer of
/// at most 4 GB, and the frame is held several times on the way.
pub const BRIDGE_MAX_PIXELS: u64 = 1 << 30;

/// Where a stored frame was converted from, as `frame_sources` records it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct FrameSource {
    /// As the project names it: relative to the image folder, or absolute.
    pub source_path: String,
    pub series: u32,
    pub level: u32,
    pub t: u32,
    /// None for a maximum projection over Z.
    pub z: Option<u32>,
    /// The file's channels the frame's pages hold, as `0,2,3`.
    pub channels: String,
}

impl FrameSource {
    pub fn load(conn: &Connection, frame_id: i64) -> Result<Option<Self>> {
        Ok(conn
            .query_row(
                "SELECT source_path, series, level, t, z, channels FROM frame_sources
                 WHERE frame_id = ?1",
                params![frame_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u32>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, u32>(3)?,
                        row.get::<_, Option<u32>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?
            .map(|(source_path, series, level, t, z, channels)| FrameSource {
                source_path,
                series,
                level,
                t,
                z,
                channels: serde_json::from_str::<Vec<u32>>(&channels)
                    .map(|c| c.iter().map(u32::to_string).collect::<Vec<_>>().join(","))
                    .unwrap_or_else(|_| "all".into()),
            }))
    }

    /// What one export call can serve: everything but the plane.
    fn group(&self) -> (String, u32, u32, bool, String) {
        (self.source_path.clone(), self.series, self.level, self.z.is_none(), self.channels.clone())
    }
}

/// A frame read again from its file, finer than the stored one.
pub struct NativePlane {
    /// A multi-page TIFF, like `frames.embedded_data`.
    pub path: PathBuf,
    pub level: u32,
    pub width: u32,
    pub height: u32,
}

/// What became of a frame stored below full resolution.
pub enum Outcome {
    /// Read at `NativePlane::level`.
    Finer(NativePlane),
    /// Sent as stored, for this reason.
    AsStored(String),
}

/// Native planes for a set of frames, kept on disk until dropped. Frames the
/// project holds at full resolution, or that are not from a microscopy file,
/// have no entry.
pub struct NativeFrames {
    _dirs: Vec<TempDir>,
    pub frames: BTreeMap<i64, Outcome>,
}

impl NativeFrames {
    pub fn get(&self, frame_id: i64) -> Option<&Outcome> {
        self.frames.get(&frame_id)
    }
}

/// The finest level of `series` within [`BRIDGE_MAX_PIXELS`] (the coarsest
/// when none is).
fn bridge_level(series: &MicroscopySeries) -> u32 {
    series
        .levels
        .iter()
        .position(|l| l.width as u64 * l.height as u64 <= BRIDGE_MAX_PIXELS)
        .unwrap_or(series.levels.len().saturating_sub(1)) as u32
}

/// The file at `source_path`, as this computer reaches it.
fn resolve(conn: &Connection, db: &DbState, source_path: &str) -> Result<PathBuf> {
    let path = Path::new(source_path);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let folder = db
        .image_root()
        .or_else(|| queries::get_project_config(conn).ok().and_then(|c| resolve_image_folder(&c)))
        .ok_or_else(|| AppError::Other("the project has no image folder".into()))?;
    Ok(join_relative(&folder, source_path))
}

/// Read every frame of `frame_ids` stored below the level the bridge sends,
/// one `didascalie-bioformats` run per file and series.
pub fn read(db: &DbState, frame_ids: &[i64]) -> Result<NativeFrames> {
    let sources: Vec<(i64, FrameSource)> = db.with_conn(|conn| {
        let mut out = Vec::new();
        for &id in frame_ids {
            if let Some(source) = FrameSource::load(conn, id)? {
                if source.level > 0 {
                    out.push((id, source));
                }
            }
        }
        Ok(out)
    })?;

    let mut groups: BTreeMap<_, Vec<(i64, FrameSource)>> = BTreeMap::new();
    for (id, source) in sources {
        groups.entry(source.group()).or_default().push((id, source));
    }

    let mut result = NativeFrames { _dirs: Vec::new(), frames: BTreeMap::new() };
    for members in groups.into_values() {
        match read_group(db, &members) {
            Ok((dir, planes)) => {
                result._dirs.push(dir);
                for (id, outcome) in planes {
                    result.frames.insert(id, outcome);
                }
            }
            Err(e) => {
                let reason = e.to_string();
                for (id, _) in members {
                    result.frames.insert(id, Outcome::AsStored(reason.clone()));
                }
            }
        }
    }
    Ok(result)
}

/// The members share a file, series, level, channels and kind of Z.
fn read_group(db: &DbState, members: &[(i64, FrameSource)]) -> Result<(TempDir, Vec<(i64, Outcome)>)> {
    let first = &members[0].1;
    let path = db.with_conn(|conn| resolve(conn, db, &first.source_path))?;
    if !path.is_file() {
        return Err(AppError::Other(format!("{} was not found", path.display())));
    }
    let file = cached_inspect(&path)?;
    let series = file
        .iter()
        .find(|s| s.index == first.series)
        .ok_or_else(|| AppError::Other(format!("the file has no series {}", first.series)))?;
    let level = bridge_level(series);
    let dir = TempDir::new()?;
    if level >= first.level {
        let reason = "no finer level fits in one message".to_string();
        return Ok((dir, members.iter().map(|(id, _)| (*id, Outcome::AsStored(reason.clone()))).collect()));
    }

    let list = |values: Vec<u32>| {
        let mut values = values;
        values.sort_unstable();
        values.dedup();
        values.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
    };
    let pick = SeriesPick {
        index: first.series,
        level,
        z: match first.z {
            None => "max".into(),
            Some(_) => list(members.iter().filter_map(|(_, s)| s.z).collect()),
        },
        t: list(members.iter().map(|(_, s)| s.t).collect()),
        c: first.channels.clone(),
    };
    // Several t and z export their product: a few planes more than asked for,
    // at the cost of one run instead of one per frame.
    let planes = export(&path, &pick, dir.path())?;
    let outcomes = members
        .iter()
        .map(|(id, source)| {
            let outcome = planes
                .iter()
                .find(|p| p.t == source.t && p.z == source.z)
                .map(|p| {
                    Outcome::Finer(NativePlane {
                        path: p.path.clone(),
                        level,
                        width: p.width,
                        height: p.height,
                    })
                })
                .unwrap_or_else(|| Outcome::AsStored("the plane was not exported".into()));
            (*id, outcome)
        })
        .collect();
    Ok((dir, outcomes))
}

/// `inspect` runs the separate program and opens the file: its answer is kept
/// per file, as long as the file is unchanged.
fn cached_inspect(path: &Path) -> Result<Vec<MicroscopySeries>> {
    type Entry = (PathBuf, Option<std::time::SystemTime>, Vec<MicroscopySeries>);
    static CACHE: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
    let modified = fs::metadata(path).and_then(|m| m.modified()).ok();
    if let Some((_, _, series)) = CACHE
        .lock()
        .iter()
        .find(|(p, m, _)| p == path && *m == modified)
    {
        return Ok(series.clone());
    }
    let series = inspect(path)?.series;
    let mut cache = CACHE.lock();
    cache.retain(|(p, _, _)| p != path);
    if cache.len() >= 8 {
        cache.remove(0);
    }
    cache.push((path.to_path_buf(), modified, series.clone()));
    Ok(series)
}

/// `mask` (`from_w × from_h`) resampled to `to_w × to_h` by nearest pixel, so
/// that instance ids survive.
pub fn resample_mask(mask: &[u8], from_w: u32, from_h: u32, to_w: u32, to_h: u32) -> Vec<u8> {
    if (from_w, from_h) == (to_w, to_h) {
        return mask.to_vec();
    }
    let xs: Vec<usize> = (0..to_w)
        .map(|x| (((x as u64 * 2 + 1) * from_w as u64) / (to_w as u64 * 2)).min(from_w as u64 - 1) as usize)
        .collect();
    let mut out = Vec::with_capacity(to_w as usize * to_h as usize);
    for y in 0..to_h {
        let sy = (((y as u64 * 2 + 1) * from_h as u64) / (to_h as u64 * 2)).min(from_h as u64 - 1) as usize;
        let row = &mask[sy * from_w as usize..(sy + 1) * from_w as usize];
        out.extend(xs.iter().map(|&sx| row[sx]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::microscopy::LevelSize;

    #[test]
    fn masks_resample_by_nearest_pixel() {
        // 2×2 up to 4×4: each pixel becomes a 2×2 block.
        let up = resample_mask(&[1, 2, 3, 4], 2, 2, 4, 4);
        assert_eq!(up, vec![1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]);
        // And back down.
        assert_eq!(resample_mask(&up, 4, 4, 2, 2), vec![1, 2, 3, 4]);
        // Ratios that do not divide.
        assert_eq!(resample_mask(&[5, 6, 7], 3, 1, 2, 1), vec![5, 7]);
        assert_eq!(resample_mask(&[9], 1, 1, 3, 2), vec![9; 6]);
    }

    #[test]
    fn the_bridge_takes_the_finest_level_that_fits() {
        let mut series: MicroscopySeries = serde_json::from_value(serde_json::json!({
            "index": 0, "width": 1, "height": 1, "sizeZ": 1, "sizeC": 1, "sizeT": 1,
            "samplesPerPixel": 1, "pixelType": "Uint8", "bitsPerPixel": 8, "sample": "u8",
            "thumbnail": false, "levels": [], "channels": []
        }))
        .unwrap();
        series.levels = vec![
            LevelSize { width: 90_000, height: 60_000 },
            LevelSize { width: 22_500, height: 15_000 },
            LevelSize { width: 5_625, height: 3_750 },
        ];
        assert_eq!(bridge_level(&series), 1);
        series.levels[0] = LevelSize { width: 30_000, height: 30_000 };
        assert_eq!(bridge_level(&series), 0);
    }

    /// A pyramidal file imported at a lower level is read back at level 0.
    /// Needs the reader (`npm run fetch-reader`) and a file with several
    /// levels in `DIDASCALIE_TEST_PYRAMID`, given by absolute path.
    #[test]
    #[ignore]
    fn a_lower_level_import_is_read_again_at_level_0() {
        use crate::microscopy::import::{insert, prepare};
        let file = std::env::var("DIDASCALIE_TEST_PYRAMID").expect("DIDASCALIE_TEST_PYRAMID");
        let conn = queries::create_database(Path::new(":memory:")).unwrap();

        let info = inspect(Path::new(&file)).unwrap();
        let series = &info.series[0];
        assert!(series.levels.len() > 1, "the file has a single level");
        let coarsest = series.levels.len() as u32 - 1;
        let mut pick = SeriesPick::default_for(series).unwrap();
        pick.level = coarsest;
        let prepared = prepare(Path::new(&file), &file, Some(vec![pick])).unwrap();
        insert(&conn, &prepared).unwrap();
        let (frame_id, stored): (i64, (u32, u32)) = conn
            .query_row("SELECT id, width, height FROM frames LIMIT 1", [], |r| {
                Ok((r.get(0)?, (r.get(1)?, r.get(2)?)))
            })
            .unwrap();
        let full = series.levels[0];
        assert_ne!(stored, (full.width, full.height));

        let db = DbState::new();
        db.set(conn);
        let native = read(&db, &[frame_id]).unwrap();
        let Some(Outcome::Finer(plane)) = native.get(frame_id) else {
            panic!("not read again: {}", match native.get(frame_id) {
                Some(Outcome::AsStored(why)) => why.as_str(),
                _ => "no entry",
            });
        };
        assert_eq!((plane.level, plane.width, plane.height), (0, full.width, full.height));
        let bytes = fs::read(&plane.path).unwrap();
        let picture = crate::pixels::picture::frame_picture(&db, frame_id, &bytes, 0).unwrap();
        assert_eq!((picture.width(), picture.height()), (full.width, full.height));
        println!("stored {stored:?}, sent {}×{}", picture.width(), picture.height());
    }

    #[test]
    fn a_source_reads_back_from_its_row() {
        let conn = queries::create_database(Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO sequences (id, name) VALUES (1, 's');
             INSERT INTO frames (id, sequence_id, frame_index, width, height) VALUES (7, 1, 0, 1, 1);
             INSERT INTO frame_sources (frame_id, source_path, series, level, t, z, channels)
             VALUES (7, 'run/slide.svs', 2, 3, 4, NULL, '[0,2]');",
        )
        .unwrap();
        let source = FrameSource::load(&conn, 7).unwrap().unwrap();
        assert_eq!(
            source,
            FrameSource {
                source_path: "run/slide.svs".into(),
                series: 2,
                level: 3,
                t: 4,
                z: None,
                channels: "0,2".into(),
            }
        );
        assert!(FrameSource::load(&conn, 8).unwrap().is_none());
    }
}
