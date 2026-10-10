//! The bridge to the user's own Python functions, served by `didascalie.com`.
//!
//! Every command blocks on a socket while the user's function runs, so each
//! moves onto the blocking pool.
//!
//! Segmenting one frame returns the masks to the editor, which applies them as
//! one undo step. Segmenting a sequence writes straight to the project, like
//! propagation. In both, a layer returned for a named label replaces that
//! label; a single unnamed mask is painted onto the active label.

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::annotation::decode_to_uint8;
use crate::connection::inference::{load_frame_as_payload, timeout, Channel, InferenceClient};
use crate::connection::request::{
    FindKeypointsReply, ImagePayload, MaskPayloads, MasksReply, PingReply, Request, SeqRunReply,
    WireMask,
};
use crate::connection::types::ComError;
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
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLabel {
    pub id: i64,
    pub name: String,
    pub is_instance: bool,
}

/// What both segmentation commands need to know about the editor's state.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SegContext {
    pub labels: Vec<BridgeLabel>,
    pub active_label_id: Option<i64>,
    /// Pixel value a stroke would write on the active label right now: the
    /// selected instance id, or 1.
    pub active_value: u8,
    /// Whether the function declared `masks`; they are only read and sent then.
    pub send_masks: bool,
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

/// A returned mask, resolved against the project.
struct Layer {
    label_id: i64,
    /// Paint onto what exists instead of replacing it.
    additive: bool,
    mask: Vec<u8>,
}

fn resolve(wire: WireMask, ctx: &SegContext, width: u32, height: u32) -> Result<Layer> {
    if wire.shape != [height as usize, width as usize] || wire.buf.len() != (width * height) as usize
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
    Ok(Layer { label_id: label.id, additive, mask })
}

