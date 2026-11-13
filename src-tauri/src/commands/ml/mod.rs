//! In-app training of a small, scribble-conditioned segmentation head.
//!
//! ```text
//!   image ──┬─> frozen ONNX encoder (ort) ─> patch tokens ─> upsample ─┐
//!           │                                                          ├─> concat ─> head (burn) ─> per-class logits
//!           ├─> local feature basis (filters.rs, full resolution) ─────┤
//!           └─> scribble distance channels ────────────────────────────┘
//! ```
//!
//! The encoder is frozen, so its output is cached per frame; only the head is
//! fitted, on sampled patches. The head is multi-class over the project's
//! labels. `backend` picks CPU or CUDA at run time.

pub mod cache;
pub mod commands;
pub mod dataset;
pub mod encoder;
pub mod gpu_runtime;
pub mod predict;
pub mod registry;
pub mod scribble;

// The local filter bank: a crate of its own, optimised in dev builds.
pub mod filters {
    pub use didascalie_features::filters::*;
    pub use didascalie_features::{add_into, bias_planes, project_into, stack};
}

// The head itself lives in its own crate (see its header for why).
pub use didascalie_head::{persist, train};
