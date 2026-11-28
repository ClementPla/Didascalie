//! A single intensity per pixel, for the operators: raw values through the
//! display window, kept as floats so no precision is lost to 8 bits.

use ndarray::Array2;

use super::display::{DisplaySettings, Region};
use super::raw::RawFrame;

/// What the operators read from a multi-channel frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// At each pixel, the brightest of the visible channels.
    BrightestVisible,
    /// One channel, visible or not.
    Channel(usize),
}

impl Source {
    pub fn from_option(channel: Option<u32>) -> Self {
        match channel {
            Some(c) => Source::Channel(c as usize),
            None => Source::BrightestVisible,
        }
    }
}

/// The intensity (0–1) of `region`, `[height, width]`: each raw value mapped
/// through its channel's window and gamma, as the display does. Pixels of the
/// region outside the frame are 0.
pub fn intensity_region(frame: &RawFrame, settings: &DisplaySettings, region: Region, source: Source) -> Array2<f32> {
    let channels: Vec<usize> = match source {
        Source::Channel(c) if c < frame.channels => vec![c],
        Source::Channel(_) => Vec::new(),
        Source::BrightestVisible => settings
            .channels
            .iter()
            .enumerate()
            .filter(|(c, d)| d.visible && *c < frame.channels)
            .map(|(c, _)| c)
            .collect(),
    };
    // (channel, lo, 1/span, 1/gamma)
    let windows: Vec<(usize, f32, f32, f32)> = channels
        .into_iter()
        .filter_map(|c| {
            let d = settings.channels.get(c)?;
            let span = (d.max - d.min).max(f64::EPSILON);
            Some((c, d.min as f32, (1.0 / span) as f32, (1.0 / d.gamma.max(0.01)) as f32))
        })
        .collect();

    let (fw, fh) = (frame.width, frame.height);
    Array2::from_shape_fn((region.height as usize, region.width as usize), |(ry, rx)| {
        let (x, y) = (region.x as u64 + rx as u64, region.y as u64 + ry as u64);
        if x >= fw as u64 || y >= fh as u64 {
            return 0.0;
        }
        let i = y as usize * fw as usize + x as usize;
        windows
            .iter()
            .map(|&(c, lo, inv_span, inv_gamma)| {
                let t = ((frame.value(c, i) - lo) * inv_span).clamp(0.0, 1.0);
                if inv_gamma == 1.0 { t } else { t.powf(inv_gamma) }
            })
            .fold(0.0, f32::max)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pixels::display::ChannelDisplay;
    use crate::pixels::raw::Samples;

    fn settings(windows: &[(f64, f64, bool)]) -> DisplaySettings {
        DisplaySettings {
            channels: windows
                .iter()
                .map(|&(min, max, visible)| ChannelDisplay {
                    name: None,
                    visible,
                    color: "#ffffff".into(),
                    min,
                    max,
                    gamma: 1.0,
                })
                .collect(),
        }
    }

    fn assert_close(actual: &Array2<f32>, expected: &[f32]) {
        let actual = actual.as_slice().unwrap();
        assert_eq!(actual.len(), expected.len());
        for (a, e) in actual.iter().zip(expected) {
            assert!((a - e).abs() < 1e-5, "{actual:?} != {expected:?}");
        }
    }

    /// Two channels of 2×1 pixels.
    fn frame() -> RawFrame {
        RawFrame { width: 2, height: 1, channels: 2, samples: Samples::U16(vec![1000, 4000, 3000, 0]) }
    }

    #[test]
    fn the_brightest_visible_channel_wins_and_hidden_ones_are_ignored() {
        let f = frame();
        let full = Region::full(&f);
        let both = intensity_region(&f, &settings(&[(0.0, 4000.0, true), (0.0, 4000.0, true)]), full, Source::BrightestVisible);
        assert_close(&both, &[0.75, 1.0]);
        let first = intensity_region(&f, &settings(&[(0.0, 4000.0, true), (0.0, 4000.0, false)]), full, Source::BrightestVisible);
        assert_close(&first, &[0.25, 1.0]);
    }

    #[test]
    fn a_chosen_channel_is_read_even_when_hidden() {
        let f = frame();
        let s = settings(&[(0.0, 4000.0, true), (0.0, 3000.0, false)]);
        let v = intensity_region(&f, &s, Region::full(&f), Source::Channel(1));
        assert_close(&v, &[1.0, 0.0]);
    }

    #[test]
    fn the_window_keeps_precision_finer_than_8_bits() {
        // 12-bit values one step apart stay distinct, which 8 bits would merge.
        let f = RawFrame { width: 2, height: 1, channels: 1, samples: Samples::U16(vec![2048, 2049]) };
        let v = intensity_region(&f, &settings(&[(0.0, 4095.0, true)]), Region::full(&f), Source::BrightestVisible);
        assert!(v[[0, 1]] > v[[0, 0]]);
    }

    #[test]
    fn a_region_past_the_edge_reads_zero_there() {
        let f = frame();
        let v = intensity_region(
            &f,
            &settings(&[(0.0, 4000.0, true), (0.0, 4000.0, true)]),
            Region { x: 1, y: 0, width: 2, height: 1 },
            Source::BrightestVisible,
        );
        assert_close(&v, &[1.0, 0.0]);
    }
}
