//! The bridge to the user's own Python functions, served by `didascalie.com`.
//!
//! Every command blocks on a socket while the user's function runs, so each
//! moves onto the blocking pool.
//!
//! Segmenting one frame returns the masks to the editor, which applies them as
//! one undo step. Segmenting a sequence writes straight to the project, like
//! propagation. In both, a layer returned for a named label replaces that
//! label; a single unnamed mask is painted onto the active label.
//!
//! A function sees a frame at full resolution: one the project holds at a
//! lower level of a microscopy file is read again from the file (see
//! `microscopy::native`), and the masks are scaled between the two sizes.

use ts_rs::TS;
use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::annotation::decode_to_uint8;
use crate::connection::inference::{load_frame_as_payload, timeout, Channel, InferenceClient};
use crate::connection::request::{
    ArgValues, FindKeypointsReply, ImagePayload, MaskPayloads, MasksReply, PingReply, Request, SeqRunReply,
    WireMask,
};
use crate::connection::types::ComError;
use crate::microscopy::native::{self, resample_mask, NativeFrames, Outcome};
use crate::storage::{queries, rle, DbState};
use crate::types::image::MaskEncoding;
use crate::utils::error::Result;
use crate::utils::AppError;

/// The peer's own words (a Python exception, a timeout) are the message.
fn bridge(e: ComError) -> AppError {
    AppError::Other(e.to_string())
}

async fn blocking<T, F>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Generic(e.to_string()))?
}

/// Ping `host:port` and adopt it as the endpoint if it answers. `probe` is
/// the background discovery poll, which gives up almost at once.
#[tauri::command]
pub async fn inference_connect(
    app: AppHandle,
    host: String,
    port: u16,
    probe: Option<bool>,
) -> Result<PingReply> {
    blocking(move || {
        let wait = if probe.unwrap_or(false) { timeout::PROBE } else { timeout::PING };
        app.state::<InferenceClient>().connect(&host, port, wait).map_err(bridge)
    })
    .await
}

#[tauri::command]
pub async fn find_keypoints_prefill(
    app: AppHandle,
    name: String,
    ref_frame_id: i64,
    mov_frame_id: i64,
    existing: Vec<[[f64; 2]; 2]>,
) -> Result<Vec<[[f64; 2]; 2]>> {
    blocking(move || {
        let db = app.state::<DbState>();
        let req = Request::FindKeypoints {
            name,
            r#ref: load_frame_as_payload(&db, ref_frame_id).map_err(bridge)?,
            mov: load_frame_as_payload(&db, mov_frame_id).map_err(bridge)?,
            existing,
        };
        let channel = app.state::<InferenceClient>().channel().map_err(bridge)?;
        let reply: FindKeypointsReply = channel.call(&req, timeout::KEYPOINTS).map_err(bridge)?;
        Ok(reply.pairs)
    })
    .await
}

// ── Segmentation ────────────────────────────────────────────────────────────

/// A project label as the editor lists it. Sent by the frontend so that the
/// order, which a `C×H×W` result is matched against, is the one the user sees.
#[derive(Deserialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/", rename = "PythonSegLabel")]
pub struct BridgeLabel {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub is_instance: bool,
}

/// What both segmentation commands need to know about the editor's state.
#[derive(Deserialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/", rename = "PythonSegContext")]
pub struct SegContext {
    pub labels: Vec<BridgeLabel>,
    #[ts(type = "number | null")]
    pub active_label_id: Option<i64>,
    /// Pixel value a stroke would write on the active label right now: the
    /// selected instance id, or 1.
    pub active_value: u8,
    /// Whether the function declared `masks`; they are only read and sent then.
    pub send_masks: bool,
    /// Values of the arguments the function declared.
    #[serde(default)]
    #[ts(type = "Record<string, number | boolean | string>")]
    pub args: ArgValues,
    /// The image adjustments to apply to each frame sent: 256 values for red,
    /// then green, then blue. Absent sends the frame as it is.
    #[serde(default)]
    #[ts(type = "number[] | null")]
    pub image_lut: Option<Vec<u8>>,
    /// Send a frame the project holds at a lower resolution level as the file
    /// has it. Off sends what the editor shows.
    #[serde(default = "full_resolution_by_default")]
    pub full_resolution: bool,
}

fn full_resolution_by_default() -> bool {
    true
}

impl SegContext {
    fn names(&self) -> Vec<String> {
        self.labels.iter().map(|l| l.name.clone()).collect()
    }

    fn active_name(&self) -> Option<String> {
        let id = self.active_label_id?;
        self.labels.iter().find(|l| l.id == id).map(|l| l.name.clone())
    }
}

