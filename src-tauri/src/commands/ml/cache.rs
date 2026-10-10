//! Cache for encoder features, in local app data.
//!
//! Not in the `.dida`: features are derived data and would travel with the
//! project. Only the encoder token grid is cached, keyed on the pixels fed to
//! the encoder: a re-imported frame can keep its id with a different image.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use ndarray::Array3;

static HITS: AtomicUsize = AtomicUsize::new(0);
static MISSES: AtomicUsize = AtomicUsize::new(0);

pub fn reset_stats() {
    HITS.store(0, Ordering::Relaxed);
    MISSES.store(0, Ordering::Relaxed);
}

/// `(hits, misses)` since the last [`reset_stats`].
pub fn stats() -> (usize, usize) {
    (HITS.load(Ordering::Relaxed), MISSES.load(Ordering::Relaxed))
}

const MAGIC: &[u8; 8] = b"DIDAFEA1";

/// Namespace for a cached working image. Not a valid encoder id.
pub const IMAGE_KIND: &str = "image";

/// Hash the stored bytes: the only content identity available before decoding.
pub fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h ^= bytes.len() as u64;
    h.wrapping_mul(0x0100_0000_01b3)
}

pub struct Key {
    pub encoder_id: String,
    pub working_size: u32,
    pub content: u64,
}

impl Key {
    /// Hash the pixels that will be fed to the encoder (FxHash-style, not
    /// cryptographic).
    pub fn new(encoder_id: &str, working_size: u32, image: &Array3<f32>) -> Self {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &v in image.iter() {
            h ^= v.to_bits() as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        for d in image.shape() {
            h ^= *d as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        Self {
            encoder_id: encoder_id.to_string(),
            working_size,
            content: h,
        }
    }

    /// A key for content already reduced to a hash. `kind` is an encoder id or
    /// [`IMAGE_KIND`].
    pub fn raw(kind: &str, working_size: u32, content: u64) -> Self {
        Self {
            encoder_id: kind.to_string(),
            working_size,
            content,
        }
    }

    fn file_name(&self) -> String {
        // The encoder id reaches a path: sanitise it.
        let safe: String = self
            .encoder_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
            .collect();
        format!("{safe}_{}_{:016x}.bin", self.working_size, self.content)
    }
}

/// Read a cached `[d, h, w]` tensor. Any failure is a miss.
pub fn load(dir: &Path, key: &Key) -> Option<Array3<f32>> {
    let hit = load_inner(dir, key);
    if hit.is_some() {
        HITS.fetch_add(1, Ordering::Relaxed);
    } else {
        MISSES.fetch_add(1, Ordering::Relaxed);
    }
    hit
}

fn load_inner(dir: &Path, key: &Key) -> Option<Array3<f32>> {
    let bytes = fs::read(dir.join(key.file_name())).ok()?;
    if bytes.len() < 20 || &bytes[..8] != MAGIC {
        return None;
    }
    let num = |o: usize| -> usize {
        let mut b = [0u8; 4];
        b.copy_from_slice(&bytes[o..o + 4]);
        u32::from_le_bytes(b) as usize
    };
    let (d, h, w) = (num(8), num(12), num(16));
    let expect = d.checked_mul(h)?.checked_mul(w)?;
    let payload = &bytes[20..];
    if expect == 0 || payload.len() != expect * 4 {
        return None;
    }
    let data: Vec<f32> = payload
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Array3::from_shape_vec((d, h, w), data).ok()
}

/// Write a tensor. Failures are logged, never fatal.
pub fn store(dir: &Path, key: &Key, value: &Array3<f32>) {
    if let Err(e) = fs::create_dir_all(dir) {
        log::warn!("[ml] feature cache unavailable ({e})");
        return;
    }
    let (d, h, w) = (value.shape()[0], value.shape()[1], value.shape()[2]);
    let mut out = Vec::with_capacity(20 + d * h * w * 4);
    out.extend_from_slice(MAGIC);
    for n in [d, h, w] {
        out.extend_from_slice(&(n as u32).to_le_bytes());
    }
    for &v in value.iter() {
        out.extend_from_slice(&v.to_le_bytes());
    }
    // Write beside the target, then rename: no half-written file.
    let final_path = dir.join(key.file_name());
    let tmp = dir.join(format!("{}.part", key.file_name()));
    if fs::write(&tmp, &out).and_then(|_| fs::rename(&tmp, &final_path)).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// Total bytes and file count under a directory, non-recursive.
pub fn usage(dir: &Path) -> (u64, usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    entries
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .fold((0, 0), |(b, n), m| (b + m.len(), n + 1))
}

pub fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_file() => m.len(),
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            _ => 0,
        })
        .sum()
}

