//! Tauri commands of the segmentation-head lab.
//!
//! Long-running commands are `#[tauri::command(async)]`: a plain command runs
//! on the main thread and would freeze the window. Their bodies stay
//! synchronous; progress goes out as `ml-progress` / `ml-train-progress` events.

use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::dl::model_manager::ensure_model_cached;
use crate::storage::{queries, DbState};

use super::dataset::{self, DatasetConfig};
use super::filters;
use super::encoder::EncoderSession;
use super::persist;
use super::predict::{self, MlState, PredictedFrame, ScribbleInput, TrainedModel};
use super::registry;
use super::scribble::Rng;
use super::train::{self, Samples, TrainConfig};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderStatus {
    #[serde(flatten)]
    pub spec: registry::EncoderSpec,
    pub cached: bool,
}

#[tauri::command]
pub fn ml_list_encoders(app: AppHandle) -> Vec<EncoderStatus> {
    registry::catalog()
        .into_iter()
        .map(|spec| {
            let cached = registry::is_cached(&app, &spec);
            EncoderStatus { spec, cached }
        })
        .collect()
}

/// Fetch an encoder's weights. Progress arrives on `download-progress`.
#[tauri::command]
pub async fn ml_download_encoder(app: AppHandle, encoder_id: String) -> Result<String, String> {
    let spec = registry::find(&encoder_id)
        .ok_or_else(|| format!("unknown encoder '{encoder_id}'"))?;
    // Every sidecar must arrive too: `ort` resolves external weights relative to
    // the graph.
    let mut graph_path = None;
    for cfg in spec.all_model_configs() {
        let path = ensure_model_cached(&app, &cfg).await?;
        graph_path.get_or_insert(path);
    }
    let path = graph_path.ok_or_else(|| format!("encoder '{encoder_id}' declares no files"))?;
    Ok(path.to_string_lossy().to_string())
}

/// What the project currently offers the trainer.
// Not `rename_all = "camelCase"`: the frontend reads the snake_case fields.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSummary {
    /// Annotated and reviewed.
    pub annotated_frames: usize,
    /// Annotated but not reviewed, so excluded.
    pub unreviewed_frames: usize,
    pub labels: usize,
    /// Every label plus background.
    pub classes: usize,
}

