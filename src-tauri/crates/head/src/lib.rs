//! The trainable segmentation head of Didascalie, and its optimisation loop.
//!
//! A crate of its own because of what it costs to compile. burn is generic
//! over its backend, so the network, the autodiff graph and both backends are
//! instantiated in whichever crate names them: inside the application crate
//! that was twelve minutes of optimisation after any change to any file, and
//! in a dev build it ran unoptimised. Here it is compiled once, as a
//! dependency, and optimised in every profile.
//!
//! Nothing public is generic over a backend: callers hand over plain `Vec`s
//! and get a [`train::Head`] back.

pub mod backend;
pub mod persist;
pub mod rng;
pub mod train;

pub use rng::Rng;
