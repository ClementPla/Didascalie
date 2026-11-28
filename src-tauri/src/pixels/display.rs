//! How a raw frame is shown: a window, colour and gamma per channel, composited
//! additively into 8-bit RGB.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::raw::{RawFrame, Samples};
use super::stats::ChannelStats;

/// Percentiles the automatic window clips at.
pub const AUTO_LOW: f64 = 0.005;
pub const AUTO_HIGH: f64 = 0.995;

/// One channel's display. Values at `min` and below are black, at `max` and
/// above full `color`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct ChannelDisplay {
    /// Name from the file's metadata, when there is one.
    #[ts(optional = nullable)]
    pub name: Option<String>,
    pub visible: bool,
    /// `#rrggbb`.
    pub color: String,
    pub min: f64,
    pub max: f64,
    /// 1 is linear; above 1 brightens the midtones (`out = in^(1/gamma)`).
    pub gamma: f64,
}

/// The display of every channel of a sequence's frames. Stored per sequence and
/// shared by every account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct DisplaySettings {
    pub channels: Vec<ChannelDisplay>,
}

/// Colours of 2, and 4 or more, channels, in order. A single channel is grey;
/// three are red, green and blue.
const PALETTE: [&str; 6] = [
    "#00ff00", "#ff00ff", "#00ffff", "#ff0000", "#0000ff", "#ffff00",
];

impl DisplaySettings {
    /// A starting display for `frame`. An 8-bit frame is shown as stored (full
    /// range, linear); deeper data gets the automatic window.
    pub fn auto(frame: &RawFrame, stats: &[ChannelStats]) -> Self {
        let colors: Vec<&str> = match frame.channels {
            1 => vec!["#ffffff"],
            3 => vec!["#ff0000", "#00ff00", "#0000ff"],
            n => (0..n).map(|c| PALETTE[c % PALETTE.len()]).collect(),
        };
        let eight_bit = matches!(frame.samples, Samples::U8(_));
        let channels = stats
            .iter()
            .zip(colors)
            .map(|(s, color)| {
                let (min, max) = if eight_bit {
                    (0.0, 255.0)
                } else {
                    auto_window(s)
                };
                ChannelDisplay {
                    name: None,
                    visible: true,
                    color: color.to_string(),
                    min,
                    max,
                    gamma: 1.0,
                }
            })
            .collect();
        DisplaySettings { channels }
    }

    /// Whether these settings fit `frame` (one entry per channel).
    pub fn fits(&self, frame: &RawFrame) -> bool {
        self.channels.len() == frame.channels
    }
}

/// The automatic window of a channel: its 0.5–99.5 % percentiles.
pub fn auto_window(stats: &ChannelStats) -> (f64, f64) {
    window_at(stats, AUTO_LOW, AUTO_HIGH)
}

/// The window from the `low` to the `high` percentile (0–1) of a channel.
pub fn window_at(stats: &ChannelStats, low: f64, high: f64) -> (f64, f64) {
    let lo = stats.percentile(low.min(high)) as f64;
    let hi = stats.percentile(high.max(low)) as f64;
    if hi > lo {
        (lo, hi)
    } else {
        (lo, lo + 1.0)
    }
}

/// `#rrggbb` as 0–1 floats; white when malformed.
fn parse_color(hex: &str) -> [f32; 3] {
    crate::utils::color::parse_hex(hex)
        .map(|rgb| rgb.map(|c| c as f32 / 255.0))
        .unwrap_or([1.0; 3])
}

/// Normalised display intensity (0–1) of a raw value.
#[inline]
fn window(v: f32, lo: f32, inv_span: f32, inv_gamma: f32) -> f32 {
    let t = ((v - lo) * inv_span).clamp(0.0, 1.0);
    if inv_gamma == 1.0 {
        t
    } else {
        t.powf(inv_gamma)
    }
}

/// A visible channel, ready to apply: a lookup table for integer samples.
struct Prepared {
    channel: usize,
    color: [f32; 3],
    lut: Option<Vec<f32>>,
    lo: f32,
    inv_span: f32,
    inv_gamma: f32,
}

fn prepare(frame: &RawFrame, settings: &DisplaySettings) -> Vec<Prepared> {
    let levels = match frame.samples {
        Samples::U8(_) => Some(256usize),
        Samples::U16(_) => Some(65536usize),
        Samples::F32(_) => None,
    };
    settings
        .channels
        .iter()
        .enumerate()
        .filter(|(c, d)| d.visible && *c < frame.channels)
        .map(|(channel, d)| {
            let lo = d.min as f32;
            let inv_span = 1.0 / ((d.max - d.min).max(f64::EPSILON) as f32);
            let inv_gamma = (1.0 / d.gamma.max(0.01)) as f32;
            let lut = levels.map(|n| {
                (0..n)
                    .map(|v| window(v as f32, lo, inv_span, inv_gamma))
                    .collect()
            });
            Prepared {
                channel,
                color: parse_color(&d.color),
                lut,
                lo,
                inv_span,
                inv_gamma,
            }
        })
        .collect()
}