pub fn clear(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter(|e| fs::remove_file(e.path()).is_ok())
        .count()
}

pub fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve cache dir: {e}"))?;
    Ok(base.join("features"))
}

pub fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cannot resolve cache dir: {e}"))?;
    Ok(base.join("models"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dida-cache-test-{name}"));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn sample() -> Array3<f32> {
        Array3::from_shape_fn((2, 3, 4), |(c, y, x)| (c * 100 + y * 10 + x) as f32)
    }

    #[test]
    fn a_stored_tensor_round_trips_exactly() {
        let dir = tmp("roundtrip");
        let v = sample();
        let key = Key::new("dinov3-vits16", 512, &v);
        store(&dir, &key, &v);
        let got = load(&dir, &key).expect("cached tensor must load");
        assert_eq!(got, v, "features must survive verbatim, not approximately");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_key_separates_encoders_sizes_and_content() {
        let v = sample();
        let base = Key::new("a", 512, &v);
        assert_ne!(base.file_name(), Key::new("b", 512, &v).file_name());
        assert_ne!(base.file_name(), Key::new("a", 256, &v).file_name());

        let mut edited = v.clone();
        edited[[0, 0, 0]] += 1.0;
        assert_ne!(base.file_name(), Key::new("a", 512, &edited).file_name());
    }

    #[test]
    fn a_working_image_entry_cannot_collide_with_an_encoder_entry() {
        let content = hash_bytes(b"some stored png bytes");
        let img = Key::raw(IMAGE_KIND, 384, content);
        let tokens = Key::raw("dinov3-vits16", 384, content);
        assert_ne!(img.file_name(), tokens.file_name());
        assert_ne!(img.file_name(), Key::raw(IMAGE_KIND, 512, content).file_name());
    }

    #[test]
    fn hashing_bytes_separates_content_and_length() {
        assert_ne!(hash_bytes(b"abc"), hash_bytes(b"abd"));
        assert_ne!(hash_bytes(b"abc"), hash_bytes(b"abcabc"));
        // Length is folded in: a prefix must not collide with the whole.
        assert_ne!(hash_bytes(b""), hash_bytes(b"\0"));
        assert_eq!(hash_bytes(b"stable"), hash_bytes(b"stable"), "must be deterministic");
    }

    #[test]
    fn corrupt_and_absent_entries_are_misses_not_errors() {
        let dir = tmp("corrupt");
        let v = sample();
        let key = Key::new("enc", 64, &v);
        assert!(load(&dir, &key).is_none(), "absent entry must miss");

        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(key.file_name()), b"not a tensor at all").unwrap();
        assert!(load(&dir, &key).is_none(), "garbage must miss, not panic");

        // Valid header, truncated payload.
        let mut good = MAGIC.to_vec();
        for n in [2u32, 3, 4] {
            good.extend_from_slice(&n.to_le_bytes());
        }
        good.extend_from_slice(&[0u8; 8]);
        fs::write(dir.join(key.file_name()), good).unwrap();
        assert!(load(&dir, &key).is_none(), "short payload must miss");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_and_clear_account_for_what_was_written() {
        let dir = tmp("usage");
        let v = sample();
        for enc in ["one", "two", "three"] {
            store(&dir, &Key::new(enc, 128, &v), &v);
        }
        let (bytes, files) = usage(&dir);
        assert_eq!(files, 3);
        assert!(bytes > 0, "stored files must report a size");

        assert_eq!(clear(&dir), 3);
        assert_eq!(usage(&dir), (0, 0), "clearing must leave nothing behind");
        let _ = fs::remove_dir_all(&dir);
    }
}
