//! Importing a microscopy file: convert the picked series with
//! `didascalie-bioformats` ([`prepare`], slow, no database), then add them to
//! the project ([`insert`], one transaction).
//!
//! Each series becomes a sequence whose frames run through time, then Z. Every
//! frame is embedded, since the application cannot read the original file,
//! and `frame_sources` records where it came from. The sequence's display
//! starts from the file's channel names and colours.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection};

use super::{export, inspect, picked_channels, ExportedPlane, MicroscopySeries, SeriesPick};
use crate::storage::queries::free_sequence_name;
use crate::utils::hash::sha256_hex;
use crate::pixels::display::{auto_window, DisplaySettings};
use crate::pixels::{raw, stats};
use crate::storage::queries;
use crate::utils::error::{AppError, Result};

/// A file converted by [`prepare`], waiting for [`insert`].
pub struct Prepared {
    /// Where the file is, as the project records it.
    pub source_path: String,
    series: Vec<PreparedSeries>,
    /// Holds the converted frames; deleted with this value.
    _dir: TempDir,
}

struct PreparedSeries {
    info: MicroscopySeries,
    pick: SeriesPick,
    planes: Vec<ExportedPlane>,
}

/// Convert the series `picks` names, or the default picks of every series
/// (see [`SeriesPick::default_for`]). `source_path` is how the project will
/// name the file: relative to its image folder, or absolute.
pub fn prepare(path: &Path, source_path: &str, picks: Option<Vec<SeriesPick>>) -> Result<Prepared> {
    let file = inspect(path)?;
    let picks = picks.unwrap_or_else(|| file.series.iter().filter_map(SeriesPick::default_for).collect());
    if picks.is_empty() {
        return Err(AppError::Other("the file has no image to import".into()));
    }
    let dir = TempDir::new()?;
    let mut series = Vec::new();
    for pick in picks {
        let info = file
            .series
            .iter()
            .find(|s| s.index == pick.index)
            .ok_or_else(|| AppError::Other(format!("the file has no series {}", pick.index)))?
            .clone();
        if let Some(e) = &info.error {
            return Err(AppError::Other(format!("series {}: {e}", pick.index)));
        }
        let out = dir.path.join(format!("s{}", pick.index));
        let planes = export(path, &pick, &out)?;
        series.push(PreparedSeries { info, pick, planes });
    }
    Ok(Prepared {
        source_path: source_path.to_string(),
        series,
        _dir: dir,
    })
}

/// Add a prepared file to the project: one sequence per series. Returns how
/// many sequences and frames were created. Run it inside a transaction.
pub fn insert(conn: &Connection, prepared: &Prepared) -> Result<(usize, usize)> {
    let stem = file_stem(&prepared.source_path);
    let several = prepared.series.len() > 1;
    let (mut sequences, mut frames) = (0, 0);
    for series in &prepared.series {
        if series.planes.is_empty() {
            continue;
        }
        let name = if several {
            let label = series.info.name.clone().unwrap_or_else(|| format!("series {}", series.info.index));
            format!("{stem} - {label}")
        } else {
            stem.clone()
        };
        let taken: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM sequences WHERE name = ?1)",
            params![name],
            |row| row.get(0),
        )?;
        let name = if taken { free_sequence_name(conn, &name)? } else { name };
        conn.execute(
            "INSERT INTO sequences (name, sort_order)
             VALUES (?1, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM sequences))",
            params![name],
        )?;
        let sequence_id = conn.last_insert_rowid();
        sequences += 1;

        let channels: Vec<u32> = picked_channels(&series.info, &series.pick.c)
            .iter()
            .map(|c| c.source)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let channels_json = serde_json::to_string(&channels)?;
        let physical = series.info.physical_size_um.unwrap_or_default();

        // The middle frame: the ends of a stack or a time-lapse are often dim.
        let middle = fs::read(&series.planes[series.planes.len() / 2].path)?;
        seed_display(conn, sequence_id, &series.info, &series.pick, &middle)?;
        drop(middle);

        for (frame_index, plane) in series.planes.iter().enumerate() {
            let bytes = fs::read(&plane.path)?;
            let z_name = plane.z.map_or("max".to_string(), |z| z.to_string());
            conn.execute(
                "INSERT INTO frames (sequence_id, frame_index, relative_path, content_hash,
                                     embedded_data, width, height, reviewed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
                params![
                    sequence_id,
                    frame_index as i64,
                    format!("{}#s{}/t{}/z{}", prepared.source_path, series.info.index, plane.t, z_name),
                    sha256_hex(&bytes),
                    bytes,
                    plane.width,
                    plane.height
                ],
            )?;
            conn.execute(
                "INSERT INTO frame_sources (frame_id, source_path, series, level, t, z, channels,
                                            physical_size_x, physical_size_y, physical_size_z)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    conn.last_insert_rowid(),
                    prepared.source_path,
                    series.info.index,
                    series.pick.level,
                    plane.t,
                    plane.z,
                    channels_json,
                    physical.x,
                    physical.y,
                    physical.z
                ],
            )?;
            frames += 1;
        }
    }
    Ok((sequences, frames))
}

