//! Video files as a source of frames, decoded by an `ffmpeg` executable.
//!
//! A video is never unpacked: the project keeps one `frames` row per imported
//! frame, holding its presentation time, and decodes it on demand. An
//! annotation is tied to a row, so a row must always decode to the same
//! picture:
//!
//! - Frames are addressed by time, from an index of the file. [`probe`] lists
//!   every packet's presentation time without decoding; the n-th frame is the
//!   n-th smallest, B-frames and variable frame rates included.
//! - Frames are picked by their time, not by where a seek lands. ffmpeg seeks
//!   to a keyframe by decoding time, and a B-frame shown just before a
//!   keyframe is stored after it. So the seek aims earlier by `seek_preroll`,
//!   and a `select` filter keeps the frames within `seek_margin` of the times
//!   asked for.
//! - Containers ffmpeg cannot seek exactly are refused: MPEG-TS/PS are not in
//!   [`EXTENSIONS`], and [`probe`] rejects packets without a presentation
//!   time.
//!
//! Decoding is in software, with bit-exact colour conversion, so the pixels
//! do not depend on the machine.
//!
//! Starting ffmpeg is slow and each further frame of a run is fast, so frames
//! read in order are decoded in runs, into a cache (see [`read_run`]), as BMP.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Condvar, Mutex};

use once_cell::sync::Lazy;

use crate::utils::error::{AppError, Result};

/// Containers whose frames can be addressed exactly. Lower case, no dot.
pub const EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "mkv", "webm", "avi"];

pub fn is_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

#[derive(Debug, Clone)]
pub struct VideoIndex {
    /// Presentation time of every frame, in seconds, ascending. Frame `n` of
    /// the video is `times[n]`.
    pub times: Vec<f64>,
    /// Tolerance when matching a decoded frame to a time: a quarter of the
    /// shortest gap between two frames.
    pub seek_margin: f64,
    /// How much earlier than a frame decoding must start to be sure to get it.
    pub seek_preroll: f64,
    /// Average frame rate, for display.
    pub fps: f64,
    /// Size of the decoded picture (after any rotation the file asks for).
    pub width: u32,
    pub height: u32,
}

/// The `ffmpeg` to run: `DIDASCALIE_FFMPEG` if set, else the one shipped next
/// to the application, else whatever `PATH` resolves.
fn ffmpeg_path() -> PathBuf {
    if let Some(path) = std::env::var_os("DIDASCALIE_FFMPEG") {
        return PathBuf::from(path);
    }
    let name = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
    if let Some(bundled) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(&name)))
        .filter(|p| p.is_file())
    {
        return bundled;
    }
    PathBuf::from(name)
}

fn ffmpeg_command(args: &[OsString]) -> Command {
    let mut command = Command::new(ffmpeg_path());
    command
        .args(["-hide_banner", "-nostdin", "-v", "error"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Without this, every call flashes a console window on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn spawn_error(e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        AppError::Other(
            "Video support needs ffmpeg, which was not found. Install it, or point \
             the DIDASCALIE_FFMPEG environment variable at the executable."
                .into(),
        )
    } else {
        AppError::Other(format!("Could not run ffmpeg: {}", e))
    }
}

/// The last line ffmpeg wrote to stderr: with `-v error`, what went wrong.
fn last_error_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines().last().unwrap_or("unknown error").trim().to_string()
}

fn run_ffmpeg(args: &[OsString]) -> Result<Vec<u8>> {
    let output = ffmpeg_command(args).output().map_err(spawn_error)?;
    if !output.status.success() {
        return Err(AppError::Other(format!("ffmpeg failed: {}", last_error_line(&output.stderr))));
    }
    Ok(output.stdout)
}

/// Index the frames of `path`. Reads the whole file once, without decoding.
pub fn probe(path: &Path) -> Result<VideoIndex> {
    // The `framecrc` muxer prints one line per packet with its timestamps,
    // without decoding, relative to the start of the file like `-ss`.
    let mut args = vec![OsString::from("-i"), path.into()];
    args.extend(["-map", "0:v:0", "-c", "copy", "-f", "framecrc", "-"].map(OsString::from));
    let listing = run_ffmpeg(&args)?;
    let (times, seek_margin, seek_preroll) =
        parse_packet_times(&String::from_utf8_lossy(&listing))?;

    let first = run_ffmpeg(&frame_args(path, &times[..1], true, seek_margin, seek_preroll))?;
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(&first))
        .with_guessed_format()
        .map_err(AppError::Io)?
        .into_dimensions()?;

    let span = times[times.len() - 1] - times[0];
    let fps = if span > 0.0 { (times.len() - 1) as f64 / span } else { 0.0 };
    Ok(VideoIndex { times, seek_margin, seek_preroll, fps, width, height })
}

