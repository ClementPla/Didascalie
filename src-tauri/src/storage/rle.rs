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
    
    if mask[0] > 0 {
        rle.insert(0, 0);
    }
    
    // Pack as bytes (varint encoding for compactness)
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