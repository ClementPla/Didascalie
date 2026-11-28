//! Microscopy files (CZI, LIF, ND2, OME-TIFF and the other Bio-Formats
//! formats), read by the separate `didascalie-bioformats` program.
//!
//! That program links bioformats-rs, which is GPL: running it as its own
//! process keeps this application under its own licence. It is found like
//! ffmpeg: `DIDASCALIE_BIOFORMATS` if set, else next to the application, else
//! (in a debug build) in `src-tauri/binaries/`, where `npm run fetch-reader`
//! puts it, else on `PATH`. It answers in JSON whose `protocol` must match
//! [`PROTOCOL`].
//!
//! A file is converted when imported (see [`import`]): every picked (t, z) of a
//! series becomes one frame, a multi-page TIFF with one page per channel at
//! native depth, which `pixels::raw::decode` reads back as one multi-channel
//! frame. The project then needs neither the file nor the program again.

pub mod import;
pub mod native;

use std::ops::RangeInclusive;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::types::project::MICROSCOPY_EXTENSIONS;
use crate::utils::error::{AppError, Result};
use crate::utils::process::{find_program, last_error_line, no_window};

/// Version of `didascalie-bioformats`'s JSON this build understands.
pub const PROTOCOL: u32 = 1;

/// Pixels a frame is imported at by default (16384 × 16384): past it, a lower
/// resolution level is taken when the file has one. The editor holds a frame
/// and one mask per label whole, so a whole-slide level 0 would not open.
const DEFAULT_MAX_PIXELS: u64 = 1 << 28;
/// Z stacks up to this many slices are imported slice by slice by default;
/// deeper ones as a maximum projection.
const DEFAULT_MAX_SLICES: u32 = 64;

/// Whether `path` is read through `didascalie-bioformats`: a microscopy
/// extension, or an OME-TIFF (`.ome.tif`, `.ome.tiff`), whose pages are Z, C
/// and T planes rather than one image.
pub fn is_microscopy(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if name.ends_with(".ome.tif") || name.ends_with(".ome.tiff") {
        return true;
    }
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| MICROSCOPY_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

// ── What a file holds ────────────────────────────────────────────────────────

/// A microscopy file, as `didascalie-bioformats inspect` describes it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct MicroscopyFile {
    pub protocol: u32,
    pub file: String,
    pub has_ome_metadata: bool,
    pub series: Vec<MicroscopySeries>,
}

/// One image of a file: a field, a position, a scene.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct MicroscopySeries {
    pub index: u32,
    #[ts(optional = nullable)]
    pub name: Option<String>,
    pub width: u32,
    pub height: u32,
    pub size_z: u32,
    /// Channels as planes count them: an RGB plane is one channel of three
    /// samples.
    pub size_c: u32,
    pub size_t: u32,
    pub samples_per_pixel: u32,
    /// As the file stores it: `Uint16`, `Int8`, `Float32`, ...
    pub pixel_type: String,
    pub bits_per_pixel: u32,
    /// As the project stores it.
    #[ts(type = "\"u8\" | \"u16\" | \"f32\"")]
    pub sample: String,
    /// A low-resolution preview of another series, not an image of its own.
    pub thumbnail: bool,
    /// Resolution levels, full size first.
    pub levels: Vec<LevelSize>,
    #[ts(optional = nullable)]
    pub physical_size_um: Option<PhysicalSize>,
    #[ts(optional = nullable)]
    pub time_increment_s: Option<f64>,
    /// One per page of an imported frame: a channel, or a sample of an RGB
    /// channel.
    pub channels: Vec<MicroscopyChannel>,
    /// What an import takes of this series unless told otherwise (see
    /// [`SeriesPick::default_for`]); None for a thumbnail or unreadable series.
    #[ts(optional = nullable)]
    pub default_pick: Option<SeriesPick>,
    /// Why the series cannot be read. The other fields are then empty.
    #[ts(optional = nullable)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct LevelSize {
    pub width: u32,
    pub height: u32,
}

/// Micrometres per pixel (x, y) and between slices (z).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct PhysicalSize {
    #[ts(optional = nullable)]
    pub x: Option<f64>,
    #[ts(optional = nullable)]
    pub y: Option<f64>,
    #[ts(optional = nullable)]
    pub z: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct MicroscopyChannel {
    /// The file's channel this page comes from.
    pub source: u32,
    /// Which sample of an RGB channel; 0 otherwise.
    pub sample: u32,
    #[ts(optional = nullable)]
    pub name: Option<String>,
    /// `#rrggbb`.
    #[ts(optional = nullable)]
    pub color: Option<String>,
    #[ts(optional = nullable)]
    pub excitation_nm: Option<f64>,
    #[ts(optional = nullable)]
    pub emission_nm: Option<f64>,
}