/// Map interleaved RGB through `lut`, as the editor does on screen.
fn apply_lut(rgb: &mut [u8], lut: &[u8]) -> Result<()> {
    if lut.len() != 3 * 256 {
        return Err(AppError::Other(format!(
            "The image adjustments have {} values, expected 768",
            lut.len()
        )));
    }
    let (r, rest) = lut.split_at(256);
    let (g, b) = rest.split_at(256);
    for pixel in rgb.chunks_exact_mut(3) {
        pixel[0] = r[pixel[0] as usize];
        pixel[1] = g[pixel[1] as usize];
        pixel[2] = b[pixel[2] as usize];
    }
    Ok(())
}

/// A frame's size in the project, and as the function sees it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Geometry {
    stored: (u32, u32),
    sent: (u32, u32),
}

impl Geometry {
    fn same(size: (u32, u32)) -> Self {
        Self { stored: size, sent: size }
    }
}

/// The frames of a run at full resolution, when the context asks for it.
fn native_frames(db: &DbState, frame_ids: &[i64], ctx: &SegContext) -> Result<Option<NativeFrames>> {
    if !ctx.full_resolution {
        return Ok(None);
    }
    native::read(db, frame_ids).map(Some)
}

/// A frame as the function receives it, and its size.
fn frame_payload(
    db: &DbState,
    frame_id: i64,
    ctx: &SegContext,
    native: Option<&NativeFrames>,
) -> Result<(ImagePayload, Geometry)> {
    let stored = db.with_conn(|conn| queries::get_frame_dimensions(conn, frame_id))?;
    let (mut image, geometry) = match native.and_then(|n| n.get(frame_id)) {
        Some(Outcome::Finer(plane)) => {
            let bytes = std::fs::read(&plane.path)?;
            let picture = crate::commands::pixels::frame_picture(db, frame_id, &bytes, 0)?;
            drop(bytes);
            let (w, h) = (picture.width(), picture.height());
            let image = ImagePayload {
                buf: picture.into_rgb8().into_raw(),
                shape: vec![h as usize, w as usize, 3],
                dtype: "uint8".into(),
            };
            (image, Geometry { stored, sent: (w, h) })
        }
        _ => (load_frame_as_payload(db, frame_id).map_err(bridge)?, Geometry::same(stored)),
    };
    if let Some(lut) = &ctx.image_lut {
        apply_lut(&mut image.buf, lut)?;
    }
    Ok((image, geometry))
}

/// What to tell the user about the resolution the frames went at; None when
/// every frame went at full resolution.
fn resolution_note(native: Option<&NativeFrames>) -> Option<String> {
    let native = native?;
    let mut reduced = native.frames.values().filter_map(|o| match o {
        Outcome::Finer(p) if p.level > 0 => Some(p),
        _ => None,
    });
    let mut as_stored = native.frames.values().filter_map(|o| match o {
        Outcome::AsStored(reason) => Some(reason),
        _ => None,
    });
    let several = native.frames.len() > 1;
    if let Some(reason) = as_stored.next() {
        let count = 1 + as_stored.count();
        let what = if several { format!("{count} frames were") } else { "The frame was".into() };
        return Some(format!("{what} sent at the resolution the project holds: {reason}."));
    }
    let plane = reduced.next()?;
    let what = if several { "Frames were" } else { "The frame was" };
    Some(format!(
        "{what} sent at resolution level {} ({} × {}): level 0 is too large for one message.",
        plane.level, plane.width, plane.height
    ))
}

/// A returned mask, resolved against the project.
struct Layer {
    label_id: i64,
    /// Paint onto what exists instead of replacing it.
    additive: bool,
    mask: Vec<u8>,
}

/// A returned mask, at the size the project stores.
fn resolve(wire: WireMask, ctx: &SegContext, geometry: Geometry) -> Result<Layer> {
    let (width, height) = geometry.sent;
    if wire.shape != [height as usize, width as usize]
        || wire.buf.len() != width as usize * height as usize
    {
        return Err(AppError::Other(format!(
            "A returned mask is {:?}, the frame is [{height}, {width}]",
            wire.shape
        )));
    }

    let additive = wire.label.is_none();
    let label = match &wire.label {
        Some(name) => ctx.labels.iter().find(|l| &l.name == name),
        None => ctx.labels.iter().find(|l| Some(l.id) == ctx.active_label_id),
    }
    .ok_or_else(|| {
        AppError::Other(match &wire.label {
            Some(name) => format!("Unknown label {name:?}"),
            None => "The function returned a single mask, but no label is active".into(),
        })
    })?;

    let mut mask = wire.buf;
    if !label.is_instance {
        // A semantic layer only ever holds 1.
        mask.iter_mut().for_each(|v| *v = (*v > 0) as u8);
    } else if wire.binary {
        // An on/off mask on the active label paints the selected instance.
        let value = if additive { ctx.active_value.max(1) } else { 1 };
        mask.iter_mut().for_each(|v| *v = if *v > 0 { value } else { 0 });
    }
    let (w, h) = geometry.stored;
    let mask = resample_mask(&mask, width, height, w, h);
    Ok(Layer { label_id: label.id, additive, mask })
}

