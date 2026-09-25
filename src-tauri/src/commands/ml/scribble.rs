//! Scribble conditioning: turning sparse user strokes into per-pixel input
//! channels, and simulating those strokes during training.
//!
//! # Why the head takes scribbles as *input*
//!
//! Training only on dense masks yields a model that must get every image right
//! unaided. Feeding scribble-derived channels instead lets the user steer the
//! prediction on a new image — the DeepIGeoS/ScribblePrompt idea. The head
//! learns "agree with the positive strokes, avoid the negative ones, and
//! interpolate using appearance", which is a far easier function than
//! unconditional segmentation and degrades gracefully when strokes are absent.
//!
//! # Why strokes are simulated
//!
//! The `.dida` holds dense masks, not the strokes that produced them. So during
//! training we synthesise plausible strokes from each mask, exactly as
//! ScribblePrompt does with simulated interactions. Sampling is driven by a
//! seeded PRNG so a learning-curve run is reproducible: re-running a budget
//! must give the same answer, otherwise the curve measures noise.

/// Small deterministic PRNG (SplitMix64). Chosen over the `rand` crate to keep
/// experiments reproducible without adding a dependency.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        // Avoid the all-zero state, which SplitMix64 handles but which makes
        // seed 0 look suspiciously structured in the first few draws.
        Self(seed.wrapping_add(0x9E37_79B9_7F4A_7C15))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, n)`. Returns 0 when `n == 0`.
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }

    pub fn unit(&mut self) -> f32 {
        (self.next_u64() >> 11) as f32 / (1u64 << 53) as f32
    }
}

/// Positive and negative stroke masks over one frame.
#[derive(Debug, Clone)]
pub struct Scribbles {
    pub positive: Vec<bool>,
    pub negative: Vec<bool>,
    pub width: usize,
    pub height: usize,
}

impl Scribbles {
    pub fn empty(width: usize, height: usize) -> Self {
        Self {
            positive: vec![false; width * height],
            negative: vec![false; width * height],
            width,
            height,
        }
    }

    pub fn any(&self) -> bool {
        self.positive.iter().any(|v| *v) || self.negative.iter().any(|v| *v)
    }
}

/// Trace one random walk of `len` steps constrained to `region`.
fn walk(region: &[bool], w: usize, h: usize, len: usize, rng: &mut Rng, out: &mut [bool]) {
    // Rejection-sample a start inside the region. Bounded so a tiny or empty
    // region cannot spin here.
    let mut start = None;
    for _ in 0..64 {
        let idx = rng.below(w * h);
        if region[idx] {
            start = Some(idx);
            break;
        }
    }
    let Some(mut cur) = start else { return };
    out[cur] = true;

    const DIRS: [(isize, isize); 8] = [
        (-1, -1), (0, -1), (1, -1),
        (-1, 0),           (1, 0),
        (-1, 1),  (0, 1),  (1, 1),
    ];
    // Keep a heading so strokes look like strokes rather than blobs.
    let mut dir = rng.below(8);
    for _ in 0..len {
        let mut moved = false;
        for attempt in 0..8 {
            // Mostly continue straight; occasionally turn.
            let d = if attempt == 0 && rng.unit() < 0.8 {
                dir
            } else {
                rng.below(8)
            };
            let (dx, dy) = DIRS[d];
            let x = (cur % w) as isize + dx;
            let y = (cur / w) as isize + dy;
            if x < 0 || y < 0 || x >= w as isize || y >= h as isize {
                continue;
            }
            let next = y as usize * w + x as usize;
            if !region[next] {
                continue;
            }
            cur = next;
            dir = d;
            out[cur] = true;
            moved = true;
            break;
        }
        if !moved {
            break; // boxed in
        }
    }
}

/// Synthesise positive/negative strokes from a binary ground-truth mask.
///
/// `strokes` controls how much supervision the simulated user gives; varying it
/// is how the interaction budget is swept independently of the number of
/// annotated frames.
pub fn simulate(
    mask: &[u8],
    width: usize,
    height: usize,
    strokes: usize,
    stroke_len: usize,
    rng: &mut Rng,
) -> Scribbles {
    let mut s = Scribbles::empty(width, height);
    let fg: Vec<bool> = mask.iter().map(|&v| v > 0).collect();
    let bg: Vec<bool> = mask.iter().map(|&v| v == 0).collect();
    for _ in 0..strokes {
        walk(&fg, width, height, stroke_len, rng, &mut s.positive);
        walk(&bg, width, height, stroke_len, rng, &mut s.negative);
    }
    s
}

/// Two-pass chamfer distance to the nearest `true` seed, normalised by the
/// image diagonal so the channel is resolution-independent.
///
/// Chamfer rather than exact Euclidean: the head only needs a smooth,
/// monotone "how far from a stroke am I" cue, and this is O(n) with two passes.
pub fn distance_to_seeds(seeds: &[bool], w: usize, h: usize) -> Vec<f32> {
    // Weights approximating Euclidean steps.
    const ORTHO: f32 = 1.0;
    const DIAG: f32 = std::f32::consts::SQRT_2;
    let far = (w + h) as f32 * 2.0;
    let mut d: Vec<f32> = seeds.iter().map(|&s| if s { 0.0 } else { far }).collect();

    // Forward pass: top-left to bottom-right.
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let mut best = d[i];
            if y > 0 {
                best = best.min(d[i - w] + ORTHO);
                if x > 0 {
                    best = best.min(d[i - w - 1] + DIAG);
                }
                if x + 1 < w {
                    best = best.min(d[i - w + 1] + DIAG);
                }
            }
            if x > 0 {
                best = best.min(d[i - 1] + ORTHO);
            }
            d[i] = best;
        }
    }
    // Backward pass: bottom-right to top-left.
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let i = y * w + x;
            let mut best = d[i];
            if y + 1 < h {
                best = best.min(d[i + w] + ORTHO);
                if x > 0 {
                    best = best.min(d[i + w - 1] + DIAG);
                }
                if x + 1 < w {
                    best = best.min(d[i + w + 1] + DIAG);
                }
            }
            if x + 1 < w {
                best = best.min(d[i + 1] + ORTHO);
            }
            d[i] = best;
        }
    }

    let diag = ((w * w + h * h) as f32).sqrt().max(1.0);
    for v in &mut d {
        *v = (*v / diag).min(1.0);
    }
    d
}

/// Number of channels [`channels`] produces.
pub const SCRIBBLE_CHANNELS: usize = 2;

/// Per-pixel conditioning channels: normalised distance to the nearest positive
/// stroke and to the nearest negative stroke.
///
/// When a polarity has no strokes its channel is all-ones ("infinitely far"),
/// which is the same signal the head sees for pixels remote from a stroke — so
/// an unconditioned prediction is the natural limit of a conditioned one rather
/// than a separate code path.
pub fn channels(s: &Scribbles) -> Vec<Vec<f32>> {
    let (w, h) = (s.width, s.height);
    let pos = if s.positive.iter().any(|v| *v) {
        distance_to_seeds(&s.positive, w, h)
    } else {
        vec![1.0; w * h]
    };
    let neg = if s.negative.iter().any(|v| *v) {
        distance_to_seeds(&s.negative, w, h)
    } else {
        vec![1.0; w * h]
    };
    vec![pos, neg]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_is_deterministic_and_bounded() {
        let a: Vec<u64> = (0..5).scan(Rng::new(42), |r, _| Some(r.next_u64())).collect();
        let b: Vec<u64> = (0..5).scan(Rng::new(42), |r, _| Some(r.next_u64())).collect();
        assert_eq!(a, b, "same seed must replay identically");

        let c: Vec<u64> = (0..5).scan(Rng::new(43), |r, _| Some(r.next_u64())).collect();
        assert_ne!(a, c, "different seeds must diverge");

        let mut r = Rng::new(7);
        for _ in 0..200 {
            assert!(r.below(10) < 10);
            let u = r.unit();
            assert!((0.0..1.0).contains(&u), "unit out of range: {u}");
        }
        assert_eq!(Rng::new(1).below(0), 0, "below(0) must not divide by zero");
    }

    #[test]
    fn distance_is_zero_at_seeds_and_grows_outward() {
        let (w, h) = (9, 9);
        let mut seeds = vec![false; w * h];
        seeds[4 * w + 4] = true;
        let d = distance_to_seeds(&seeds, w, h);

        assert_eq!(d[4 * w + 4], 0.0);
        assert!(d[4 * w + 5] > 0.0);
        // Monotone as we walk away from the seed along a row.
        for x in 5..w - 1 {
            assert!(d[4 * w + x + 1] >= d[4 * w + x], "not monotone at x={x}");
        }
        assert!(d.iter().all(|&v| (0.0..=1.0).contains(&v)));
    }

    #[test]
    fn simulated_strokes_respect_region_boundaries() {
        // Left half foreground, right half background.
        let (w, h) = (20, 20);
        let mask: Vec<u8> = (0..w * h)
            .map(|i| if (i % w) < w / 2 { 1 } else { 0 })
            .collect();
        let mut rng = Rng::new(123);
        let s = simulate(&mask, w, h, 4, 30, &mut rng);

        assert!(s.any(), "expected some strokes");
        for i in 0..w * h {
            if s.positive[i] {
                assert!(mask[i] > 0, "positive stroke leaked into background at {i}");
            }
            if s.negative[i] {
                assert!(mask[i] == 0, "negative stroke leaked into foreground at {i}");
            }
        }
    }

    #[test]
    fn simulation_is_reproducible_for_a_seed() {
        let (w, h) = (16, 16);
        let mask: Vec<u8> = (0..w * h).map(|i| if i % 3 == 0 { 1 } else { 0 }).collect();
        let a = simulate(&mask, w, h, 3, 20, &mut Rng::new(9));
        let b = simulate(&mask, w, h, 3, 20, &mut Rng::new(9));
        assert_eq!(a.positive, b.positive);
        assert_eq!(a.negative, b.negative);
    }

    #[test]
    fn empty_polarity_yields_saturated_channel() {
        let (w, h) = (8, 8);
        let s = Scribbles::empty(w, h);
        let ch = channels(&s);
        assert_eq!(ch.len(), SCRIBBLE_CHANNELS);
        assert!(ch.iter().all(|c| c.iter().all(|&v| v == 1.0)));
    }

    #[test]
    fn degenerate_regions_do_not_hang() {
        // An all-background mask: positive strokes are impossible.
        let (w, h) = (8, 8);
        let mask = vec![0u8; w * h];
        let s = simulate(&mask, w, h, 4, 50, &mut Rng::new(5));
        assert!(s.positive.iter().all(|v| !v));
        assert!(s.negative.iter().any(|v| *v));
    }
}
