// src/storage/rle.rs
pub fn encode(mask: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut rle: Vec<u32> = Vec::new();
    let mut count = 0u32;
    let mut current = 0u8;
    
    // Column-major (COCO-style)
    for x in 0..width {
        for y in 0..height {
            let val = if mask[y * width + x] > 0 { 1 } else { 0 };
            if val == current {
                count += 1;
            } else {
                rle.push(count);
                count = 1;
                current = val;
            }
        }
    }
    rle.push(count);

    // NOTE: `decode` alternates starting from background (value 0). When the
    // first pixel is foreground, the loop above already emits a leading `0`
    // run, so the sequence is correct as-is. A previous version prepended an
    // extra `0` here, which corrupted any mask whose top-left pixel was set.

    // Pack as bytes (u32 little-endian per run length).
    rle.iter().flat_map(|&n| n.to_le_bytes()).collect()
}

pub fn decode(data: &[u8], width: usize, height: usize) -> Vec<u8> {
    let rle: Vec<u32> = data
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    
    let mut mask = vec![0u8; width * height];
    let mut idx = 0usize;
    let mut val = 0u8;
    
    for count in rle {
        for _ in 0..count {
            let x = idx / height;
            let y = idx % height;
            if x < width {
                mask[y * width + x] = val * 255;
            }
            idx += 1;
        }
        val = 1 - val;
    }
    
    mask
}

// ---------------------------------------------------------------------------
// Value-aware RLE (`rle8`) — the encoding used by the uint8-per-label model.
//
// Unlike the binary codec above, this preserves the actual pixel value: `0` is
// background, `1` marks a semantic label, and `1..=255` are instance ids. Runs
// are stored row-major as `[value: u8][count: u32 little-endian]`, so semantic
// masks (value always 1) stay as compact as the old binary format.
// ---------------------------------------------------------------------------

pub fn encode8(mask: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if mask.is_empty() {
        return out;
    }

    let mut current = mask[0];
    let mut count: u32 = 0;
    for &v in mask {
        if v == current {
            count += 1;
        } else {
            out.push(current);
            out.extend_from_slice(&count.to_le_bytes());
            current = v;
            count = 1;
        }
    }
    out.push(current);
    out.extend_from_slice(&count.to_le_bytes());
    out
}

pub fn decode8(data: &[u8], width: usize, height: usize) -> Vec<u8> {
    let total = width * height;
    let mut mask = vec![0u8; total];
    let mut idx = 0usize;

    for record in data.chunks_exact(5) {
        let value = record[0];
        let count = u32::from_le_bytes(record[1..5].try_into().unwrap()) as usize;
        let end = (idx + count).min(total);
        if value != 0 {
            mask[idx..end].fill(value);
        }
        idx = end;
        if idx >= total {
            break;
        }
    }

    mask
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The codec is binary: any nonzero input pixel decodes back to 255.
    fn normalized(mask: &[u8]) -> Vec<u8> {
        mask.iter().map(|&v| if v > 0 { 255 } else { 0 }).collect()
    }

    fn assert_roundtrip(mask: &[u8], w: usize, h: usize) {
        let decoded = decode(&encode(mask, w, h), w, h);
        assert_eq!(decoded, normalized(mask), "roundtrip failed ({}x{})", w, h);
    }

    #[test]
    fn roundtrip_all_zero() {
        assert_roundtrip(&vec![0u8; 4 * 3], 4, 3);
    }

    #[test]
    fn roundtrip_all_set() {
        assert_roundtrip(&vec![255u8; 4 * 3], 4, 3);
    }

    #[test]
    fn roundtrip_top_left_pixel_set() {
        // Regression: the old encoder prepended a spurious leading run when the
        // first pixel was foreground, corrupting this case.
        let mut mask = vec![0u8; 2 * 2];
        mask[0] = 255;
        assert_roundtrip(&mask, 2, 2);
    }

    #[test]
    fn roundtrip_checkerboard() {
        let (w, h) = (5usize, 4usize);
        let mut mask = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                if (x + y) % 2 == 0 {
                    mask[y * w + x] = 200; // any nonzero value
                }
            }
        }
        assert_roundtrip(&mask, w, h);
    }

    #[test]
    fn roundtrip_single_column() {
        assert_roundtrip(&[0, 255, 0, 255, 0, 255], 1, 6);
    }

    #[test]
    fn roundtrip_single_row() {
        assert_roundtrip(&[255, 0, 0, 255], 4, 1);
    }

    // ---- value-aware rle8 ----

    fn assert_roundtrip8(mask: &[u8], w: usize, h: usize) {
        let decoded = decode8(&encode8(mask), w, h);
        assert_eq!(decoded, mask, "rle8 roundtrip failed ({}x{})", w, h);
    }

    #[test]
    fn rle8_roundtrip_semantic() {
        // Values are only 0/1, like a semantic label.
        assert_roundtrip8(&[0, 1, 1, 1, 0, 0, 1, 0], 4, 2);
    }

    #[test]
    fn rle8_roundtrip_instances() {
        // Distinct instance ids preserved exactly.
        assert_roundtrip8(&[0, 1, 1, 2, 3, 3, 3, 0, 255, 12], 5, 2);
    }

    #[test]
    fn rle8_roundtrip_all_zero_and_all_set() {
        assert_roundtrip8(&vec![0u8; 12], 4, 3);
        assert_roundtrip8(&vec![7u8; 12], 4, 3);
    }

    #[test]
    fn rle8_decode_tolerates_truncation() {
        // A run longer than the image must not panic or overflow.
        let data = {
            let mut d = vec![5u8];
            d.extend_from_slice(&1000u32.to_le_bytes());
            d
        };
        assert_eq!(decode8(&data, 2, 2), vec![5, 5, 5, 5]);
    }
}