#[tauri::command]
pub fn ml_dataset_summary(db: State<DbState>) -> Result<DatasetSummary, String> {
    let frames = dataset::annotated_frame_ids(&db)?;
    let labels = dataset::label_order(&db)?;
    Ok(DatasetSummary {
        annotated_frames: frames.len(),
        unreviewed_frames: dataset::annotated_unreviewed_count(&db)?,
        labels: labels.len(),
        classes: labels.len() + 1,
    })
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainOptions {
    /// Omit to train on the local feature basis alone.
    pub encoder_id: Option<String>,
    pub working_size: Option<u32>,
    pub patches_per_frame: Option<usize>,
    /// Persist encoder features between runs. Defaults to on.
    pub cache_features: Option<bool>,
    /// Labels to train on. Omit for every label in the project.
    pub label_ids: Option<Vec<i64>>,
    pub augment_repeats: Option<usize>,
    pub epochs: Option<usize>,
    pub hidden: Option<usize>,
    pub depth: Option<usize>,
    pub val_fraction: Option<f32>,
    pub seed: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    stage: &'a str,
    done: usize,
    total: usize,
    /// Milliseconds spent on the most recent frame.
    last_ms: f32,
    eta_ms: f32,
}

/// The ETA uses `avg_ms`: per-frame cost varies several-fold between training
/// and validation frames.
fn emit_avg(app: &AppHandle, stage: &str, done: usize, total: usize, last_ms: f32, avg_ms: f32) {
    let eta_ms = if done > 0 {
        avg_ms * total.saturating_sub(done) as f32
    } else {
        0.0
    };
    let _ = app.emit(
        "ml-progress",
        Progress {
            stage,
            done,
            total,
            last_ms,
            eta_ms,
        },
    );
}

fn emit(app: &AppHandle, stage: &str, done: usize, total: usize, last_ms: f32) {
    emit_avg(app, stage, done, total, last_ms, last_ms);
}

/// Everything a fit needs, built once for the sweep and a single run alike.
struct Split {
    per_frame: Vec<Samples>,
    val: Samples,
    order: Vec<i64>,
    classes: usize,
    feature_dim: usize,
    val_frames: usize,
}

/// Open (or reuse) the encoder a run asks for.
fn ensure_encoder(
    app: &AppHandle,
    state: &MlState,
    encoder_id: &Option<String>,
) -> Result<(), String> {
    let Some(id) = encoder_id else { return Ok(()) };
    let mut slot = state.encoder.lock();
    if slot.as_ref().map(|(cached, _)| cached == id).unwrap_or(false) {
        return Ok(());
    }
    let spec = registry::find(id).ok_or_else(|| format!("unknown encoder '{id}'"))?;
    let path = registry::cache_path(app, &spec)?;
    if !path.exists() {
        return Err(format!(
            "encoder '{id}' is not downloaded yet — fetch it first"
        ));
    }
    *slot = Some((id.clone(), EncoderSession::load(&path, spec)?));
    Ok(())
}

/// Largest patches-per-frame that keeps the sample table inside a memory
/// budget. The table is dense `f32`:
/// `patches * repeats * frames * (d + 1) * PATCH^2 * 4` bytes. The budget is a
/// fraction of the memory available, not installed.
fn patch_budget(requested: usize, frames: usize, repeats: usize, feature_dim: usize) -> usize {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let available = sys.available_memory();
    let cap = cap_for_budget(available, requested, frames, repeats, feature_dim);
    if cap < requested {
        log::info!(
            "[ml] patches/frame {requested} -> {cap}: only {} MB free",
            available / 1_048_576
        );
    }
    cap
}

/// The arithmetic of [`patch_budget`]. `available` is bytes of free RAM; 0
/// means unknown.
fn cap_for_budget(
    available: u64,
    requested: usize,
    frames: usize,
    repeats: usize,
    feature_dim: usize,
) -> usize {
    if available == 0 || frames == 0 {
        return requested; // Unknown memory: trust the user rather than guess.
    }
    // A third: the training tensors and the rest of the app need room.
    let budget = available / 3;
    let per_patch = ((feature_dim + 1) * Samples::patch_pixels() * 4) as u64;
    let cost_per_unit = per_patch * (repeats.max(1) * frames) as u64;
    if cost_per_unit == 0 {
        return requested;
    }
    // Never zero, which would give a silently empty dataset.
    ((budget / cost_per_unit).max(1) as usize).min(requested)
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    fn per_patch(d: usize) -> u64 {
        ((d + 1) * Samples::patch_pixels() * 4) as u64
    }

    #[test]
    fn a_roomy_machine_gets_what_it_asked_for() {
        assert_eq!(cap_for_budget(64 << 30, 8, 20, 3, 410), 8);
    }

    #[test]
    fn a_small_machine_is_capped_below_the_request() {
        let cap = cap_for_budget(4 << 30, 8, 20, 3, 410);
        assert!(cap < 8, "expected a cap below the request, got {cap}");
        assert!(cap >= 1);
        let table = per_patch(410) * (3 * 20) as u64 * cap as u64;
        assert!(table <= (4u64 << 30) / 3, "capped table still exceeds budget");
    }

    #[test]
    fn the_cap_never_reaches_zero() {
        assert_eq!(cap_for_budget(1 << 20, 8, 500, 3, 410), 1);
    }

    #[test]
    fn unknown_memory_defers_to_the_user() {
        assert_eq!(cap_for_budget(0, 24, 20, 3, 410), 24);
    }

    #[test]
    fn a_narrow_feature_stack_affords_more_patches() {
        let wide = cap_for_budget(8 << 30, 64, 20, 3, 410);
        let narrow = cap_for_budget(8 << 30, 64, 20, 3, 27);
        assert!(narrow > wide, "narrow={narrow} should exceed wide={wide}");
    }
}

fn build_split(
    app: &AppHandle,
    db: &DbState,
    state: &MlState,
    options: &TrainOptions,
) -> Result<Split, String> {
    let frames = dataset::annotated_frame_ids(db)?;
    let mut order = dataset::label_order(&db)?;
    if order.is_empty() {
        return Err("this project defines no segmentation labels".into());
    }
    if let Some(wanted) = options.label_ids.as_ref().filter(|w| !w.is_empty()) {
        // Project order, not request order: class index is position + 1.
        order.retain(|id| wanted.contains(id));
        if order.is_empty() {
            return Err("none of the selected labels exist in this project".into());
        }
    }
    if frames.len() < 2 {
        return Err(format!(
            "need at least 2 annotated frames to hold one out; found {}",
            frames.len()
        ));
    }
    let classes = order.len() + 1;
    let seed = options.seed.unwrap_or(0);

    // Deterministic frame-level split.
    let mut shuffled = frames.clone();
    let mut split_rng = Rng::new(seed ^ 0x5F1D_2E3C_4B5A_6978);
    for i in 0..shuffled.len() {
        let j = i + split_rng.below(shuffled.len() - i);
        shuffled.swap(i, j);
    }
    let val_fraction = options.val_fraction.unwrap_or(0.3).clamp(0.1, 0.5);
    let n_val = ((shuffled.len() as f32 * val_fraction).round() as usize).clamp(1, shuffled.len() - 1);
    let (val_ids, train_ids) = shuffled.split_at(n_val);

    // Feature width is known before any frame is built, so the budget is exact.
    let colour_channels = 3; // assume colour: the wider, safer case
    let local_dim = filters::FilterBankConfig::default().output_channels(colour_channels);
    let encoder_dim = options
        .encoder_id
        .as_deref()
        .and_then(registry::find)
        .map(|s| s.embed_dim)
        .unwrap_or(0);
    let est_dim = local_dim + encoder_dim + crate::commands::ml::scribble::SCRIBBLE_CHANNELS;
    let repeats = options.augment_repeats.unwrap_or(3).max(1);
    let requested_patches = patch_budget(
        options.patches_per_frame.unwrap_or(8),
        train_ids.len(),
        repeats,
        est_dim,
    );

    let ds = DatasetConfig {
        working_size: options.working_size.unwrap_or(384),
        patches_per_frame: requested_patches,
        cache_writes: options.cache_features.unwrap_or(true),
        repeats: options.augment_repeats.unwrap_or(3).max(1),
        ..Default::default()
    };

    // Always read; writing is gated by `cache_writes`.
    let feature_cache = super::cache::cache_dir(app).ok();

    ensure_encoder(app, state, &options.encoder_id)?;
    let mut guard = state.encoder.lock();
    let mut encoder = if options.encoder_id.is_some() {
        guard.as_mut().map(|(_, e)| e)
    } else {
        None
    };

    let total = shuffled.len();
    let mut done = 0usize;
    let mut spent_ms = 0.0f32;

    // Validation frames carry no augmentation and no scribbles: simulated strokes
    // come from the ground truth the frame is scored against.
    let val_cfg = DatasetConfig {
        repeats: 1,
        scribble_strokes: 0,
        scribble_dropout: 0.0,
        ..ds.clone()
    };
    super::cache::reset_stats();
    let mut val = Samples::new(0);
    let mut feature_dim = 0usize;
    for &fid in val_ids {
        let t0 = std::time::Instant::now();
        let mut rng = Rng::new(seed ^ (fid as u64).wrapping_mul(0x9E37));
        let s = dataset::build_frame_samples(db, fid, &order, &val_cfg, encoder.as_deref_mut(), feature_cache.as_deref(), &mut rng)?;
        let ms = t0.elapsed().as_secs_f32() * 1000.0;
        if s.n > 0 {
            if val.n == 0 {
                val = Samples::new(s.d);
                feature_dim = s.d;
            }
            val.extend(&s);
        }
        done += 1;
        spent_ms += ms;
        log::info!("[ml] features val frame {fid} — {ms:.0} ms ({done}/{total})");
        emit_avg(app, "features", done, total, ms, spent_ms / done as f32);
    }

    let mut per_frame: Vec<Samples> = Vec::new();
    for &fid in train_ids {
        let t0 = std::time::Instant::now();
        let mut rng = Rng::new(seed ^ (fid as u64).wrapping_mul(0x1F123));
        let s = dataset::build_frame_samples(db, fid, &order, &ds, encoder.as_deref_mut(), feature_cache.as_deref(), &mut rng)?;
        let ms = t0.elapsed().as_secs_f32() * 1000.0;
        if s.n > 0 {
            feature_dim = s.d;
            per_frame.push(s);
        }
        done += 1;
        spent_ms += ms;
        log::info!("[ml] features train frame {fid} — {ms:.0} ms ({done}/{total})");
        emit_avg(app, "features", done, total, ms, spent_ms / done as f32);
    }

    let (hits, misses) = super::cache::stats();
    if hits + misses > 0 {
        log::info!("[ml] cache — {hits} entries reused, {misses} computed");
    }

    if per_frame.is_empty() {
        return Err("no usable training frames (annotations may vanish at this working size)".into());
    }
    if val.is_empty() {
        return Err("no usable validation frames".into());
    }

    Ok(Split {
        per_frame,
        val,
        order,
        classes,
        feature_dim,
        val_frames: val_ids.len(),
    })
}

fn train_config(options: &TrainOptions) -> TrainConfig {
    TrainConfig {
        hidden: options.hidden.unwrap_or(TrainConfig::default().hidden),
        depth: options.depth.unwrap_or(TrainConfig::default().depth),
        epochs: options.epochs.unwrap_or(40),
        ..Default::default()
    }
}

fn emit_train(app: &AppHandle, p: train::TrainProgress) {
    let _ = app.emit(
        "ml-train-progress",
        TrainTick {
            budget: p.budget,
            repeat: p.repeat,
            epoch: p.epoch,
            epochs: p.epochs,
            loss: p.loss,
            point: p.point,
            points: p.points,
            epoch_ms: p.epoch_ms,
            elapsed_ms: p.elapsed_ms,
            eta_ms: p.eta_ms,
            // The encoder (ort) and the head (burn) choose their device independently.
            device: format!(
                "head {} · encoder {}",
                p.device,
                super::encoder::detect_accelerator()
            ),
            samples: p.samples,
            features: p.features,
        },
    );
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainTick {
    budget: usize,
    repeat: usize,
    epoch: usize,
    epochs: usize,
    loss: f32,
    point: usize,
    points: usize,
    epoch_ms: f32,
    elapsed_ms: f32,
    eta_ms: f32,
    device: String,
    samples: usize,
    features: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainSummary {
    pub train_frames: usize,
    pub val_frames: usize,
    pub feature_dim: usize,
    pub classes: usize,
    pub encoder: Option<String>,
    pub metrics: train::EvalMetrics,
    /// Where the head was fitted.
    pub device: String,
}

/// Fit one head on every training frame and keep it for prediction.
#[tauri::command(async)]
pub fn ml_train_model(
    app: AppHandle,
    db: State<DbState>,
    state: State<MlState>,
    options: TrainOptions,
) -> Result<TrainSummary, String> {
    // A stop requested against a previous run must not cancel this one.
    state.cancel.store(false, Ordering::Relaxed);
    let mut split = build_split(&app, &db, &state, &options)?;
    // Move each frame's patches into the pooled table and drop it, to avoid
    // holding the dataset twice. Read the count before draining.
    let train_frames = split.per_frame.len();
    let mut all = Samples::new(split.feature_dim);
    for s in std::mem::take(&mut split.per_frame) {
        all.extend(&s);
    }

    let (head, metrics) = train::train_head_with(
        &all,
        &split.val,
        split.classes,
        &train_config(&options),
        &|| state.cancel.load(Ordering::Relaxed),
        &mut |p| emit_train(&app, p),
    )?;

    let summary = TrainSummary {
        train_frames,
        val_frames: split.val_frames,
        feature_dim: split.feature_dim,
        classes: split.classes,
        encoder: options.encoder_id.clone(),
        metrics: metrics.clone(),
        device: head.device().to_string(),
    };

    let cfg = train_config(&options);
    let model = TrainedModel {
        head,
        feature_dim: split.feature_dim,
        classes: split.classes,
        label_order: split.order,
        encoder_id: options.encoder_id.clone(),
        working_size: options.working_size.unwrap_or(384),
        metrics,
        train_frames,
    };

    // A failed save does not fail the run: the model is still usable this session.
    if let Err(e) = store_model(&db, &model, cfg.hidden, cfg.depth) {
        log::warn!("[ml] could not save the model to the project: {e}");
    }
    *state.model.lock() = Some(model);

    Ok(summary)
}

fn store_model(
    db: &DbState,
    model: &TrainedModel,
    hidden: usize,
    depth: usize,
) -> Result<(), String> {
    let meta = persist::ModelMeta {
        feature_dim: model.feature_dim,
        classes: model.classes,
        label_order: model.label_order.clone(),
        encoder_id: model.encoder_id.clone(),
        working_size: model.working_size,
        hidden,
        depth,
        accuracy: model.metrics.accuracy,
        mean_dice: model.metrics.mean_dice,
        per_class_dice: model.metrics.per_class_dice.clone(),
        train_frames: model.train_frames,
        trained_on: model.head.device().to_string(),
    };
    let json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let weights = persist::encode_head(&model.head)?;
    let bytes = weights.len();
    db.with_conn(|conn| queries::save_ml_model(conn, &json, &weights))
        .map_err(|e| e.to_string())?;
    log::info!("[ml] model saved to the project ({} KB)", bytes / 1024);
    Ok(())
}

/// Restore the head stored in the open project, if any. A model this build
/// cannot read is not an error.
#[tauri::command]
pub fn ml_load_saved_model(db: State<DbState>, state: State<MlState>) -> Option<TrainSummary> {
    let stored = db.with_conn(|conn| queries::load_ml_model(conn)).ok()??;
    let (json, weights) = stored;
    let meta: persist::ModelMeta = match serde_json::from_str(&json) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("[ml] stored model metadata is unreadable ({e}); ignoring it");
            return None;
        }
    };
    let head = match persist::decode_head(weights, &meta) {
        Ok(h) => h,
        Err(e) => {
            log::warn!("[ml] stored model could not be loaded ({e}); ignoring it");
            return None;
        }
    };

    let summary = TrainSummary {
        train_frames: meta.train_frames,
        val_frames: 0,
        feature_dim: meta.feature_dim,
        classes: meta.classes,
        encoder: meta.encoder_id.clone(),
        metrics: meta.metrics(),
        device: head.device().to_string(),
    };
    log::info!(
        "[ml] restored a saved model — {} classes, trained on {} images",
        meta.classes, meta.train_frames
    );
    let metrics = meta.metrics();
    *state.model.lock() = Some(TrainedModel {
        head,
        feature_dim: meta.feature_dim,
        classes: meta.classes,
        label_order: meta.label_order,
        encoder_id: meta.encoder_id,
        working_size: meta.working_size,
        metrics,
        train_frames: meta.train_frames,
    });
    Some(summary)
}

/// Discard the saved model, from the project and this session.
#[tauri::command]
pub fn ml_forget_model(db: State<DbState>, state: State<MlState>) -> Result<bool, String> {
    *state.model.lock() = None;
    db.with_conn(|conn| queries::delete_ml_model(conn))
        .map_err(|e| e.to_string())
}

/// Ask the running fit to stop at the next epoch boundary. The weights it has
/// are scored and stored like any completed run.
#[tauri::command]
pub fn ml_stop_training(state: State<MlState>) {
    state.cancel.store(true, Ordering::Relaxed);
    log::info!("[ml] stop requested — finishing the current epoch");
}

/// What Didascalie keeps in local app data: features and encoder weights.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub feature_bytes: u64,
    pub feature_files: usize,
    pub model_bytes: u64,
    pub cache_dir: String,
}