// ── What to import ───────────────────────────────────────────────────────────

/// A file to import, with the series to take: none takes every series'
/// default pick, an empty list leaves the file out.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct MicroscopyImport {
    pub path: String,
    #[ts(optional = nullable)]
    pub series: Option<Vec<SeriesPick>>,
}

/// What to import of one series, in `didascalie-bioformats export`'s terms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct SeriesPick {
    pub index: u32,
    /// Resolution level, 0 being full size.
    pub level: u32,
    /// `all`, `mid`, `max` (one maximum projection), or a list like `0,3,5-7`.
    pub z: String,
    /// `all`, `step:N`, or a list.
    pub t: String,
    /// `all`, or a list of the file's channels.
    pub c: String,
}

impl SeriesPick {
    /// Every channel and time point; every slice of a stack up to
    /// [`DEFAULT_MAX_SLICES`], else a maximum projection; the finest level
    /// within [`DEFAULT_MAX_PIXELS`]. None for a thumbnail or unreadable
    /// series.
    pub fn default_for(series: &MicroscopySeries) -> Option<SeriesPick> {
        if series.thumbnail || series.error.is_some() {
            return None;
        }
        let level = series
            .levels
            .iter()
            .position(|l| l.width as u64 * l.height as u64 <= DEFAULT_MAX_PIXELS)
            .unwrap_or(series.levels.len().saturating_sub(1));
        Some(SeriesPick {
            index: series.index,
            level: level as u32,
            z: if series.size_z <= DEFAULT_MAX_SLICES { "all" } else { "max" }.into(),
            t: "all".into(),
            c: "all".into(),
        })
    }
}

/// The pages of an imported frame, for a channel selection (`all` or a list).
pub fn picked_channels<'a>(series: &'a MicroscopySeries, c: &str) -> Vec<&'a MicroscopyChannel> {
    let keep = index_set(c);
    series
        .channels
        .iter()
        .filter(|ch| keep.as_ref().is_none_or(|k| k.iter().any(|r| r.contains(&ch.source))))
        .collect()
}

/// `all` as None; `0,3,5-7` as those index ranges (`3` is `3..=3`).
/// Malformed parts are skipped: the program rejects them before anything is
/// imported. Ranges stay ranges: `0-4294967295` must not expand to a set.
fn index_set(spec: &str) -> Option<Vec<RangeInclusive<u32>>> {
    if spec.trim() == "all" {
        return None;
    }
    let mut out = Vec::new();
    for part in spec.split(',').map(str::trim) {
        match part.split_once('-') {
            Some((a, b)) => {
                if let (Ok(a), Ok(b)) = (a.trim().parse::<u32>(), b.trim().parse::<u32>()) {
                    out.push(a..=b);
                }
            }
            None => {
                if let Ok(v) = part.parse() {
                    out.push(v..=v);
                }
            }
        }
    }
    Some(out)
}

// ── Running the program ──────────────────────────────────────────────────────

const PROGRAM: &str = "didascalie-bioformats";

fn reader_path() -> PathBuf {
    find_program("DIDASCALIE_BIOFORMATS", PROGRAM, fetched_reader())
}

/// Where `npm run fetch-reader` puts the reader for a source build; None in a
/// release build, which bundles it next to the application instead.
fn fetched_reader() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let target = option_env!("DIDASCALIE_TARGET")?;
    let name = format!("{PROGRAM}-{target}{}", std::env::consts::EXE_SUFFIX);
    Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(name))
}

fn run(args: &[OsString]) -> Result<String> {
    let mut command = Command::new(reader_path());
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut command);
    let output = command.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            let hint = if cfg!(debug_assertions) {
                "Run `npm run fetch-reader`, or point the DIDASCALIE_BIOFORMATS environment \
                 variable at the program."
            } else {
                "Reinstall Didascalie, or point the DIDASCALIE_BIOFORMATS environment variable \
                 at the program."
            };
            AppError::Other(format!("Microscopy files need {PROGRAM}, which was not found. {hint}"))
        } else {
            AppError::Other(format!("Could not run {PROGRAM}: {e}"))
        }
    })?;
    if !output.status.success() {
        let last = last_error_line(&output.stderr);
        return Err(AppError::Other(last.trim_start_matches("error: ").to_string()));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| AppError::Other(format!("{PROGRAM} printed something that is not text")))
}