/// A rectangle of `frame` in native pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// How large an IPC region may be past the frame's own size: a fixed-size
/// tile of a small frame overhangs it.
pub const MAX_REGION_SIDE: u32 = 8192;

impl Region {
    /// `self`, when it is fit to allocate for: no larger than the frame (or
    /// than [`MAX_REGION_SIDE`]), and with no edge past `u32::MAX`. Regions
    /// come over IPC, and the renderer and operators allocate per pixel.
    pub fn bounded(self, frame_w: u32, frame_h: u32) -> Result<Self, String> {
        let fits = self.width <= frame_w.max(MAX_REGION_SIDE)
            && self.height <= frame_h.max(MAX_REGION_SIDE)
            && self.x.checked_add(self.width).is_some()
            && self.y.checked_add(self.height).is_some();
        if fits {
            Ok(self)
        } else {
            Err(format!(
                "Region {}×{} at ({}, {}) does not fit a {frame_w}×{frame_h} frame",
                self.width, self.height, self.x, self.y
            ))
        }
    }

    pub fn full(frame: &RawFrame) -> Self {
        Region {
            x: 0,
            y: 0,
            width: frame.width,
            height: frame.height,
        }
    }
}

/// Render `region` to 8-bit RGB, `step` native pixels per output pixel
/// (averaged), so a large frame can be shown without a full-size buffer.
/// Pixels of the region outside the frame are black. Returns
/// `(width, height, rgb)`.
pub fn render_rgb(
    frame: &RawFrame,
    settings: &DisplaySettings,
    region: Region,
    step: u32,
) -> (u32, u32, Vec<u8>) {
    let step = step.max(1);
    let out_w = region.width.div_ceil(step);
    let out_h = region.height.div_ceil(step);
    let prepared = prepare(frame, settings);
    let (fw, fh) = (frame.width, frame.height);

    let mut rgb = vec![0u8; out_w as usize * out_h as usize * 3];
    rgb.par_chunks_mut(out_w as usize * 3)
        .enumerate()
        .for_each(|(oy, row)| {
            let y0 = region.y + oy as u32 * step;
            for ox in 0..out_w {
                let x0 = region.x + ox * step;
                let mut acc = [0f32; 3];
                let mut n = 0u32;
                let y_end = y0.saturating_add(step).min(region.y.saturating_add(region.height)).min(fh);
                let x_end = x0.saturating_add(step).min(region.x.saturating_add(region.width)).min(fw);
                for y in y0..y_end {
                    for x in x0..x_end {
                        let i = y as usize * fw as usize + x as usize;
                        for p in &prepared {
                            let t = match &p.lut {
                                Some(lut) => lut[frame.value(p.channel, i) as usize],
                                None => {
                                    window(frame.value(p.channel, i), p.lo, p.inv_span, p.inv_gamma)
                                }
                            };
                            for (a, c) in acc.iter_mut().zip(p.color) {
                                *a += t * c;
                            }
                        }
                        n += 1;
                    }
                }
                if n > 0 {
                    let o = ox as usize * 3;
                    for k in 0..3 {
                        row[o + k] = ((acc[k] / n as f32).clamp(0.0, 1.0) * 255.0).round() as u8;
                    }
                }
            }
        });
    (out_w, out_h, rgb)
}