#[tauri::command]
pub fn ml_storage_usage(app: AppHandle) -> Result<StorageUsage, String> {
    let features = super::cache::cache_dir(&app)?;
    let models = super::cache::models_dir(&app)?;
    let (feature_bytes, feature_files) = super::cache::usage(&features);
    Ok(StorageUsage {
        feature_bytes,
        feature_files,
        model_bytes: super::cache::dir_size(&models),
        cache_dir: features.to_string_lossy().to_string(),
    })
}

/// Delete every cached feature tensor. Encoder weights are kept.
#[tauri::command]
pub fn ml_clear_feature_cache(app: AppHandle) -> Result<usize, String> {
    let dir = super::cache::cache_dir(&app)?;
    let n = super::cache::clear(&dir);
    log::info!("[ml] cleared {n} cached feature tensors");
    Ok(n)
}

#[tauri::command]
pub fn ml_model_status(state: State<MlState>) -> Option<TrainSummary> {
    state.model.lock().as_ref().map(|m| TrainSummary {
        train_frames: m.train_frames,
        val_frames: 0,
        feature_dim: m.feature_dim,
        classes: m.classes,
        encoder: m.encoder_id.clone(),
        metrics: m.metrics.clone(),
        device: m.head.device().to_string(),
    })
}

/// Apply the loaded head to one frame, optionally conditioned on scribbles.
#[tauri::command(async)]
pub fn ml_predict_frame(
    app: AppHandle,
    db: State<DbState>,
    state: State<MlState>,
    frame_id: i64,
    scribbles: Option<ScribbleInput>,
) -> Result<PredictedFrame, String> {
    let guard = state.model.lock();
    let model = guard
        .as_ref()
        .ok_or_else(|| "no trained head yet — train one first".to_string())?;

    ensure_encoder(&app, &state, &model.encoder_id)?;
    let mut enc_guard = state.encoder.lock();
    let encoder = if model.encoder_id.is_some() {
        enc_guard.as_mut().map(|(_, e)| e)
    } else {
        None
    };

    let mut features = state.features.lock();
    predict::predict_frame(
        &db,
        model,
        frame_id,
        encoder,
        &mut features,
        scribbles.as_ref(),
        &|stage, done, total| emit(&app, stage, done, total, 0.0),
    )
}
