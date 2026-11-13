//! The seeded generator behind batch selection, and behind the app's sampling
//! of patches and simulated strokes: one seed replays a whole run.

/// Small deterministic PRNG (SplitMix64).
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
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
}