/// What is currently stored for `frame_id`, by label name, at the size the
/// frame is sent. Labels with nothing drawn are omitted.
fn current_masks(db: &DbState, frame_id: i64, ctx: &SegContext, geometry: Geometry) -> Result<MaskPayloads> {
    let ((width, height), (sent_w, sent_h)) = (geometry.stored, geometry.sent);
    db.with_conn(|conn| {
        let mut out = MaskPayloads::new();
        for a in queries::load_annotations(conn, frame_id)? {
            let Some(label) = ctx.labels.iter().find(|l| l.id == a.label_id) else { continue };
            let mask = decode_to_uint8(&a.mask_data, &a.encoding, width, height);
            let mask = resample_mask(&mask, width, height, sent_w, sent_h);
            out.insert(label.name.clone(), ImagePayload::mask(mask, sent_w, sent_h));
        }
        Ok(out)
    })
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/", rename = "PythonSegLayer")]
pub struct SegmentedLayer {
    #[ts(type = "number")]
    pub label_id: i64,
    pub additive: bool,
    /// Base64 uint8 mask at native resolution, holding the values to write,
    /// encoded as `rle8` (see `storage::rle`).
    pub rle8_base64: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/", rename = "PythonSegFrame")]
pub struct SegmentedFrame {
    pub layers: Vec<SegmentedLayer>,
    /// Label names the function returned that the project does not have.
    pub unknown_labels: Vec<String>,
    /// A message from the function, to show when the run ends.
    pub message: Option<String>,
    /// Set when the frame was not sent at full resolution, saying why.
    pub resolution_note: Option<String>,
}

/// Run a `@register_seg` function on one frame and hand the masks back. With
/// `send_masks`, the function sees what is stored, so the caller flushes
/// pending edits first.
#[tauri::command]
pub async fn python_segment_frame(
    app: AppHandle,
    name: String,
    frame_id: i64,
    frame_index: Option<usize>,
    context: SegContext,
) -> Result<SegmentedFrame> {
    blocking(move || {
        let db = app.state::<DbState>();
        let native = native_frames(&db, &[frame_id], &context)?;
        let (image, geometry) = frame_payload(&db, frame_id, &context, native.as_ref())?;
        let req = Request::Segment {
            name,
            image,
            labels: context.names(),
            active_label: context.active_name(),
            frame_index,
            masks: context
                .send_masks
                .then(|| current_masks(&db, frame_id, &context, geometry))
                .transpose()?,
            args: context.args.clone(),
            frame_name: db.with_conn(|conn| queries::frame_name(conn, frame_id))?,
        };

        let channel = app.state::<InferenceClient>().channel().map_err(bridge)?;
        let reply: MasksReply = channel.call(&req, timeout::SEGMENT).map_err(bridge)?;

        let layers = reply
            .masks
            .into_iter()
            .map(|wire| {
                let layer = resolve(wire, &context, geometry)?;
                Ok(SegmentedLayer {
                    label_id: layer.label_id,
                    additive: layer.additive,
                    rle8_base64: BASE64_STANDARD.encode(crate::storage::rle::encode8(&layer.mask)),
                })
            })
            .collect::<Result<_>>()?;
        Ok(SegmentedFrame {
            layers,
            unknown_labels: reply.unknown,
            message: reply.message,
            resolution_note: resolution_note(native.as_ref()),
        })
    })
    .await
}

#[derive(Serialize, Clone)]
struct SequenceProgress<'a> {
    /// "reading" | "sending" | "running" | "receiving"
    stage: &'a str,
    done: usize,
    total: usize,
}

#[derive(Serialize, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/", rename = "PythonSequenceReport")]
pub struct SequenceSegReport {
    /// Frames that received at least one mask.
    #[ts(type = "number[]")]
    pub applied: Vec<i64>,
    pub unknown_labels: Vec<String>,
    /// A message from the function, to show when the run ends.
    pub message: Option<String>,
    /// Set when frames were not sent at full resolution, saying why.
    pub resolution_note: Option<String>,
}

/// Run a `@register_sequence_seg` function over `frame_ids` and store what it
/// returns, in one transaction. Not undoable.
#[tauri::command]
pub async fn python_segment_sequence(
    app: AppHandle,
    name: String,
    frame_ids: Vec<i64>,
    current_frame_id: Option<i64>,
    context: SegContext,
) -> Result<SequenceSegReport> {
    blocking(move || {
        let channel = app.state::<InferenceClient>().channel().map_err(bridge)?;
        let result = segment_sequence(&app, &channel, name, &frame_ids, current_frame_id, &context);
        // Let Python drop the frames and masks it holds. On a fresh channel: after
        // an error the one above cannot send any more.
        if let Ok(end) = app.state::<InferenceClient>().channel() {
            let _ = end.send(&Request::SeqEnd, timeout::PING);
        }
        result
    })
    .await
}

fn segment_sequence(
    app: &AppHandle,
    channel: &Channel,
    name: String,
    frame_ids: &[i64],
    current_frame_id: Option<i64>,
    ctx: &SegContext,
) -> Result<SequenceSegReport> {
    let db = app.state::<DbState>();
    let total = frame_ids.len();
    let progress = |stage: &str, done: usize| {
        let _ = app.emit("python-seg-progress", SequenceProgress { stage, done, total });
    };

    let frame_name = match current_frame_id.filter(|id| frame_ids.contains(id)) {
        Some(id) => db.with_conn(|conn| queries::frame_name(conn, id))?,
        None => None,
    };
    let begin = Request::SeqBegin {
        name,
        n_frames: total,
        labels: ctx.names(),
        active_label: ctx.active_name(),
        frame_index: current_frame_id.and_then(|id| frame_ids.iter().position(|&f| f == id)),
        args: ctx.args.clone(),
        frame_name,
    };
    // Before the session opens: reading a file again can take a while.
    progress("reading", 0);
    let native = native_frames(&db, frame_ids, ctx)?;
    channel.send(&begin, timeout::PING).map_err(bridge)?;

    let mut geometries = Vec::with_capacity(total);
    for (index, &frame_id) in frame_ids.iter().enumerate() {
        progress("sending", index);
        let (image, geometry) = frame_payload(&db, frame_id, ctx, native.as_ref())?;
        geometries.push(geometry);
        let frame = Request::SeqFrame {
            index,
            image,
            masks: ctx
                .send_masks
                .then(|| current_masks(&db, frame_id, ctx, geometry))
                .transpose()?,
        };
        channel.send(&frame, timeout::TRANSFER).map_err(bridge)?;
    }

    progress("running", 0);
    let run: SeqRunReply = channel.call(&Request::SeqRun, timeout::SEQUENCE).map_err(bridge)?;

    // (frame, label, rle8) rows, kept encoded so a long sequence stays small.
    let mut rows: Vec<(i64, i64, Vec<u8>)> = Vec::new();
    let mut report = SequenceSegReport {
        unknown_labels: run.unknown,
        message: run.message,
        resolution_note: resolution_note(native.as_ref()),
        ..Default::default()
    };
    drop(native);

    for (index, &frame_id) in frame_ids.iter().enumerate() {
        progress("receiving", index);
        let reply: MasksReply =
            channel.call(&Request::SeqResult { index }, timeout::TRANSFER).map_err(bridge)?;
        if reply.masks.is_empty() {
            continue;
        }
        let geometry = geometries[index];
        let (width, height) = geometry.stored;
        for wire in reply.masks {
            let mut layer = resolve(wire, ctx, geometry)?;
            if layer.additive {
                paint_over_stored(&db, frame_id, width, height, &mut layer)?;
            }
            rows.push((frame_id, layer.label_id, rle::encode8(&layer.mask)));
        }
        report.applied.push(frame_id);
    }

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for (frame_id, label_id, encoded) in &rows {
            queries::save_annotation(conn, *frame_id, *label_id, encoded, MaskEncoding::Rle8)?;
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(report)
}

/// The full mask to store for an additive layer: what is there, with the
/// returned pixels painted on top.
fn paint_over_stored(
    db: &DbState,
    frame_id: i64,
    width: u32,
    height: u32,
    layer: &mut Layer,
) -> Result<()> {
    let stored = db.with_conn(|conn| {
        Ok(queries::load_annotations(conn, frame_id)?
            .into_iter()
            .find(|a| a.label_id == layer.label_id)
            .map(|a| decode_to_uint8(&a.mask_data, &a.encoding, width, height)))
    })?;
    if let Some(stored) = stored {
        for (new, old) in layer.mask.iter_mut().zip(stored) {
            if *new == 0 {
                *new = old;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> SegContext {
        SegContext {
            labels: vec![
                BridgeLabel { id: 10, name: "vessel".into(), is_instance: false },
                BridgeLabel { id: 20, name: "cell".into(), is_instance: true },
            ],
            active_label_id: Some(20),
            active_value: 5,
            send_masks: false,
            args: ArgValues::new(),
            image_lut: None,
            full_resolution: true,
        }
    }

    fn g(width: u32, height: u32) -> Geometry {
        Geometry::same((width, height))
    }

    fn wire(label: Option<&str>, buf: Vec<u8>, binary: bool) -> WireMask {
        WireMask { label: label.map(Into::into), buf, shape: vec![1, 3], binary }
    }

    #[test]
    fn semantic_labels_collapse_to_one() {
        let layer = resolve(wire(Some("vessel"), vec![0, 7, 255], false), &ctx(), g(3, 1)).unwrap();
        assert_eq!((layer.label_id, layer.additive), (10, false));
        assert_eq!(layer.mask, vec![0, 1, 1]);
    }

    #[test]
    fn unnamed_binary_mask_paints_the_active_instance() {
        let layer = resolve(wire(None, vec![0, 1, 1], true), &ctx(), g(3, 1)).unwrap();
        assert_eq!((layer.label_id, layer.additive), (20, true));
        assert_eq!(layer.mask, vec![0, 5, 5]);
    }

    #[test]
    fn instance_ids_are_kept() {
        let layer = resolve(wire(Some("cell"), vec![0, 2, 9], false), &ctx(), g(3, 1)).unwrap();
        assert_eq!(layer.mask, vec![0, 2, 9]);
        // Named, so it replaces: an on/off mask there is instance 1.
        let layer = resolve(wire(Some("cell"), vec![0, 1, 1], true), &ctx(), g(3, 1)).unwrap();
        assert_eq!(layer.mask, vec![0, 1, 1]);
    }

    #[test]
    fn the_adjustments_map_each_channel_through_its_own_table() {
        let mut lut = Vec::with_capacity(768);
        lut.extend((0..=255u8).map(|v| 255 - v)); // red: inverted
        lut.extend(0..=255u8); // green: unchanged
        lut.extend(std::iter::repeat_n(9u8, 256)); // blue: constant
        let mut rgb = vec![10, 20, 30, 200, 100, 0];
        apply_lut(&mut rgb, &lut).unwrap();
        assert_eq!(rgb, vec![245, 20, 9, 55, 100, 9]);
        assert!(apply_lut(&mut rgb, &lut[1..]).is_err());
    }

    #[test]
    fn a_frame_is_named_by_its_path_or_else_its_sequence() {
        let conn = queries::create_database(std::path::Path::new(":memory:")).unwrap();
        conn.execute_batch(
            "INSERT INTO sequences (id, name) VALUES (1, 'visit');
             INSERT INTO frames (id, sequence_id, frame_index, relative_path, width, height)
             VALUES (7, 1, 0, 'sub/a.png', 1, 1), (8, 1, 1, NULL, 1, 1);",
        )
        .unwrap();
        assert_eq!(queries::frame_name(&conn, 7).unwrap().as_deref(), Some("sub/a.png"));
        assert_eq!(queries::frame_name(&conn, 8).unwrap().as_deref(), Some("visit"));
    }

    #[test]
    fn a_mask_at_full_resolution_is_stored_at_the_project_size() {
        // Sent at 6 × 2, stored at 3 × 1.
        let geometry = Geometry { stored: (3, 1), sent: (6, 2) };
        let mut w = wire(Some("cell"), vec![0, 0, 4, 4, 7, 7, 0, 0, 4, 4, 7, 7], false);
        w.shape = vec![2, 6];
        assert_eq!(resolve(w, &ctx(), geometry).unwrap().mask, vec![0, 4, 7]);
        // A mask at the stored size is refused.
        assert!(resolve(wire(Some("cell"), vec![0, 1, 1], false), &ctx(), geometry).is_err());
    }

    #[test]
    fn wrong_size_and_missing_target_are_errors() {
        assert!(resolve(wire(Some("vessel"), vec![0, 1, 1], true), &ctx(), g(4, 1)).is_err());
        assert!(resolve(wire(Some("nope"), vec![0, 1, 1], true), &ctx(), g(3, 1)).is_err());
        let mut no_active = ctx();
        no_active.active_label_id = None;
        assert!(resolve(wire(None, vec![0, 1, 1], true), &no_active, g(3, 1)).is_err());
    }
}
