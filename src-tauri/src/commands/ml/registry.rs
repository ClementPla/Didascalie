//! Catalog of pretrained encoders that can back the trainable segmentation
//! head, plus their download / cache management.
//!
//! Didascalie is modality-agnostic, so the catalog deliberately favours
//! *general* backbones over organ- or modality-specific ones: the same project
//! may hold CT slices, ultrasound, pathology tiles or colour photographs, and a
//! backbone tuned to one of those is a liability on the rest. Specialisation is
//! the head's job, not the encoder's.
//!
//! Selection criteria (see `docs/literature-review-fewshot-scribble.md`):
//!
//! * **Must ship ONNX.** The app runs encoders through `ort`; a PyTorch-only
//!   checkpoint would need a one-time Python export, which breaks the
//!   self-contained story. Every built-in entry below was verified to expose a
//!   `.onnx` file on the Hub.
//! * **Frozen.** The encoder is never fine-tuned here — only the head trains —
//!   so no gradient ever crosses back into these weights.
//! * **Dense features.** We need patch tokens, not a pooled class vector.
//!
//! Many domain-specific foundation models (retinal, pathology, chest) are
//! *gated* on the Hub and publish safetensors only, so they can be neither
//! click-downloaded nor loaded by `ort`. Rather than special-casing them, the
//! registry accepts a user-supplied local `.onnx` path: export once, point the
//! app at the file, and it participates like any built-in entry.

use serde::{Deserialize, Serialize};

use crate::dl::model_manager::ModelConfig;

/// How pixel values must be scaled before entering a given graph. Getting this
/// wrong does not error — it silently degrades the features — so it is recorded
/// per encoder rather than assumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Normalization {
    /// Plain `[0, 1]`, as the bundled SAM-style encoder expects.
    Unit,
    /// `[0, 1]` then ImageNet mean/std — what the `transformers` image
    /// processors apply for DINOv2 and most Hub ViTs.
    ImageNet,
}

impl Normalization {
    /// Per-channel `(mean, std)` to apply after scaling into `[0, 1]`.
    pub fn mean_std(self) -> ([f32; 3], [f32; 3]) {
        match self {
            Normalization::Unit => ([0.0; 3], [1.0; 3]),
            Normalization::ImageNet => ([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        }
    }
}

/// A pretrained encoder the user can download and use as a frozen backbone.
///
/// The numeric fields are *hints* used for display and for sizing buffers
/// before the graph is opened. The real input/output shapes are read from the
/// ONNX graph itself at load time (see `encoder.rs`), so a wrong hint here
/// degrades a label in the UI rather than corrupting inference.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderSpec {
    /// Stable identifier used by the frontend and persisted in run metadata.
    pub id: String,
    pub name: String,
    pub description: String,
    /// Hugging Face repo, e.g. `onnx-community/dinov2-small-ONNX`.
    pub repo_id: String,
    /// Path of the ONNX file *within* the repo (may contain `/`).
    pub filename: String,
    /// Sidecar files that must be downloaded alongside `filename`.
    ///
    /// Graphs over the 2 GB protobuf limit — and, in practice, anything
    /// exported by `optimum` with `use_external_data_format` — keep their
    /// weights in a separate `.onnx_data` blob. `ort` resolves that blob by the
    /// *relative path recorded inside the graph*, so the sidecar has to land in
    /// the same directory under its exact name or the session opens against a
    /// weightless graph.
    #[serde(default)]
    pub aux_files: Vec<String>,
    /// Sub-directory under the app cache where the file is stored.
    pub cache_subdir: String,
    /// ViT patch stride: the token grid is `input_size / patch` per side.
    /// This is the resolution ceiling that motivates mixing in the
    /// full-resolution classical filter bank.
    pub patch: u32,
    /// Channel count of the patch-token embedding (hint; verified at load).
    pub embed_dim: usize,
    /// Square input the graph expects (hint; verified at load).
    pub input_size: u32,
    /// Approximate download size, for the UI.
    pub approx_mb: u32,
    /// Short provenance tag shown in the picker ("general", "medical", …).
    pub domain: String,
    /// Pixel scaling this graph was trained with.
    pub normalize: Normalization,
}

impl EncoderSpec {
    fn new(
        id: &str,
        name: &str,
        description: &str,
        repo_id: &str,
        filename: &str,
        cache_subdir: &str,
        patch: u32,
        embed_dim: usize,
        input_size: u32,
        approx_mb: u32,
        domain: &str,
        normalize: Normalization,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            repo_id: repo_id.into(),
            filename: filename.into(),
            aux_files: Vec::new(),
            cache_subdir: cache_subdir.into(),
            patch,
            embed_dim,
            input_size,
            approx_mb,
            domain: domain.into(),
            normalize,
        }
    }