/// What is currently stored for `frame_id`, by label name, as the function
/// asked for it. Labels with nothing drawn are omitted.
fn current_masks(db: &DbState, frame_id: i64, ctx: &SegContext) -> Result<MaskPayloads> {
    db.with_conn(|conn| {
        let (width, height) = queries::get_frame_dimensions(conn, frame_id)?;
        let mut out = MaskPayloads::new();
        for a in queries::load_annotations(conn, frame_id)? {
            let Some(label) = ctx.labels.iter().find(|l| l.id == a.label_id) else { continue };
            let mask = decode_to_uint8(&a.mask_data, &a.encoding, width, height);
            out.insert(label.name.clone(), ImagePayload::mask(mask, width, height));
        }
        Ok(out)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentedLayer {
    pub label_id: i64,
    pub additive: bool,
    /// Base64 uint8 mask at native resolution, holding the values to write.
    pub mask_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentedFrame {
    pub layers: Vec<SegmentedLayer>,
    /// Label names the function returned that the project does not have.
    pub unknown_labels: Vec<String>,
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
        let (width, height) = db.with_conn(|conn| queries::get_frame_dimensions(conn, frame_id))?;
        let req = Request::Segment {
            name,
            image: load_frame_as_payload(&db, frame_id).map_err(bridge)?,
            labels: context.names(),
            active_label: context.active_name(),
            frame_index,
            masks: context
                .send_masks
                .then(|| current_masks(&db, frame_id, &context))
                .transpose()?,
        };

        let channel = app.state::<InferenceClient>().channel().map_err(bridge)?;
        let reply: MasksReply = channel.call(&req, timeout::SEGMENT).map_err(bridge)?;

        let layers = reply
            .masks
            .into_iter()
            .map(|wire| {
                let layer = resolve(wire, &context, width, height)?;
                Ok(SegmentedLayer {
                    label_id: layer.label_id,
                    additive: layer.additive,
                    mask_base64: BASE64_STANDARD.encode(&layer.mask),
                })
            })
            .collect::<Result<_>>()?;
        Ok(SegmentedFrame { layers, unknown_labels: reply.unknown })
    })
    .await
}

#[derive(Serialize, Clone)]
struct SequenceProgress<'a> {
    /// "sending" | "running" | "receiving"
    stage: &'a str,
    done: usize,
    total: usize,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SequenceSegReport {
    /// Frames that received at least one mask.
    pub applied: Vec<i64>,
    pub unknown_labels: Vec<String>,
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

    let begin = Request::SeqBegin {
        name,
        n_frames: total,
        labels: ctx.names(),
        active_label: ctx.active_name(),
        frame_index: current_frame_id.and_then(|id| frame_ids.iter().position(|&f| f == id)),
    };
    channel.send(&begin, timeout::PING).map_err(bridge)?;

    for (index, &frame_id) in frame_ids.iter().enumerate() {
        progress("sending", index);
        let frame = Request::SeqFrame {
            index,
            image: load_frame_as_payload(&db, frame_id).map_err(bridge)?,
            masks: ctx.send_masks.then(|| current_masks(&db, frame_id, ctx)).transpose()?,
        };
        channel.send(&frame, timeout::TRANSFER).map_err(bridge)?;
    }

    progress("running", 0);
    let run: SeqRunReply = channel.call(&Request::SeqRun, timeout::SEQUENCE).map_err(bridge)?;

    // (frame, label, rle8) rows, kept encoded so a long sequence stays small.
    let mut rows: Vec<(i64, i64, Vec<u8>)> = Vec::new();
    let mut report = SequenceSegReport { unknown_labels: run.unknown, ..Default::default() };

    for (index, &frame_id) in frame_ids.iter().enumerate() {
        progress("receiving", index);
        let reply: MasksReply =
            channel.call(&Request::SeqResult { index }, timeout::TRANSFER).map_err(bridge)?;
        if reply.masks.is_empty() {
            continue;
        }
        let (width, height) = db.with_conn(|conn| queries::get_frame_dimensions(conn, frame_id))?;
        for wire in reply.masks {
            let mut layer = resolve(wire, ctx, width, height)?;
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
        }
    }

    fn wire(label: Option<&str>, buf: Vec<u8>, binary: bool) -> WireMask {
        WireMask { label: label.map(Into::into), buf, shape: vec![1, 3], binary }
    }

    #[test]
    fn semantic_labels_collapse_to_one() {
        let layer = resolve(wire(Some("vessel"), vec![0, 7, 255], false), &ctx(), 3, 1).unwrap();
        assert_eq!((layer.label_id, layer.additive), (10, false));
        assert_eq!(layer.mask, vec![0, 1, 1]);
    }

    #[test]
    fn unnamed_binary_mask_paints_the_active_instance() {
        let layer = resolve(wire(None, vec![0, 1, 1], true), &ctx(), 3, 1).unwrap();
        assert_eq!((layer.label_id, layer.additive), (20, true));
        assert_eq!(layer.mask, vec![0, 5, 5]);
    }

    #[test]
    fn instance_ids_are_kept() {
        let layer = resolve(wire(Some("cell"), vec![0, 2, 9], false), &ctx(), 3, 1).unwrap();
        assert_eq!(layer.mask, vec![0, 2, 9]);
        // Named, so it replaces: an on/off mask there is instance 1.
        let layer = resolve(wire(Some("cell"), vec![0, 1, 1], true), &ctx(), 3, 1).unwrap();
        assert_eq!(layer.mask, vec![0, 1, 1]);
    }

    #[test]
    fn wrong_size_and_missing_target_are_errors() {
        assert!(resolve(wire(Some("vessel"), vec![0, 1, 1], true), &ctx(), 4, 1).is_err());
        assert!(resolve(wire(Some("nope"), vec![0, 1, 1], true), &ctx(), 3, 1).is_err());
        let mut no_active = ctx();
        no_active.active_label_id = None;
        assert!(resolve(wire(None, vec![0, 1, 1], true), &no_active, 3, 1).is_err());
    }
}