fn check_protocol(protocol: u32) -> Result<()> {
    if protocol == PROTOCOL {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "{PROGRAM} speaks version {protocol} of its protocol and this Didascalie needs \
             version {PROTOCOL}: reinstall Didascalie to get matching versions."
        )))
    }
}

/// Describe the series of a microscopy file.
pub fn inspect(path: &Path) -> Result<MicroscopyFile> {
    let out = run(&[OsString::from("inspect"), path.into()])?;
    parse_inspect(&out)
}

fn parse_inspect(json: &str) -> Result<MicroscopyFile> {
    // The protocol first: a mismatch says more than whatever else fails.
    #[derive(Deserialize)]
    struct Head {
        protocol: u32,
    }
    let head: Head = serde_json::from_str(json)
        .map_err(|e| AppError::Other(format!("Unexpected answer from {PROGRAM}: {e}")))?;
    check_protocol(head.protocol)?;
    let mut file: MicroscopyFile = serde_json::from_str(json)
        .map_err(|e| AppError::Other(format!("Unexpected answer from {PROGRAM}: {e}")))?;
    for series in &mut file.series {
        series.default_pick = SeriesPick::default_for(series);
    }
    Ok(file)
}

/// One frame written by [`export`]: a multi-page TIFF.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportedPlane {
    pub path: PathBuf,
    pub t: u32,
    /// None for a maximum projection over Z.
    pub z: Option<u32>,
    pub width: u32,
    pub height: u32,
}

/// Write the frames `pick` asks for into `out_dir`, in order: time, then Z.
pub fn export(path: &Path, pick: &SeriesPick, out_dir: &Path) -> Result<Vec<ExportedPlane>> {
    let mut args: Vec<OsString> = vec!["export".into(), path.into(), "--out".into(), out_dir.into()];
    for (flag, value) in [
        ("--series", pick.index.to_string()),
        ("--level", pick.level.to_string()),
        ("--z", pick.z.clone()),
        ("--t", pick.t.clone()),
        ("--c", pick.c.clone()),
    ] {
        args.push(flag.into());
        args.push(value.into());
    }
    parse_export(&run(&args)?)
}