    /// Declare weight sidecars that must sit next to the graph.
    fn with_aux(mut self, files: &[&str]) -> Self {
        self.aux_files = files.iter().map(|f| (*f).to_string()).collect();
        self
    }

    /// Descriptors for every file this encoder needs, graph first.
    ///
    /// Callers must fetch all of them: a cached graph whose sidecar is missing
    /// looks downloaded but fails at session open, which is a far more
    /// confusing failure than an incomplete download.
    pub fn all_model_configs(&self) -> Vec<ModelConfig> {
        std::iter::once(self.filename.clone())
            .chain(self.aux_files.iter().cloned())
            .map(|f| self.config_for(&f))
            .collect()
    }

    fn config_for(&self, filename: &str) -> ModelConfig {
        ModelConfig {
            repo_id: self.repo_id.clone(),
            filename: filename.to_string(),
            cache_subdir: self.cache_subdir.clone(),
            // Sizes/hashes are not pinned: these are third-party mirrors that
            // may be re-exported upstream. The download is still verified for
            // completeness against Content-Length.
            expected_size: None,
            expected_sha256: None,
        }
    }
}

/// The built-in encoder catalog, best default first.
///
/// DINOv3 leads because of *Gram anchoring*: DINOv2's patch-level features
/// degrade over long training even as its global features improve, and DINOv3
/// adds a loss term specifically to stop that. Dense prediction is exactly the
/// use that suffered, so the upgrade matters more here than the headline
/// benchmark numbers suggest.
///
/// Note the licence difference — DINOv2 is Apache-2.0, DINOv3 ships under
/// Meta's own licence. That is a distribution question for whoever packages
/// Didascalie, not a technical one, so both generations stay available.
///
/// # Why there is no DINOv3 ConvNeXt entry
///
/// Its convolutional distillations would suit large frames — cost linear in
/// pixels rather than quadratic in tokens — but every `onnx-community` export
/// (tiny, small, base, large alike) is unloadable: the dynamo exporter captured
/// the stage loop as a real ONNX `Loop` over a tensor *sequence*, and ORT's
/// type inference rejects the `Concat` inside it, which binds `int64` and
/// `float` to the same type parameter. That is a defect in the published file,
/// not something a loader can route around, so the entries were removed rather
/// than shipped as buttons that fail on click. A re-export with
/// `dynamo=False` would produce a usable graph; until one exists, ViT it is.
pub fn catalog() -> Vec<EncoderSpec> {
    vec![
        EncoderSpec::new(
            "dinov3-vits16",
            "DINOv3 ViT-S/16",
            "Recommended default. Gram-anchored dense features — the property \
             DINOv2 lacks — at stride 16, run at 512px for a 32x32 grid. Uses \
             rotary position embeddings, so unlike DINOv2 it extrapolates to \
             resolutions it was not trained at without interpolating position \
             tables.",
            "onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX",
            "onnx/model.onnx",
            "dinov3-vits16",
            16,
            384,
            512,
            87,
            "general",
            Normalization::ImageNet,
        )
        .with_aux(&["onnx/model.onnx_data"]),
        EncoderSpec::new(
            "dinov2-small",
            "DINOv2 ViT-S/14",
            "Self-supervised general-purpose features that transfer broadly \
             across modalities. The fastest option and a good default. Patch \
             stride 14 caps its spatial detail, so sub-patch structure is \
             carried by the local feature basis instead.",
            "onnx-community/dinov2-small-ONNX",
            "onnx/model.onnx",
            "dinov2-small",
            14,
            384,
            224,
            88,
            "general",
            Normalization::ImageNet,
        ),
        EncoderSpec::new(
            "dinov2-base",
            "DINOv2 ViT-B/14",
            "Larger DINOv2. Richer semantics than ViT-S at roughly 4x the \
             compute; worth testing once the small model's curve is known.",
            "onnx-community/dinov2-base-ONNX",
            "onnx/model.onnx",
            "dinov2-base",
            14,
            768,
            224,
            330,
            "general",
            Normalization::ImageNet,
        ),
        EncoderSpec::new(
            "doodlemask-sam",
            "DoodleMask SAM encoder",
            "The SAM-style encoder this app already ships for doodle-to-mask. \
             Medical-tuned and produces a denser 64x64 grid, but is the \
             heaviest of the three.",
            "ClementP/DoodleMaskSAM",
            "encoder.onnx",
            "maskedMedSAM",
            16,
            256,
            1024,
            368,
            "medical",
            Normalization::Unit,
        ),
    ]
}

/// Look up a spec by its stable id.
pub fn find(id: &str) -> Option<EncoderSpec> {
    catalog().into_iter().find(|s| s.id == id)
}