/// Frame times, seek margin and seek pre-roll from a `framecrc` listing: a
/// `#tb 0: num/den` header, then per packet `stream, dts, pts, duration,
/// size, crc` in decoding order.
fn parse_packet_times(listing: &str) -> Result<(Vec<f64>, f64, f64)> {
    let mut time_base: Option<f64> = None;
    let mut ticks: Vec<i64> = Vec::new();
    // The longest a frame is shown after it is decoded.
    let mut reorder: i64 = 0;

    for line in listing.lines() {
        if let Some(header) = line.strip_prefix("#tb 0:") {
            let (num, den) = header.trim().split_once('/').unwrap_or(("", ""));
            if let (Ok(num), Ok(den)) = (num.parse::<f64>(), den.parse::<f64>()) {
                if num > 0.0 && den > 0.0 {
                    time_base = Some(num / den);
                }
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let mut fields = line.split(',').skip(1).map(|f| f.trim().parse::<i64>().ok());
        let (Some(dts), Some(Some(pts))) = (fields.next(), fields.next()) else {
            continue;
        };
        // ffmpeg prints a missing timestamp as i64::MIN.
        if pts == i64::MIN {
            return Err(AppError::Other(
                "this video has frames without a presentation time, so they cannot be \
                 addressed reliably. Re-encode it (for instance to MP4/H.264) first."
                    .into(),
            ));
        }
        // Frames before the start of the file are decoder pre-roll.
        if pts >= 0 {
            ticks.push(pts);
        }
        if let Some(dts) = dts.filter(|&dts| dts != i64::MIN) {
            reorder = reorder.max(pts.saturating_sub(dts));
        }
    }

    let time_base =
        time_base.ok_or_else(|| AppError::Other("no video stream could be read".into()))?;
    ticks.sort_unstable();
    ticks.dedup();
    if ticks.is_empty() {
        return Err(AppError::Other("this video has no frames".into()));
    }

    let min_gap = ticks.windows(2).map(|w| w[1] - w[0]).min().unwrap_or(1).max(1);
    let times = ticks.iter().map(|&t| t as f64 * time_base).collect();
    Ok((times, min_gap as f64 * time_base / 4.0, reorder as f64 * time_base))
}

/// Arguments decoding the frames of `path` shown at `times` (seconds,
/// ascending) to a stream of 24-bit BMP images. `consecutive`: no frame of
/// the video lies between them.
fn frame_args(
    path: &Path,
    times: &[f64],
    consecutive: bool,
    seek_margin: f64,
    seek_preroll: f64,
) -> Vec<OsString> {
    // Before `-i`, `-ss` seeks to a keyframe and decodes forward; frame times
    // are then counted from the seek point.
    let seek = format!("{:.6}", (times[0] - seek_margin - seek_preroll).max(0.0));
    let origin: f64 = seek.parse().unwrap_or(0.0);
    let select = if consecutive {
        format!("gte(t,{:.6})", times[0] - origin - seek_margin)
    } else {
        let wanted: Vec<String> = times
            .iter()
            .map(|t| format!("between(t,{:.6},{:.6})", t - origin - seek_margin, t - origin + seek_margin))
            .collect();
        wanted.join("+")
    };

    let mut args: Vec<OsString> = vec!["-ss".into(), seek.into(), "-i".into(), path.into()];
    args.extend(["-map".into(), "0:v:0".into()]);
    // The image output repeats a frame to fill a gap in time. Renumbering the
    // kept frames 0, 1, 2… seconds at one frame per second leaves no gap.
    args.extend(["-vf".into(), format!("select='{}',setpts=N/TB", select).into()]);
    args.extend(["-r".into(), "1".into()]);
    args.extend(["-frames:v".into(), times.len().to_string().into()]);
    args.extend(
        [
            // The same pixels on every machine and ffmpeg build.
            "-sws_flags", "bitexact",
            // What BMP stores, so that nothing is converted twice.
            "-pix_fmt", "bgr24",
            "-f", "image2pipe", "-c:v", "bmp", "-",
        ]
        .map(OsString::from),
    );
    args
}

/// Read one image from a stream of BMP files, or `None` at its end. A BMP
/// starts with `BM` and its own length.
fn read_bmp(stream: &mut impl Read) -> Option<Vec<u8>> {
    let mut image = vec![0u8; 6];
    stream.read_exact(&mut image).ok()?;
    if &image[..2] != b"BM" {
        return None;
    }
    let length = u32::from_le_bytes([image[2], image[3], image[4], image[5]]) as usize;
    if length < image.len() {
        return None;
    }
    image.resize(length, 0);
    stream.read_exact(&mut image[6..]).ok()?;
    Some(image)
}

// ── Decoded frames: cache and runs ─────────────────────────────────────────

/// A frame of a file: its path and its time in microseconds. Not a frame id,
/// which restarts in every project.
type FrameKey = (PathBuf, i64);

fn frame_key(path: &Path, time: f64) -> FrameKey {
    (path.to_path_buf(), (time * 1e6).round() as i64)
}

/// Recently decoded frames, and the ones being decoded right now.
#[derive(Default)]
struct Frames {
    map: HashMap<FrameKey, Vec<u8>>,
    order: VecDeque<FrameKey>,
    bytes: usize,
    /// Frames a running ffmpeg is about to deliver: wanted ones are waited for.
    pending: HashSet<FrameKey>,
}

impl Frames {
    fn insert(&mut self, key: FrameKey, image: Vec<u8>) {
        if self.map.contains_key(&key) {
            return;
        }
        self.bytes += image.len();
        self.map.insert(key.clone(), image);
        self.order.push_back(key);
        while self.bytes > FRAME_CACHE_BYTES && self.order.len() > 1 {
            if let Some(old) = self.order.pop_front() {
                if let Some(dropped) = self.map.remove(&old) {
                    self.bytes -= dropped.len();
                }
            }
        }
    }
}

const FRAME_CACHE_BYTES: usize = 512 * 1024 * 1024;
/// Frames decoded in one go, at most.
const MAX_RUN_FRAMES: usize = 32;
/// How far into the video a run may reach, in frames. Frames in between that
/// the project does not hold are decoded and dropped.
const MAX_RUN_SPAN: usize = 256;

static FRAMES: Lazy<(Mutex<Frames>, Condvar)> = Lazy::new(Default::default);

/// A frame to decode along with the one being asked for.
#[derive(Debug, Clone, Copy)]
pub struct RunFrame {
    pub time: f64,
    /// Its rank among the frames of the video.
    pub video_frame: usize,
}

/// How many frames of `width`×`height` one run may hold, so that a run fits
/// in the cache several times over.
pub fn run_length(width: u32, height: u32) -> usize {
    let frame_bytes = (width as usize * height as usize * 3).max(1);
    (FRAME_CACHE_BYTES / 4 / frame_bytes).clamp(1, MAX_RUN_FRAMES)
}

/// Whether [`read_run`] would answer for this frame without decoding.
pub fn is_cached(path: &Path, time: f64) -> bool {
    FRAMES.0.lock().is_ok_and(|frames| frames.map.contains_key(&frame_key(path, time)))
}

/// Decode `frame`, as a BMP image, and `ahead` with it. Returns as soon as
/// `frame` is decoded; the frames of `ahead` keep landing in the cache from
/// the same ffmpeg process.
pub fn read_run(
    path: &Path,
    seek_margin: f64,
    seek_preroll: f64,
    frame: RunFrame,
    ahead: &[RunFrame],
) -> Result<Vec<u8>> {
    let (lock, landed) = &*FRAMES;
    let key = frame_key(path, frame.time);

    let mut frames = lock.lock().map_err(|_| AppError::Other("video cache poisoned".into()))?;
    loop {
        if let Some(hit) = frames.map.get(&key) {
            return Ok(hit.clone());
        }
        if !frames.pending.contains(&key) {
            break;
        }
        // Another run is about to deliver it. If that run fails, this call decodes
        // it.
        frames = landed.wait(frames).map_err(|_| AppError::Other("video cache poisoned".into()))?;
    }

    // Decode it, with whatever of `ahead` is neither cached nor pending.
    let mut members = vec![(frame, key)];
    for next in ahead.iter().take(MAX_RUN_FRAMES - 1) {
        let Some(offset) = next.video_frame.checked_sub(frame.video_frame) else { break };
        if offset == 0 || offset > MAX_RUN_SPAN {
            break;
        }
        let key = frame_key(path, next.time);
        if !frames.map.contains_key(&key) && !frames.pending.contains(&key) {
            members.push((*next, key));
        }
    }
    for (_, key) in &members {
        frames.pending.insert(key.clone());
    }
    drop(frames);

    let (first_tx, first_rx) = mpsc::channel();
    let consecutive =
        members.iter().enumerate().all(|(i, (member, _))| member.video_frame == frame.video_frame + i);
    let times: Vec<f64> = members.iter().map(|(member, _)| member.time).collect();
    let args = frame_args(path, &times, consecutive, seek_margin, seek_preroll);
    let keys: Vec<FrameKey> = members.into_iter().map(|(_, key)| key).collect();
    let (time, path) = (frame.time, path.to_path_buf());
    std::thread::spawn(move || {
        let outcome = decode_run(&args, Expected { keys: keys.into() }, &first_tx);
        // Only reaches a caller still waiting, i.e. one whose frame never came.
        let _ = first_tx.send(Err(outcome.err().unwrap_or_else(|| {
            AppError::Other(format!("No frame at {:.3} s in {}", time, path.display()))
        })));
    });
    first_rx.recv().unwrap_or_else(|_| Err(AppError::Other("video decoding stopped".into())))
}

/// The frames a run has yet to deliver. Dropping it gives up on those left,
/// so nobody waits for a frame that will not come.
struct Expected {
    keys: VecDeque<FrameKey>,
}

impl Drop for Expected {
    fn drop(&mut self) {
        let (lock, landed) = &*FRAMES;
        if let Ok(mut frames) = lock.lock() {
            for key in &self.keys {
                frames.pending.remove(key);
            }
        }
        landed.notify_all();
    }
}

/// Run ffmpeg and file each image it writes under the next expected key. The
/// first one is also sent to `first`.
fn decode_run(
    args: &[OsString],
    mut expected: Expected,
    first: &mpsc::Sender<Result<Vec<u8>>>,
) -> Result<()> {
    let (lock, landed) = &*FRAMES;
    let mut child = ffmpeg_command(args).spawn().map_err(spawn_error)?;
    let mut stdout = std::io::BufReader::new(child.stdout.take().expect("stdout is piped"));
    // Drained on the side: a full stderr pipe would block ffmpeg.
    let stderr = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut text = Vec::new();
            let _ = pipe.read_to_end(&mut text);
            text
        })
    });

    let mut sent_first = false;
    while !expected.keys.is_empty() {
        let Some(image) = read_bmp(&mut stdout) else { break };
        if !sent_first {
            sent_first = true;
            let _ = first.send(Ok(image.clone()));
        }
        if let Ok(mut frames) = lock.lock() {
            let key = expected.keys.pop_front().expect("checked non-empty");
            frames.pending.remove(&key);
            frames.insert(key, image);
        }
        landed.notify_all();
    }
    // Closing the pipe ends an ffmpeg that still had something to write.
    drop(stdout);

    let status = child.wait();
    let errors = stderr.and_then(|reader| reader.join().ok()).unwrap_or_default();
    match status {
        Ok(status) if status.success() || sent_first => Ok(()),
        _ => Err(AppError::Other(format!("ffmpeg failed: {}", last_error_line(&errors)))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_videos_by_extension() {
        assert!(is_video(Path::new("a/clip.mp4")));
        assert!(is_video(Path::new("CLIP.MKV")));
        assert!(!is_video(Path::new("a/frame.png")));
        assert!(!is_video(Path::new("stream.ts")));
        assert!(!is_video(Path::new("mp4")));
    }

    #[test]
    fn a_stream_of_bmp_images_is_split_on_their_own_lengths() {
        let bmp = |payload: &[u8]| {
            let mut image = b"BM".to_vec();
            image.extend(((6 + payload.len()) as u32).to_le_bytes());
            image.extend(payload);
            image
        };
        let (a, b) = (bmp(&[1, 2, 3]), bmp(&[]));
        let stream = [a.clone(), b.clone(), b"BM\x09".to_vec()].concat();
        let mut reader = std::io::Cursor::new(stream);
        assert_eq!(read_bmp(&mut reader), Some(a));
        assert_eq!(read_bmp(&mut reader), Some(b));
        assert_eq!(read_bmp(&mut reader), None, "a truncated image is not one");
    }

    #[test]
    fn frames_are_selected_by_time_counted_from_an_earlier_seek() {
        let text = |args: Vec<OsString>| -> Vec<String> {
            args.iter().map(|a| a.to_string_lossy().to_string()).collect()
        };
        let clip = Path::new("clip.mp4");
        let consecutive = text(frame_args(clip, &[2.0, 2.1, 2.2], true, 0.025, 0.2));
        assert!(consecutive.windows(2).any(|w| w == ["-ss", "1.775000"]));
        assert!(consecutive.windows(2).any(|w| w == ["-vf", "select='gte(t,0.200000)',setpts=N/TB"]));
        assert!(consecutive.windows(2).any(|w| w == ["-frames:v", "3"]));

        let sparse = text(frame_args(clip, &[0.0, 0.4], false, 0.025, 0.2));
        assert!(sparse.windows(2).any(|w| w == ["-ss", "0.000000"]), "never before the start");
        assert!(sparse.windows(2).any(|w| w
            == ["-vf", "select='between(t,-0.025000,0.025000)+between(t,0.375000,0.425000)',setpts=N/TB"]));
    }

    #[test]
    fn a_run_fits_in_the_cache_several_times() {
        assert_eq!(run_length(640, 480), MAX_RUN_FRAMES);
        let uhd = run_length(3840, 2160);
        assert!((2..MAX_RUN_FRAMES).contains(&uhd), "{uhd}");
        assert_eq!(run_length(100_000, 100_000), 1);
    }

    #[test]
    fn frames_are_ordered_by_presentation_time() {
        // Decoding order with B-frames: pts 0, 2048, 1024, 512, 1536.
        let listing = "#tb 0: 1/15360\n#media_type 0: video\n\
            0,      -1024,          0,      512,     6232, 0xc564a8e7\n\
            0,       -512,       2048,      512,      649, 0x1ed43064, F=0x0\n\
            0,          0,       1024,      512,      111, 0x1ecb3126, F=0x0\n\
            0,        512,        512,      512,       74, 0x4dd72211, F=0x0\n\
            0,       1024,       1536,      512,       75, 0x426320ee, F=0x0\n";
        let (times, margin, preroll) = parse_packet_times(listing).unwrap();
        assert_eq!(times.len(), 5);
        assert!(times.windows(2).all(|w| w[0] < w[1]));
        assert!((times[1] - 512.0 / 15360.0).abs() < 1e-12);
        assert!((margin - 128.0 / 15360.0).abs() < 1e-12);
        // The second packet is decoded at -512 and shown at 2048.
        assert!((preroll - 2560.0 / 15360.0).abs() < 1e-12);
    }

    #[test]
    fn pre_roll_and_duplicate_packets_are_not_frames() {
        let listing = "#tb 0: 1/30\n\
            0, -1, -1, 1, 10, 0x0\n\
            0,  0,  0, 1, 10, 0x0\n\
            0,  1,  1, 1, 10, 0x0\n\
            0,  1,  1, 1, 10, 0x0\n";
        let (times, _, preroll) = parse_packet_times(listing).unwrap();
        assert_eq!(times, vec![0.0, 1.0 / 30.0]);
        assert_eq!(preroll, 0.0);
    }

    #[test]
    fn a_video_without_presentation_times_is_refused() {
        let listing = "#tb 0: 1001/30000\n\
            0, 0, -9223372036854775808, 1, 8210, 0xcd2681e4\n\
            0, 2, 2, 1, 338, 0x830d832a, F=0x0\n";
        assert!(parse_packet_times(listing).is_err());
    }

    #[test]
    fn an_empty_listing_is_an_error() {
        assert!(parse_packet_times("").is_err());
        assert!(parse_packet_times("#tb 0: 1/30\n").is_err());
    }
}
