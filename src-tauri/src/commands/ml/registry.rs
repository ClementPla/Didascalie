//! Catalog of pretrained encoders for the segmentation head, and their
//! download and cache management.
//!
//! Entries are general backbones that ship as ONNX with dense patch tokens;
//! they stay frozen. A user-supplied local `.onnx` path is accepted too, for
//! models that are gated or published without ONNX. See
//! `docs/literature-review-fewshot-scribble.md`.

use serde::{Deserialize, Serialize};

use crate::dl::model_manager::ModelConfig;

/// How pixel values are scaled before entering a graph. A wrong value does
/// not error, it degrades the features.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Normalization {
    /// Plain `[0, 1]`.
    Unit,
    /// `[0, 1]` then ImageNet mean/std.
    ImageNet,
}

impl Normalization {
    /// Per-channel `(mean, std)`, applied after scaling into `[0, 1]`.
    pub fn mean_std(self) -> ([f32; 3], [f32; 3]) {
        match self {
            Normalization::Unit => ([0.0; 3], [1.0; 3]),
            Normalization::ImageNet => ([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        }
    }
}

/// A pretrained encoder the user can download. The numeric fields are hints
/// for the UI; the real shapes are read from the graph at load time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderSpec {
    /// Used by the frontend and stored in run metadata.
    pub id: String,
    pub name: String,
    pub description: String,
    /// Hugging Face repo, e.g. `onnx-community/dinov2-small-ONNX`.
    pub repo_id: String,
    /// Path of the ONNX file within the repo (may contain `/`).
    pub filename: String,
    /// Sidecar files to download with `filename`: external-data graphs keep
    /// their weights in a `.onnx_data` blob, which `ort` looks up by the relative
    /// path recorded in the graph.
    #[serde(default)]
    pub aux_files: Vec<String>,
    /// Sub-directory of the app cache where the file is stored.
    pub cache_subdir: String,
    /// ViT patch stride: the token grid is `input_size / patch` per side.
    pub patch: u32,
    /// Channels of the patch-token embedding (hint).
    pub embed_dim: usize,
    /// Square input the graph expects (hint).
    pub input_size: u32,
    /// Approximate download size, for the UI.
    pub approx_mb: u32,
    /// Tag shown in the picker ("general", "medical", …).
    pub domain: String,
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

    fn with_aux(mut self, files: &[&str]) -> Self {
        self.aux_files = files.iter().map(|f| (*f).to_string()).collect();
        self
    }

    /// Every file this encoder needs, graph first. All must be fetched.
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
            // Sizes and hashes are not pinned: these mirrors may be re-exported.
            expected_size: None,
            expected_sha256: None,
        }
    }
}

/// The built-in encoder catalog, best default first.
///
/// DINOv2 is Apache-2.0; DINOv3 ships under Meta's own licence. There is no
/// DINOv3 ConvNeXt entry: every `onnx-community` export fails ORT type
/// inference at load (an ONNX `Loop` over a tensor sequence).
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

pub fn find(id: &str) -> Option<EncoderSpec> {
    catalog().into_iter().find(|s| s.id == id)
}

/// Where an encoder's weights live once downloaded. Mirrors the layout
/// `dl::model_manager` writes.
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

/// Whether the weights are on disk, sidecars included.
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
            // Sidecars must land beside the graph.
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

        assert!(find("dinov2-small").unwrap().aux_files.is_empty());
    }

    #[test]
    fn the_broken_convnext_exports_stay_out() {
        // See the catalog comment: these exports cannot be loaded.
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
        let cfg = &spec.all_model_configs()[0];
        assert_eq!(cfg.repo_id, "onnx-community/dinov2-small-ONNX");
        // A nested path: the downloader must create parent directories.
        assert!(cfg.filename.contains('/'));
    }
}