/// Where an encoder's weights live once downloaded.
///
/// Mirrors the layout `dl::model_manager` writes to, so the two agree without
/// the downloader having to hand a path back.
pub fn cache_path(
    app: &tauri::AppHandle,
    spec: &EncoderSpec,
) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve cache dir: {e}"))?;
    Ok(cache
        .join("models")
        .join(&spec.cache_subdir)
        .join(&spec.filename))
}

/// Whether the weights are already on disk (drives the UI's Download button).
///
/// Every file is checked, not just the graph: an encoder whose `.onnx_data` is
/// missing would otherwise report itself ready and then fail at session open.
pub fn is_cached(app: &tauri::AppHandle, spec: &EncoderSpec) -> bool {
    let Ok(graph) = cache_path(app, spec) else {
        return false;
    };
    let Some(dir) = graph.parent() else {
        return false;
    };
    graph.is_file()
        && spec
            .aux_files
            .iter()
            .all(|f| dir.join(file_stem_of(f)).is_file())
}

/// The on-disk name of a repo-relative file.
///
/// `dl::model_manager` writes each file under `cache_subdir/<filename>`,
/// preserving the repo's own sub-directories, so the sidecar lands beside the
/// graph exactly as the graph's internal reference expects.
fn file_stem_of(repo_path: &str) -> &str {
    repo_path.rsplit('/').next().unwrap_or(repo_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique_and_findable() {
        let all = catalog();
        assert!(!all.is_empty());
        let mut ids: Vec<_> = all.iter().map(|s| s.id.clone()).collect();
        ids.sort();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate encoder ids in catalog");

        for spec in &all {
            assert!(find(&spec.id).is_some());
            assert!(spec.patch > 0, "{} has zero patch stride", spec.id);
            assert!(spec.embed_dim > 0, "{} has zero embed dim", spec.id);
            assert!(
                spec.input_size % spec.patch == 0,
                "{}: input {} is not a multiple of patch {}",
                spec.id,
                spec.input_size,
                spec.patch
            );
        }
        assert!(find("nope").is_none());
    }

    #[test]
    fn external_data_encoders_declare_every_file_they_need() {
        // A graph exported with external data is useless without its sidecar,
        // and the failure mode is a session that opens against no weights
        // rather than a missing-file error — so the pairing is pinned here.
        for spec in catalog() {
            let cfgs = spec.all_model_configs();
            assert_eq!(
                cfgs.len(),
                1 + spec.aux_files.len(),
                "{}: download list must cover graph plus sidecars",
                spec.id
            );
            assert_eq!(cfgs[0].filename, spec.filename, "{}: graph first", spec.id);
            for cfg in &cfgs {
                assert_eq!(cfg.repo_id, spec.repo_id);
                assert_eq!(cfg.cache_subdir, spec.cache_subdir);
            }
            // Sidecars must land beside the graph, since that is how the
            // reference recorded inside the graph resolves.
            let graph_dir = spec.filename.rsplit_once('/').map(|(d, _)| d);
            for aux in &spec.aux_files {
                assert_eq!(
                    aux.rsplit_once('/').map(|(d, _)| d),
                    graph_dir,
                    "{}: sidecar {aux} would not land next to the graph",
                    spec.id
                );
            }
        }
    }

    #[test]
    fn dinov3_entries_carry_their_weight_sidecars() {
        let spec = find("dinov3-vits16").expect("dinov3 entry");
        assert_eq!(spec.aux_files, vec!["onnx/model.onnx_data".to_string()]);
        assert_eq!(spec.input_size / spec.patch, 32, "512/16 grid");

        // DINOv2 has no external data and must not have grown a sidecar.
        assert!(find("dinov2-small").unwrap().aux_files.is_empty());
    }

    #[test]
    fn the_broken_convnext_exports_stay_out() {
        // See the catalog comment: every `onnx-community` DINOv3 ConvNeXt
        // export fails ORT type inference. Listing one would give the user a
        // download button that cannot work.
        for id in [
            "dinov3-convnext-tiny",
            "dinov3-convnext-small",
            "dinov3-convnext-base",
            "dinov3-convnext-large",
        ] {
            assert!(find(id).is_none(), "{id} is known-broken and must not ship");
        }
    }

    #[test]
    fn model_config_round_trips_repo_and_file() {
        let spec = find("dinov2-small").unwrap();
        // all_model_configs is the production entry point and lists the graph
        // first, so this asserts the catalog through the path callers use.
        let cfg = &spec.all_model_configs()[0];
        assert_eq!(cfg.repo_id, "onnx-community/dinov2-small-ONNX");
        // Nested path within the repo — the downloader must create parent dirs.
        assert!(cfg.filename.contains('/'));
    }
}