/// The smallest whole step that brings the longest side of `region` within
/// `max_dim` (1 when it already fits, or when `max_dim` is 0).
pub fn step_for(region: Region, max_dim: u32) -> u32 {
    if max_dim == 0 {
        return 1;
    }
    region.width.max(region.height).div_ceil(max_dim).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pixels::stats;

    fn frame16(width: u32, height: u32, channels: usize, values: Vec<u16>) -> RawFrame {
        RawFrame {
            width,
            height,
            channels,
            samples: Samples::U16(values),
        }
    }

    fn channel(color: &str, min: f64, max: f64) -> ChannelDisplay {
        ChannelDisplay {
            name: None,
            visible: true,
            color: color.into(),
            min,
            max,
            gamma: 1.0,
        }
    }

    #[test]
    fn a_window_at_wider_percentiles_clips_more() {
        let f = frame16(101, 1, 1, (0..=100).collect());
        let s = stats::compute(&f);
        assert_eq!(window_at(&s[0], 0.0, 1.0), (0.0, 100.0));
        let (lo, hi) = window_at(&s[0], 0.1, 0.9);
        assert!(lo >= 9.0 && lo <= 11.0 && hi >= 89.0 && hi <= 91.0, "{lo} {hi}");
        // Swapped bounds still give a window.
        assert_eq!(window_at(&s[0], 0.9, 0.1), (lo, hi));
    }

    #[test]
    fn a_12_bit_window_uses_the_full_8_bit_range() {
        let f = frame16(3, 1, 1, vec![0, 2048, 4095]);
        let s = DisplaySettings {
            channels: vec![channel("#ffffff", 0.0, 4095.0)],
        };
        let (_, _, rgb) = render_rgb(&f, &s, Region::full(&f), 1);
        assert_eq!(rgb, vec![0, 0, 0, 128, 128, 128, 255, 255, 255]);
    }

    #[test]
    fn channels_add_in_their_colours_and_hidden_ones_are_skipped() {
        // Two channels, one pixel: green at full, magenta at half.
        let f = frame16(1, 1, 2, vec![100, 50]);
        let mut s = DisplaySettings {
            channels: vec![
                channel("#00ff00", 0.0, 100.0),
                channel("#ff00ff", 0.0, 100.0),
            ],
        };
        let (_, _, rgb) = render_rgb(&f, &s, Region::full(&f), 1);
        assert_eq!(rgb, vec![128, 255, 128]);
        s.channels[1].visible = false;
        let (_, _, rgb) = render_rgb(&f, &s, Region::full(&f), 1);
        assert_eq!(rgb, vec![0, 255, 0]);
    }

    #[test]
    fn gamma_brightens_midtones() {
        let f = frame16(1, 1, 1, vec![25]);
        let mut s = DisplaySettings {
            channels: vec![channel("#ffffff", 0.0, 100.0)],
        };
        s.channels[0].gamma = 2.0;
        let (_, _, rgb) = render_rgb(&f, &s, Region::full(&f), 1);
        assert_eq!(rgb[0], 128); // sqrt(0.25) = 0.5
    }

    #[test]
    fn downsampling_averages_blocks() {
        let f = frame16(2, 2, 1, vec![0, 100, 100, 0]);
        let s = DisplaySettings {
            channels: vec![channel("#ffffff", 0.0, 100.0)],
        };
        let (w, h, rgb) = render_rgb(&f, &s, Region::full(&f), 2);
        assert_eq!((w, h), (1, 1));
        assert_eq!(rgb, vec![128, 128, 128]);
        assert_eq!(
            step_for(
                Region {
                    x: 0,
                    y: 0,
                    width: 10_000,
                    height: 3000
                },
                4096
            ),
            3
        );
    }

    #[test]
    fn a_region_reaching_past_the_edge_is_black_there() {
        let f = frame16(2, 1, 1, vec![100, 100]);
        let s = DisplaySettings {
            channels: vec![channel("#ffffff", 0.0, 100.0)],
        };
        let (w, _, rgb) = render_rgb(
            &f,
            &s,
            Region {
                x: 1,
                y: 0,
                width: 2,
                height: 1,
            },
            1,
        );
        assert_eq!(w, 2);
        assert_eq!(rgb, vec![255, 255, 255, 0, 0, 0]);
    }

    #[test]
    fn auto_keeps_8_bit_frames_as_stored_and_windows_deeper_ones() {
        let photo = RawFrame {
            width: 1,
            height: 1,
            channels: 3,
            samples: Samples::U8(vec![10, 20, 30]),
        };
        let a = DisplaySettings::auto(&photo, &stats::compute(&photo));
        assert_eq!(a.channels.len(), 3);
        assert!(a.channels.iter().all(|c| c.min == 0.0 && c.max == 255.0));
        assert_eq!(a.channels[0].color, "#ff0000");

        let camera = frame16(4, 1, 1, vec![100, 200, 300, 4000]);
        let a = DisplaySettings::auto(&camera, &stats::compute(&camera));
        assert_eq!(a.channels[0].color, "#ffffff");
        assert!(a.channels[0].max <= 4000.0 && a.channels[0].min >= 100.0);
        assert!(a.fits(&camera));
    }

    #[test]
    fn settings_round_trip_as_camel_case_json() {
        let s = DisplaySettings {
            channels: vec![channel("#00ff00", 1.0, 2.0)],
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"visible\":true"));
        assert_eq!(serde_json::from_str::<DisplaySettings>(&json).unwrap(), s);
    }
}