/// Whether the project already has frames from this file.
pub fn already_imported(conn: &Connection, source_path: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM frame_sources WHERE source_path = ?1)",
        params![source_path],
        |row| row.get(0),
    )?)
}

/// The automatic window of `frame`, with the file's channel names, and its
/// colours when every channel has its own. Unlike a photograph, 8-bit
/// microscopy is windowed too: it often fills a fraction of the range.
fn seed_display(
    conn: &Connection,
    sequence_id: i64,
    info: &MicroscopySeries,
    pick: &SeriesPick,
    frame: &[u8],
) -> Result<()> {
    let frame = raw::decode(frame)?;
    let stats = stats::compute(&frame);
    let mut settings = DisplaySettings::auto(&frame, &stats);
    for (display, s) in settings.channels.iter_mut().zip(&stats) {
        (display.min, display.max) = auto_window(s);
    }
    let channels = picked_channels(info, &pick.c);
    if channels.len() != settings.channels.len() {
        // The pages do not line up with the metadata: keep the automatic display.
        return save(conn, sequence_id, &settings);
    }
    let colors: Vec<&str> = channels.iter().filter_map(|c| c.color.as_deref()).collect();
    let distinct = colors.iter().collect::<std::collections::HashSet<_>>().len();
    let use_colors = colors.len() == channels.len() && (channels.len() == 1 || distinct == channels.len());
    for (display, channel) in settings.channels.iter_mut().zip(&channels) {
        display.name = channel.name.clone();
        if use_colors {
            display.color = channel.color.clone().unwrap_or_default();
        }
    }
    save(conn, sequence_id, &settings)
}

fn save(conn: &Connection, sequence_id: i64, settings: &DisplaySettings) -> Result<()> {
    queries::save_display_settings(conn, sequence_id, Some(&serde_json::to_string(settings)?))
}

/// The file name without its extension, `.ome.tif` counting as one. Both `/`
/// and `\` separate folders, whatever the system: a path recorded on Windows
/// is read on Linux too.
fn file_stem(source_path: &str) -> String {
    let name = source_path.rsplit(['/', '\\']).next().unwrap_or(source_path);
    let lower = name.to_ascii_lowercase();
    for suffix in [".ome.tiff", ".ome.tif"] {
        if lower.ends_with(suffix) {
            return name[..name.len() - suffix.len()].to_string();
        }
    }
    Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(name)
        .to_string()
}

