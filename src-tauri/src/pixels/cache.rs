//! Decoded frames, kept within a memory budget.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::raw::{self, RawFrame};
use super::stats::{self, ChannelStats};
use crate::frames::read_frame_bytes;
use crate::storage::DbState;
use crate::utils::error::Result;

/// Memory the cache may hold. One 16-bit frame of 15 000 px per side with three
/// channels is about 1.3 GB, so the frame being looked at is always kept, even
/// alone over budget.
pub const DEFAULT_BUDGET: usize = 1024 * 1024 * 1024;

/// A frame's pixels and their statistics.
#[derive(Debug)]
pub struct Decoded {
    pub frame: RawFrame,
    pub stats: Vec<ChannelStats>,
}

impl Decoded {
    pub fn new(frame: RawFrame) -> Self {
        let stats = stats::compute(&frame);
        Decoded { frame, stats }
    }
}

/// Least recently used first.
struct Entries {
    order: VecDeque<(i64, Arc<Decoded>)>,
    bytes: usize,
}

pub struct RawFrameCache {
    budget: usize,
    inner: Mutex<Entries>,
}

impl Default for RawFrameCache {
    fn default() -> Self {
        Self::with_budget(DEFAULT_BUDGET)
    }
}

impl RawFrameCache {
    pub fn with_budget(budget: usize) -> Self {
        RawFrameCache {
            budget,
            inner: Mutex::new(Entries {
                order: VecDeque::new(),
                bytes: 0,
            }),
        }
    }

    /// Call when the open project changes: frame ids restart in every project.
    pub fn clear(&self) {
        if let Ok(mut e) = self.inner.lock() {
            e.order.clear();
            e.bytes = 0;
        }
    }

    fn lookup(&self, frame_id: i64) -> Option<Arc<Decoded>> {
        let mut e = self.inner.lock().ok()?;
        let pos = e.order.iter().position(|(id, _)| *id == frame_id)?;
        let entry = e.order.remove(pos).unwrap();
        let found = entry.1.clone();
        e.order.push_back(entry);
        Some(found)
    }

    fn insert(&self, frame_id: i64, decoded: Arc<Decoded>) {
        let Ok(mut e) = self.inner.lock() else { return };
        if let Some(pos) = e.order.iter().position(|(id, _)| *id == frame_id) {
            let (_, old) = e.order.remove(pos).unwrap();
            e.bytes -= old.frame.byte_size();
        }
        e.bytes += decoded.frame.byte_size();
        e.order.push_back((frame_id, decoded));
        while e.bytes > self.budget && e.order.len() > 1 {
            let (_, evicted) = e.order.pop_front().unwrap();
            e.bytes -= evicted.frame.byte_size();
        }
    }

    /// The frame, decoded from storage on a miss. Decoding runs outside the lock.
    pub fn get(&self, db: &DbState, frame_id: i64) -> Result<Arc<Decoded>> {
        self.get_with(frame_id, || {
            let (_, bytes) = read_frame_bytes(db, frame_id)?;
            raw::decode(&bytes)
        })
    }

    /// The frame, decoded from `bytes` on a miss (the caller already read them).
    pub fn get_from_bytes(&self, frame_id: i64, bytes: &[u8]) -> Result<Arc<Decoded>> {
        self.get_with(frame_id, || raw::decode(bytes))
    }

    fn get_with(
        &self,
        frame_id: i64,
        decode: impl FnOnce() -> Result<RawFrame>,
    ) -> Result<Arc<Decoded>> {
        if let Some(hit) = self.lookup(frame_id) {
            return Ok(hit);
        }
        let decoded = Arc::new(Decoded::new(decode()?));
        self.insert(frame_id, decoded.clone());
        Ok(decoded)
    }

    #[cfg(test)]
    fn held(&self) -> (Vec<i64>, usize) {
        let e = self.inner.lock().unwrap();
        (e.order.iter().map(|(id, _)| *id).collect(), e.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pixels::raw::Samples;

    fn frame(bytes: usize) -> RawFrame {
        RawFrame {
            width: bytes as u32,
            height: 1,
            channels: 1,
            samples: Samples::U8(vec![0; bytes]),
        }
    }

    #[test]
    fn hits_do_not_decode_again() {
        let cache = RawFrameCache::with_budget(100);
        cache.get_with(1, || Ok(frame(10))).unwrap();
        let again = cache.get_with(1, || panic!("decoded twice"));
        assert!(again.is_ok());
    }

    #[test]
    fn least_recently_used_frames_go_first() {
        let cache = RawFrameCache::with_budget(25);
        cache.get_with(1, || Ok(frame(10))).unwrap();
        cache.get_with(2, || Ok(frame(10))).unwrap();
        cache.get_with(1, || panic!()).unwrap(); // 1 is now the most recent
        cache.get_with(3, || Ok(frame(10))).unwrap();
        assert_eq!(cache.held(), (vec![1, 3], 20));
    }

    #[test]
    fn a_frame_over_budget_is_still_kept_alone() {
        let cache = RawFrameCache::with_budget(5);
        cache.get_with(1, || Ok(frame(3))).unwrap();
        cache.get_with(2, || Ok(frame(50))).unwrap();
        assert_eq!(cache.held(), (vec![2], 50));
    }

    #[test]
    fn clear_frees_memory() {
        let cache = RawFrameCache::with_budget(100);
        cache.get_with(1, || Ok(frame(10))).unwrap();
        cache.get_with(2, || Ok(frame(10))).unwrap();
        cache.clear();
        assert_eq!(cache.held(), (vec![], 0));
    }
}
