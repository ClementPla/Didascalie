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

pub mod backend;
pub mod cache;
pub mod commands;
pub mod dataset;
pub mod encoder;
pub mod filters;
pub mod persist;
pub mod predict;
pub mod registry;
pub mod scribble;
pub mod train;
