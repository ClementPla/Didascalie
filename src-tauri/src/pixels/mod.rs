//! Frames at their native bit depth (8, 16-bit or float, one or more
//! channels), decoded once in Rust. The webview only receives 8-bit renders
//! through a per-channel display window; measurements read the raw values.

pub mod cache;
pub mod display;
pub mod intensity;
pub mod picture;
pub mod raw;
pub mod stats;