fn parse_export(lines: &str) -> Result<Vec<ExportedPlane>> {
    #[derive(Deserialize)]
    struct Line {
        event: String,
        protocol: Option<u32>,
        path: Option<PathBuf>,
        t: Option<u32>,
        z: Option<serde_json::Value>,
        width: Option<u32>,
        height: Option<u32>,
    }
    let unexpected = |what: &str| AppError::Other(format!("Unexpected answer from {PROGRAM}: {what}"));
    let mut planes = Vec::new();
    let mut done = false;
    for text in lines.lines().filter(|l| !l.trim().is_empty()) {
        let line: Line = serde_json::from_str(text).map_err(|e| unexpected(&e.to_string()))?;
        match line.event.as_str() {
            "file" => planes.push(ExportedPlane {
                path: line.path.ok_or_else(|| unexpected("a file without a path"))?,
                t: line.t.ok_or_else(|| unexpected("a file without t"))?,
                z: line.z.as_ref().and_then(|z| z.as_u64()).map(|z| z as u32),
                width: line.width.ok_or_else(|| unexpected("a file without a width"))?,
                height: line.height.ok_or_else(|| unexpected("a file without a height"))?,
            }),
            "done" => {
                check_protocol(line.protocol.unwrap_or(0))?;
                done = true;
            }
            _ => {}
        }
    }
    if !done {
        return Err(unexpected("the export did not finish"));
    }
    Ok(planes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CZI: &str = r##"{"protocol":1,"file":"plate.czi","openMs":8.4,"hasOmeMetadata":true,"series":[
        {"index":0,"name":"plate.czi #1","width":672,"height":512,"sizeZ":21,"sizeC":3,"sizeT":1,
         "samplesPerPixel":1,"pixelType":"Uint16","bitsPerPixel":12,"sample":"u16",
         "dimensionOrder":"XYCZT","indexed":false,"thumbnail":false,
         "levels":[{"width":672,"height":512}],
         "physicalSizeUm":{"x":0.2,"y":0.2,"z":0.35},"timeIncrementS":null,"acquisitionDate":null,
         "channels":[
           {"source":0,"sample":0,"name":"TagYFP","color":"#ffff00","excitationNm":508.0,"emissionNm":524.0,"fluor":null,"contrastMethod":null},
           {"source":1,"sample":0,"name":"mRFP1.2","color":"#ff0500","excitationNm":590.0,"emissionNm":612.0,"fluor":null,"contrastMethod":null},
           {"source":2,"sample":0,"name":"TL DIC","color":"#b3b3b3","excitationNm":null,"emissionNm":null,"fluor":null,"contrastMethod":null}]},
        {"index":1,"error":"unsupported compression"}]}"##;

    #[test]
    fn inspect_output_parses() {
        let f = parse_inspect(CZI).unwrap();
        assert_eq!(f.series.len(), 2);
        let s = &f.series[0];
        assert_eq!((s.width, s.size_z, s.size_c, s.sample.as_str()), (672, 21, 3, "u16"));
        assert_eq!(s.channels[1].name.as_deref(), Some("mRFP1.2"));
        assert_eq!(s.physical_size_um.unwrap().z, Some(0.35));
        assert_eq!(f.series[1].error.as_deref(), Some("unsupported compression"));
        assert_eq!(s.default_pick.as_ref().map(|p| p.z.as_str()), Some("all"));
        assert_eq!(f.series[1].default_pick, None);
    }

    #[test]
    fn another_protocol_is_refused() {
        let err = parse_inspect(&CZI.replacen("\"protocol\":1", "\"protocol\":2", 1)).unwrap_err();
        assert!(err.to_string().contains("version 2"));
    }

    #[test]
    fn default_picks() {
        let f = parse_inspect(CZI).unwrap();
        let pick = SeriesPick::default_for(&f.series[0]).unwrap();
        assert_eq!((pick.level, pick.z.as_str(), pick.t.as_str()), (0, "all", "all"));
        assert_eq!(SeriesPick::default_for(&f.series[1]), None);

        // A deep stack becomes a projection; a slide a lower level.
        let mut deep = f.series[0].clone();
        deep.size_z = 200;
        deep.levels = vec![
            LevelSize { width: 90_000, height: 60_000 },
            LevelSize { width: 22_500, height: 15_000 },
            LevelSize { width: 5_625, height: 3_750 },
        ];
        let pick = SeriesPick::default_for(&deep).unwrap();
        assert_eq!((pick.level, pick.z.as_str()), (2, "max"));
        // Full size whenever it fits, however long a side.
        deep.levels = vec![
            LevelSize { width: 15_000, height: 12_000 },
            LevelSize { width: 3_750, height: 3_000 },
        ];
        assert_eq!(SeriesPick::default_for(&deep).unwrap().level, 0);
        deep.thumbnail = true;
        assert_eq!(SeriesPick::default_for(&deep), None);
    }

    #[test]
    fn channel_selection() {
        let f = parse_inspect(CZI).unwrap();
        let names = |c: &str| -> Vec<String> {
            picked_channels(&f.series[0], c).iter().filter_map(|ch| ch.name.clone()).collect()
        };
        assert_eq!(names("all").len(), 3);
        assert_eq!(names("0,2"), ["TagYFP", "TL DIC"]);
        assert_eq!(names("1-2"), ["mRFP1.2", "TL DIC"]);
    }

    #[test]
    fn export_output_parses() {
        let out = "{\"event\":\"file\",\"path\":\"o/s0_t0_z3.tif\",\"series\":0,\"t\":0,\"z\":3,\"width\":4,\"height\":2,\"channels\":3,\"sample\":\"u16\",\"bytes\":10}\n\
                   {\"event\":\"file\",\"path\":\"o/s0_t1_zmax.tif\",\"series\":0,\"t\":1,\"z\":\"max\",\"width\":4,\"height\":2,\"channels\":3,\"sample\":\"u16\",\"bytes\":10}\n\
                   {\"event\":\"done\",\"protocol\":1,\"files\":2,\"bytes\":20,\"ms\":1.0}\n";
        let planes = parse_export(out).unwrap();
        assert_eq!(planes.len(), 2);
        assert_eq!((planes[0].t, planes[0].z), (0, Some(3)));
        assert_eq!((planes[1].t, planes[1].z), (1, None));
        assert!(parse_export(&out[..out.find("{\"event\":\"done\"").unwrap()]).is_err());
    }

    #[test]
    fn microscopy_files_are_recognised() {
        assert!(is_microscopy(Path::new("a/b.CZI")));
        assert!(is_microscopy(Path::new("x.ome.tiff")));
        assert!(is_microscopy(Path::new("X.OME.TIF")));
        assert!(!is_microscopy(Path::new("plain.tif")));
        assert!(!is_microscopy(Path::new("photo.png")));
    }
}