/// A folder under the system's temporary folder, removed when dropped.
pub(crate) struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl TempDir {
    pub(crate) fn new() -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "didascalie-microscopy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::microscopy::{LevelSize, MicroscopyChannel, PhysicalSize};

    #[test]
    fn stems() {
        assert_eq!(file_stem("a/b/plate.czi"), "plate");
        assert_eq!(file_stem("cells.OME.TIFF"), "cells");
        assert_eq!(file_stem("x.ome.tif"), "x");
        assert_eq!(file_stem("C:\\data\\run 1.nd2"), "run 1");
        assert_eq!(file_stem("scans/2026\\run.2.lif"), "run.2");
        assert_eq!(file_stem("plain"), "plain");
    }

    fn u16_frame(pages: &[[u16; 4]]) -> Vec<u8> {
        use tiff::encoder::{colortype::Gray16, TiffEncoder};
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut enc = TiffEncoder::new(&mut buf).unwrap();
        for p in pages {
            enc.write_image::<Gray16>(2, 2, p).unwrap();
        }
        buf.into_inner()
    }

    fn series(colors: [Option<&str>; 2]) -> MicroscopySeries {
        MicroscopySeries {
            index: 0,
            name: Some("scene".into()),
            width: 2,
            height: 2,
            size_z: 1,
            size_c: 2,
            size_t: 1,
            samples_per_pixel: 1,
            sample: "u16".into(),
            levels: vec![LevelSize { width: 2, height: 2 }],
            physical_size_um: Some(PhysicalSize { x: Some(0.5), y: Some(0.5), z: None }),
            channels: (0..2)
                .map(|i| MicroscopyChannel {
                    source: i,
                    name: Some(format!("ch{i}")),
                    color: colors[i as usize].map(str::to_string),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    fn project() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::storage::schema::SCHEMA).unwrap();
        conn
    }

    /// Prepared by hand from frames written to a temporary folder, as the
    /// program would.
    fn prepared(info: MicroscopySeries, frames: &[Vec<u8>]) -> Prepared {
        let dir = TempDir::new().unwrap();
        let planes = frames
            .iter()
            .enumerate()
            .map(|(t, bytes)| {
                let path = dir.path.join(format!("s0_t{t}_z0.tif"));
                fs::write(&path, bytes).unwrap();
                ExportedPlane { path, t: t as u32, z: Some(0), width: 2, height: 2 }
            })
            .collect();
        let pick = SeriesPick::default_for(&info).unwrap();
        Prepared {
            source_path: "run/plate.czi".into(),
            series: vec![PreparedSeries { info, pick, planes }],
            _dir: dir,
        }
    }

    #[test]
    fn a_series_becomes_a_sequence_with_sources_and_display() {
        let conn = project();
        let frame = u16_frame(&[[0, 100, 200, 4095], [10, 10, 10, 50]]);
        let p = prepared(series([Some("#ffff00"), Some("#ff0000")]), &[frame.clone(), frame]);
        assert_eq!(insert(&conn, &p).unwrap(), (1, 2));

        let (name, id): (String, i64) =
            conn.query_row("SELECT name, id FROM sequences", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(name, "plate");
        let paths: Vec<String> = conn
            .prepare("SELECT relative_path FROM frames ORDER BY frame_index")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert_eq!(paths, ["run/plate.czi#s0/t0/z0", "run/plate.czi#s0/t1/z0"]);
        let (t, channels, px): (u32, String, f64) = conn
            .query_row(
                "SELECT t, channels, physical_size_x FROM frame_sources ORDER BY t DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((t, channels.as_str(), px), (1, "[0,1]", 0.5));
        assert!(already_imported(&conn, "run/plate.czi").unwrap());
        assert!(!already_imported(&conn, "other.czi").unwrap());

        let json = queries::load_display_settings(&conn, id).unwrap().unwrap();
        let settings: DisplaySettings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings.channels[0].name.as_deref(), Some("ch0"));
        assert_eq!(settings.channels[0].color, "#ffff00");
        assert_eq!(settings.channels[1].color, "#ff0000");

        // Imported again: the sequence takes a free name.
        insert(&conn, &p).unwrap();
        let names: Vec<String> = conn
            .prepare("SELECT name FROM sequences ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        assert_eq!(names, ["plate", "plate (2)"]);
    }

    /// The whole route on a real file, with the real program:
    /// `DIDASCALIE_BIOFORMATS=<exe> DIDASCALIE_TEST_MICROSCOPY=<file>
    /// cargo test --lib real_file -- --ignored`. With `DIDASCALIE_TEST_OUT`, the
    /// first frame of each sequence is rendered there as a PNG.
    #[test]
    #[ignore]
    fn real_file_imports_and_renders() {
        use crate::pixels::display::{render_rgb, Region};
        let file = std::env::var("DIDASCALIE_TEST_MICROSCOPY").expect("DIDASCALIE_TEST_MICROSCOPY");
        let conn = project();
        let p = prepare(Path::new(&file), &file, None).unwrap();
        let (sequences, frames) = insert(&conn, &p).unwrap();
        println!("{file}: {sequences} sequence(s), {frames} frame(s)");
        assert!(sequences > 0 && frames > 0);

        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.name, COUNT(f.id) FROM sequences s JOIN frames f ON f.sequence_id = s.id
                 GROUP BY s.id ORDER BY s.id",
            )
            .unwrap();
        let rows: Vec<(i64, String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        for (id, name, count) in rows {
            let bytes: Vec<u8> = conn
                .query_row(
                    "SELECT embedded_data FROM frames WHERE sequence_id = ?1 ORDER BY frame_index LIMIT 1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            let frame = raw::decode(&bytes).unwrap();
            let json = queries::load_display_settings(&conn, id).unwrap().unwrap();
            let settings: DisplaySettings = serde_json::from_str(&json).unwrap();
            assert_eq!(settings.channels.len(), frame.channels);
            println!(
                "  {name}: {count} frame(s), {}x{} x{} {:?}, needs render: {}, display: {json}",
                frame.width,
                frame.height,
                frame.channels,
                frame.sample_type(),
                raw::needs_render(&bytes)
            );
            if let Ok(out) = std::env::var("DIDASCALIE_TEST_OUT") {
                let (w, h, rgb) = render_rgb(&frame, &settings, Region::full(&frame), 1);
                let safe: String = name.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect();
                image::RgbImage::from_raw(w, h, rgb)
                    .unwrap()
                    .save(Path::new(&out).join(format!("{safe}.png")))
                    .unwrap();
            }
        }
    }

    #[test]
    fn dim_8_bit_channels_are_windowed_from_the_middle_frame() {
        use tiff::encoder::{colortype::Gray8, TiffEncoder};
        let frame = |v: u8| {
            let mut buf = std::io::Cursor::new(Vec::new());
            let mut enc = TiffEncoder::new(&mut buf).unwrap();
            enc.write_image::<Gray8>(2, 2, &[0, v / 2, v, v]).unwrap();
            enc.write_image::<Gray8>(2, 2, &[0, 1, 2, 3]).unwrap();
            buf.into_inner()
        };
        let conn = project();
        let mut info = series([Some("#00ff00"), Some("#ff0000")]);
        info.sample = "u8".into();
        // A dark first frame, a brighter middle one.
        insert(&conn, &prepared(info, &[frame(4), frame(40), frame(4)])).unwrap();
        let json = queries::load_display_settings(&conn, 1).unwrap().unwrap();
        let settings: DisplaySettings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings.channels[0].max, 40.0);
        assert!(settings.channels[1].max <= 3.0);
    }

    #[test]
    fn shared_or_missing_colours_keep_the_palette() {
        let conn = project();
        let frame = u16_frame(&[[0, 1, 2, 3], [0, 1, 2, 3]]);
        let auto = {
            let f = raw::decode(&frame).unwrap();
            DisplaySettings::auto(&f, &stats::compute(&f))
        };
        for colors in [[Some("#ffffff"), Some("#ffffff")], [Some("#ff0000"), None]] {
            insert(&conn, &prepared(series(colors), std::slice::from_ref(&frame))).unwrap();
            let id = conn.last_insert_rowid();
            let seq: i64 = conn.query_row("SELECT sequence_id FROM frames WHERE id = ?1", [id], |r| r.get(0)).unwrap();
            let json = queries::load_display_settings(&conn, seq).unwrap().unwrap();
            let settings: DisplaySettings = serde_json::from_str(&json).unwrap();
            assert_eq!(settings.channels[0].color, auto.channels[0].color);
            assert_eq!(settings.channels[1].name.as_deref(), Some("ch1"));
        }
    }
}
