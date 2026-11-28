//! sRGB → CIELAB conversion and the CIEDE2000 colour difference.

/// A CIELAB triple: `(L*, a*, b*)`.
pub type Lab = (f32, f32, f32);

/// sRGB gamma-expansion lookup table (8-bit channel → linear light).
static GAMMA_LUT: once_cell::sync::Lazy<[f32; 256]> = once_cell::sync::Lazy::new(|| {
    let mut lut = [0.0f32; 256];
    for i in 0..256 {
        let v = i as f32 / 255.0;
        lut[i] = if v > 0.04045 {
            ((v + 0.055) / 1.055).powf(2.4)
        } else {
            v / 12.92
        };
    }
    lut
});

const LAB_THRESHOLD: f32 = 0.008856;
const LAB_T0: f32 = 0.137931;

#[inline(always)]
fn xyz_to_lab_component(t: f32) -> f32 {
    if t > LAB_THRESHOLD {
        t.powf(1.0 / 3.0)
    } else {
        7.787 * t + LAB_T0
    }
}

/// Convert an 8-bit sRGB pixel to CIELAB (D65).
#[inline]
pub fn rgb_to_lab(r: u8, g: u8, b: u8) -> Lab {
    let r = GAMMA_LUT[r as usize];
    let g = GAMMA_LUT[g as usize];
    let b = GAMMA_LUT[b as usize];

    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    let z = (r * 0.0193339 + g * 0.119_192 + b * 0.9503041) / 1.08883;

    let fx = xyz_to_lab_component(x);
    let fy = xyz_to_lab_component(y);
    let fz = xyz_to_lab_component(z);

    let l = 116.0 * fy - 16.0;
    let a = 500.0 * (fx - fy);
    let b = 200.0 * (fy - fz);

    (l, a, b)
}

/// CIEDE2000 color-difference between two CIELAB colors.
#[inline]
pub fn ciede2000(lab1: Lab, lab2: Lab) -> f32 {
    let (l1, a1, b1) = lab1;
    let (l2, a2, b2) = lab2;

    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let c_avg = (c1 + c2) / 2.0;

    // G factor of the a' correction.
    let c_avg_7 = c_avg.powi(7);
    let g = 0.5 * (1.0 - (c_avg_7 / (c_avg_7 + 25.0_f32.powi(7))).sqrt());

    let a1_prime = a1 * (1.0 + g);
    let a2_prime = a2 * (1.0 + g);

    let c1_prime = (a1_prime * a1_prime + b1 * b1).sqrt();
    let c2_prime = (a2_prime * a2_prime + b2 * b2).sqrt();

    let h1_prime = if b1 == 0.0 && a1_prime == 0.0 {
        0.0
    } else {
        let h = b1.atan2(a1_prime).to_degrees();
        if h < 0.0 {
            h + 360.0
        } else {
            h
        }
    };

    let h2_prime = if b2 == 0.0 && a2_prime == 0.0 {
        0.0
    } else {
        let h = b2.atan2(a2_prime).to_degrees();
        if h < 0.0 {
            h + 360.0
        } else {
            h
        }
    };

    let delta_l = l2 - l1;
    let delta_c_prime = c2_prime - c1_prime;

    let delta_h_prime = if c1_prime * c2_prime == 0.0 {
        0.0
    } else {
        let diff = h2_prime - h1_prime;
        if diff.abs() <= 180.0 {
            diff
        } else if diff > 180.0 {
            diff - 360.0
        } else {
            diff + 360.0
        }
    };

    let delta_big_h_prime =
        2.0 * (c1_prime * c2_prime).sqrt() * (delta_h_prime.to_radians() / 2.0).sin();

    let l_avg = (l1 + l2) / 2.0;
    let c_prime_avg = (c1_prime + c2_prime) / 2.0;

    let h_prime_avg = if c1_prime * c2_prime == 0.0 {
        h1_prime + h2_prime
    } else {
        let sum = h1_prime + h2_prime;
        if (h1_prime - h2_prime).abs() <= 180.0 {
            sum / 2.0
        } else if sum < 360.0 {
            (sum + 360.0) / 2.0
        } else {
            (sum - 360.0) / 2.0
        }
    };

    // Weighting factors.
    let t = 1.0 - 0.17 * ((h_prime_avg - 30.0).to_radians()).cos()
        + 0.24 * ((2.0 * h_prime_avg).to_radians()).cos()
        + 0.32 * ((3.0 * h_prime_avg + 6.0).to_radians()).cos()
        - 0.20 * ((4.0 * h_prime_avg - 63.0).to_radians()).cos();

    let s_l = 1.0 + (0.015 * (l_avg - 50.0).powi(2)) / (20.0 + (l_avg - 50.0).powi(2)).sqrt();
    let s_c = 1.0 + 0.045 * c_prime_avg;
    let s_h = 1.0 + 0.015 * c_prime_avg * t;

    // R_T = -R_C · sin(2Δθ), Δθ = 30° · exp(-((H̄' - 275°) / 25°)²).
    let delta_theta = 30.0 * (-((h_prime_avg - 275.0) / 25.0).powi(2)).exp();
    let r_t = -2.0
        * (c_prime_avg.powi(7) / (c_prime_avg.powi(7) + 25.0_f32.powi(7))).sqrt()
        * (2.0 * delta_theta).to_radians().sin();

    let k_l = 1.0;
    let k_c = 1.0;
    let k_h = 1.0;

    ((delta_l / (k_l * s_l)).powi(2)
        + (delta_c_prime / (k_c * s_c)).powi(2)
        + (delta_big_h_prime / (k_h * s_h)).powi(2)
        + r_t * (delta_c_prime / (k_c * s_c)) * (delta_big_h_prime / (k_h * s_h)))
        .sqrt()
}

/// Parse `#rrggbb` (the `#` is optional) into RGB.
pub fn parse_hex(colour: &str) -> Result<[u8; 3], String> {
    let hex = colour.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.is_ascii() {
        return Err(format!("“{colour}” is not a #rrggbb colour"));
    }
    let channel = |i: usize| {
        u8::from_str_radix(&hex[i..i + 2], 16)
            .map_err(|_| format!("“{colour}” is not a #rrggbb colour"))
    };
    Ok([channel(0)?, channel(2)?, channel(4)?])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pairs from Sharma, Wu & Dalal (2005), the reference CIEDE2000 data.
    /// The first ones are blues near H̄' ≈ 275°, where the rotation term
    /// matters.
    #[test]
    fn ciede2000_matches_sharma_reference() {
        let cases: [(Lab, Lab, f32); 6] = [
            ((50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485), 2.0425),
            ((50.0, 3.1571, -77.2803), (50.0, 0.0, -82.7485), 2.8615),
            ((50.0, 2.8361, -74.0200), (50.0, 0.0, -82.7485), 3.4412),
            ((50.0, 0.0, 0.0), (50.0, -1.0, 2.0), 2.3669),
            ((50.0, 2.5, 0.0), (73.0, 25.0, -18.0), 27.1492),
            ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
        ];
        for (a, b, expected) in cases {
            let got = ciede2000(a, b);
            assert!((got - expected).abs() < 1e-3, "{a:?} vs {b:?}: {got} != {expected}");
            assert!((ciede2000(b, a) - expected).abs() < 1e-3, "not symmetric for {a:?}");
        }
    }

    #[test]
    fn parse_hex_rejects_multibyte_input() {
        assert_eq!(parse_hex("#ff8000"), Ok([255, 128, 0]));
        assert!(parse_hex("€abc").is_err());
    }
}
