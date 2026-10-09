//! Derive object geometry (bounding boxes + polygons) from label value masks.
//! Object formats (COCO, YOLO) consume these; mask/volume formats (NIfTI) use
//! the raw masks directly.

use image::{GrayImage, Luma};
use imageproc::contours::{find_contours, BorderType};
use imageproc::region_labelling::{connected_components, Connectivity};

/// One object extracted from a label mask.
pub struct Region {
    /// Instance id (mask value) for instance labels, else 1.
    pub instance: u8,
    /// x, y, width, height in image pixels.
    pub bbox: [f64; 4],
    pub area: u32,
    /// Contour rings, image-pixel coordinates. One ring per outer contour, with
    /// any enclosed holes bridged into it (see [`bridge_hole`]).
    pub polygons: Vec<Vec<[f64; 2]>>,
}

/// Minimum enclosed area (px²) for a hole to be cut out of its region.
///
/// A contour traced around a single stray background pixel encloses 4 px²; a 2x2
/// hole encloses 9. A predicted mask is speckled with one-pixel dropouts that are
/// noise rather than anatomy, and each one kept would add a bridge corridor to
/// the ring for no gain.
const MIN_HOLE_AREA: f64 = 8.0;

/// Split a label's value mask into per-object regions.
///
/// - `by_instance` (instance segmentation): one region per distinct nonzero
///   value (the instance id).
/// - otherwise (semantic): one region per 8-connected component of the
///   presence, which is the object granularity COCO/YOLO expect.
pub fn regions_from_mask(values: &[u8], w: u32, h: u32, by_instance: bool) -> Vec<Region> {
    let (wu, hu) = (w as usize, h as usize);
    if values.len() < wu * hu || w == 0 || h == 0 {
        return Vec::new();
    }
    let mut regions = Vec::new();

    if by_instance {
        let mut ids: Vec<u8> = values.iter().copied().filter(|&v| v != 0).collect();
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            let bin: Vec<u8> = values.iter().map(|&v| if v == id { 255 } else { 0 }).collect();
            if let Some(mut r) = region_from_binary(&bin, w, h) {
                r.instance = id;
                regions.push(r);
            }
        }
    } else {
        let presence: Vec<u8> = values.iter().map(|&v| if v != 0 { 255 } else { 0 }).collect();
        let Some(img) = GrayImage::from_raw(w, h, presence) else {
            return regions;
        };
        let cc = connected_components(&img, Connectivity::Eight, Luma([0u8]));
        let max_label = cc.pixels().map(|p| p[0]).max().unwrap_or(0);
        for label in 1..=max_label {
            let bin: Vec<u8> =
                cc.pixels().map(|p| if p[0] == label { 255 } else { 0 }).collect();
            if let Some(mut r) = region_from_binary(&bin, w, h) {
                r.instance = 1;
                regions.push(r);
            }
        }
    }
    regions
}

fn region_from_binary(bin: &[u8], w: u32, h: u32) -> Option<Region> {
    let (mut minx, mut miny, mut maxx, mut maxy) = (u32::MAX, u32::MAX, 0u32, 0u32);
    let mut area = 0u32;
    for y in 0..h {
        for x in 0..w {
            if bin[(y * w + x) as usize] != 0 {
                area += 1;
                minx = minx.min(x);
                miny = miny.min(y);
                maxx = maxx.max(x);
                maxy = maxy.max(y);
            }
        }
    }
    if area == 0 {
        return None;
    }

    let img = GrayImage::from_raw(w, h, bin.to_vec())?;
    let contours = find_contours::<u32>(&img);
    let mut polygons = Vec::new();
    for (i, c) in contours.iter().enumerate() {
        if c.border_type != BorderType::Outer {
            continue;
        }
        let Some(mut ring) = simplify_ring(contour_ring(c)) else {
            continue;
        };
        // Cut out the background this contour encloses, so a ring stays a ring.
        for hole in contours
            .iter()
            .filter(|hc| hc.border_type == BorderType::Hole && hc.parent == Some(i))
        {
            let Some(hring) = simplify_ring(contour_ring(hole)) else {
                continue;
            };
            if ring_area(&hring) < MIN_HOLE_AREA {
                continue;
            }
            ring = bridge_hole(&ring, &hring);
        }
        polygons.push(ring);
    }

    Some(Region {
        instance: 1,
        bbox: [
            minx as f64,
            miny as f64,
            (maxx - minx + 1) as f64,
            (maxy - miny + 1) as f64,
        ],
        area,
        polygons,
    })
}

/// A traced contour as image-pixel points.
fn contour_ring(c: &imageproc::contours::Contour<u32>) -> Vec<[f64; 2]> {
    c.points.iter().map(|p| [p.x as f64, p.y as f64]).collect()
}

/// Simplify a contour ring, or `None` when it cannot form a polygon at all.
///
/// Keeps the raw ring when simplification collapses it. Douglas-Peucker at this
/// tolerance flattens a small component — a 2x2 blob and anything near it — to
/// fewer than three points, and dropping the result made whole regions disappear
/// rather than merely lose detail. A region that exists should always produce a
/// polygon.
fn simplify_ring(ring: Vec<[f64; 2]>) -> Option<Vec<[f64; 2]>> {
    let simplified = douglas_peucker(&ring, 1.5);
    let out = if simplified.len() >= 3 { simplified } else { ring };
    (out.len() >= 3).then_some(out)
}

/// Enclosed area of a closed ring (shoelace, unsigned so winding is irrelevant).
fn ring_area(ring: &[[f64; 2]]) -> f64 {
    if ring.len() < 3 {
        return 0.0;
    }
    let mut acc = 0.0;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        acc += a[0] * b[1] - b[0] * a[1];
    }
    (acc / 2.0).abs()
}

/// Splice `hole` into `outer` as a single closed ring, joined by a zero-width
/// corridor between their closest pair of vertices.
///
/// Every consumer of these polygons fills by even-odd parity: the editor's SVG
/// layer through `fill-rule="evenodd"`, this crate's rasterizer through scanline
/// crossing counts, and pycocotools and the YOLO tooling likewise. Under that
/// rule the spliced loop cancels and reads as a hole, and the corridor is crossed
/// twice by any scanline that meets it, so it contributes nothing. That keeps a
/// holed region a single flat list of points — all `VectorShape.nodes` can hold —
/// instead of needing sub-paths threaded through storage, rendering,
/// rasterization and export.
fn bridge_hole(outer: &[[f64; 2]], hole: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let (mut bi, mut bj, mut best) = (0usize, 0usize, f64::MAX);
    for (i, o) in outer.iter().enumerate() {
        for (j, p) in hole.iter().enumerate() {
            let d = (o[0] - p[0]).powi(2) + (o[1] - p[1]).powi(2);
            if d < best {
                best = d;
                bi = i;
                bj = j;
            }
        }
    }
    let mut out = Vec::with_capacity(outer.len() + hole.len() + 2);
    out.extend_from_slice(&outer[..=bi]);
    out.extend(hole[bj..].iter().copied());
    out.extend(hole[..bj].iter().copied());
    out.push(hole[bj]); // close the hole loop
    out.push(outer[bi]); // back down the corridor
    out.extend(outer[bi + 1..].iter().copied());
    out
}

/// Trace the outer contour(s) of the 8-connected, same-value component that
/// contains the seed pixel `(sx, sy)`. Returns simplified polygon rings in
/// image-pixel coordinates, or empty when the seed is background / out of range.
///
/// Same-value flooding (not just nonzero) keeps two touching instances in an
/// instance mask separate, matching how the frontend clears the traced pixels.
pub fn component_polygons(values: &[u8], w: u32, h: u32, sx: u32, sy: u32) -> Vec<Vec<[f64; 2]>> {
    match flood_same_value_component(values, w, h, sx, sy) {
        Some(bin) => region_from_binary(&bin, w, h)
            .map(|r| r.polygons)
            .unwrap_or_default(),
        None => Vec::new(),
    }
}

/// Flood the 8-connected, same-value component containing `(sx, sy)` into a
/// binary mask (255 = in component). Returns None when the seed is out of range
/// or background. Same-value flooding keeps touching instances separate.
fn flood_same_value_component(values: &[u8], w: u32, h: u32, sx: u32, sy: u32) -> Option<Vec<u8>> {
    let (wu, hu) = (w as usize, h as usize);
    if values.len() < wu * hu || sx >= w || sy >= h {
        return None;
    }
    let seed = values[(sy * w + sx) as usize];
    if seed == 0 {
        return None;
    }

    let mut bin = vec![0u8; values.len()];
    let mut stack = vec![(sx, sy)];
    bin[(sy * w + sx) as usize] = 255;
    while let Some((x, y)) = stack.pop() {
        for dy in -1i64..=1 {
            for dx in -1i64..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let nx = x as i64 + dx;
                let ny = y as i64 + dy;
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                    continue;
                }
                let ni = (ny as u32 * w + nx as u32) as usize;
                if bin[ni] == 0 && values[ni] == seed {
                    bin[ni] = 255;
                    stack.push((nx as u32, ny as u32));
                }
            }
        }
    }
    Some(bin)
}

// ── Skeletonization (raster component → centerline paths) ───────────────────

/// Absolute floor (px) for the spur test below. It only decides the outcome for
/// shapes so thin that the radius term is ~0 — a 1px hand-drawn stroke, where
/// the hairs thinning leaves are a couple of pixels long.
const MIN_SPUR_LEN: f64 = 5.0;
/// How far a branch must run, as a multiple of the maximal inscribed-disc radius
/// at its base, before it counts as real.
///
/// This is the pruning criterion that matters. A spur's length scales with the
/// *local thickness* of the region — the same boundary roughness that leaves 3px
/// hairs on a 6px stroke leaves 30px hairs on a 60px blob — so an absolute
/// threshold cannot work across the shapes this tool is pointed at. Judging a
/// branch against the disc it hangs off is scale-invariant: a branch that stays
/// inside its base's disc has not left the parent shape and carries no geometry
/// the trunk doesn't already have. 1.5 clears the two diagonal arms thinning
/// leaves at a blunt end (each ≈ one radius) while keeping any side branch
/// long enough to be resolvable at all.
const SPUR_RADIUS_FACTOR: f64 = 1.5;
/// Douglas–Peucker tolerance for skeleton polylines (finer than contour tracing
/// so curved centerlines stay smooth).
const SKELETON_EPSILON: f64 = 1.0;
/// Absolute floor (px) for the returned-path test, which otherwise scales with
/// the local radius the same way spur pruning does. The longest path is always
/// kept, so a single unbranched fibre can never filter down to nothing.
const MIN_OUTPUT_LEN: f64 = 8.0;

/// Skeletonize the same-value component under `(sx, sy)` and return its centerline
/// as one or more open polylines (image-pixel coords). The component is thinned
/// to a 1px skeleton (Zhang–Suen), then split at endpoints/junctions so each
/// branch between two such nodes is a separate path. Empty when the seed is
/// background / out of range.
pub fn component_skeleton_paths(
    values: &[u8],
    w: u32,
    h: u32,
    sx: u32,
    sy: u32,
) -> Vec<Vec<[f64; 2]>> {
    let Some(bin) = flood_same_value_component(values, w, h, sx, sy) else {
        return Vec::new();
    };
    skeleton_of_binary(&bin, w as usize, h as usize)
}

/// Skeletonize **every** component of `mask` into centerline polylines.
///
/// The whole-mask counterpart of [`component_skeleton_paths`], for turning a
/// predicted mask into editable centerlines in one pass — the skeleton analogue
/// of [`regions_from_mask`]. Components are skeletonized independently so a
/// junction is only ever a real branch within one structure, never two objects
/// that happen to touch diagonally.
///
/// `min_area` drops specks below a pixel count, and `max_shapes` caps how many
/// components are traced (largest first). Both behave as in `vectorize_mask`;
/// note the cap counts *components*, not returned polylines, since one branched
/// structure legitimately yields several.
pub fn mask_skeleton_paths(
    values: &[u8],
    w: u32,
    h: u32,
    min_area: u32,
    max_shapes: usize,
) -> Vec<Vec<[f64; 2]>> {
    let (wu, hu) = (w as usize, h as usize);
    if values.len() < wu * hu || w == 0 || h == 0 {
        return Vec::new();
    }
    let presence: Vec<u8> = values.iter().map(|&v| if v != 0 { 255 } else { 0 }).collect();
    let Some(img) = GrayImage::from_raw(w, h, presence) else {
        return Vec::new();
    };
    let cc = connected_components(&img, Connectivity::Eight, Luma([0u8]));
    let max_label = cc.pixels().map(|p| p[0]).max().unwrap_or(0);

    let mut comps: Vec<(u32, Vec<u8>)> = Vec::new();
    for label in 1..=max_label {
        let bin: Vec<u8> = cc.pixels().map(|p| u8::from(p[0] == label)).collect();
        let area = bin.iter().filter(|&&v| v != 0).count() as u32;
        if area >= min_area {
            comps.push((area, bin));
        }
    }
    comps.sort_by(|a, b| b.0.cmp(&a.0));
    comps
        .into_iter()
        .take(if max_shapes == 0 { usize::MAX } else { max_shapes })
        .flat_map(|(_, bin)| skeleton_of_binary(&bin, wu, hu))
        .collect()
}

/// Thin one binary component to its centerline polylines. `bin` is nonzero on
/// the component and zero elsewhere, in image-space row-major order.
fn skeleton_of_binary(bin: &[u8], wu: usize, hu: usize) -> Vec<Vec<[f64; 2]>> {
    // Work on a 1px-padded grid (1 = fg) so thinning/tracing never touch the
    // image border; coords are shifted back by 1 when emitting points.
    let (pw, ph) = (wu + 2, hu + 2);
    let mut grid = vec![0u8; pw * ph];
    for y in 0..hu {
        for x in 0..wu {
            if bin[y * wu + x] != 0 {
                grid[(y + 1) * pw + (x + 1)] = 1;
            }
        }
    }

    // Measured on the *region*, before thinning: every downstream threshold is a
    // multiple of the local half-width, which is what makes them hold whether the
    // user drew a hairline or filled an organ.
    let dt = distance_to_background(&grid, pw, ph);

    zhang_suen_thin(&mut grid, pw, ph);

    let simplified: Vec<Vec<[f64; 2]>> = trace_skeleton(&grid, pw, ph, &dt)
        .into_iter()
        .map(|poly| douglas_peucker(&poly, SKELETON_EPSILON))
        .filter(|poly| poly.len() >= 2)
        .collect();

    // Drop leftover clutter (the tiny artefact branches raster thinning leaves at
    // a thick curved band's high-curvature extrema) while always keeping the
    // longest path, so an unbranched fibre comes back as a single clean line.
    let lengths: Vec<f64> = simplified.iter().map(|p| polyline_length_pts(p)).collect();
    let max_len = lengths.iter().copied().fold(0.0, f64::max);
    simplified
        .into_iter()
        .zip(lengths)
        .filter(|(poly, len)| {
            *len >= max_len || *len >= keep_threshold(radius_along(poly, &dt, pw))
        })
        .map(|(poly, _)| poly)
        .collect()
}

/// The length a branch must reach, given the inscribed-disc radius it sits in.
fn keep_threshold(radius: f64) -> f64 {
    MIN_OUTPUT_LEN.max(SPUR_RADIUS_FACTOR * radius)
}

/// The largest inscribed-disc radius the polyline passes through, in pixels.
/// Points are image-space; `dt` is on the 1px-padded grid.
fn radius_along(poly: &[[f64; 2]], dt: &[f32], pw: usize) -> f64 {
    poly.iter()
        .map(|p| dt[(p[1] as usize + 1) * pw + (p[0] as usize + 1)] as f64)
        .fold(0.0, f64::max)
}

/// Distance (px) from each foreground pixel to the nearest background pixel;
/// background reads 0. Two chamfer passes with (1, √2) steps — an approximation
/// to the Euclidean transform, good to a few percent, which is ample for a
/// threshold. Callers pad, so the border is background and the 8-ring of every
/// visited pixel is in bounds.
fn distance_to_background(img: &[u8], w: usize, h: usize) -> Vec<f32> {
    const FAR: f32 = 1e9;
    const D1: f32 = 1.0;
    const D2: f32 = std::f32::consts::SQRT_2;

    let mut dt: Vec<f32> = img.iter().map(|&v| if v != 0 { FAR } else { 0.0 }).collect();
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let i = y * w + x;
            if dt[i] == 0.0 {
                continue;
            }
            let m = (dt[i - w] + D1)
                .min(dt[i - 1] + D1)
                .min(dt[i - w - 1] + D2)
                .min(dt[i - w + 1] + D2);
            dt[i] = dt[i].min(m);
        }
    }
    for y in (1..h - 1).rev() {
        for x in (1..w - 1).rev() {
            let i = y * w + x;
            if dt[i] == 0.0 {
                continue;
            }
            let m = (dt[i + w] + D1)
                .min(dt[i + 1] + D1)
                .min(dt[i + w + 1] + D2)
                .min(dt[i + w - 1] + D2);
            dt[i] = dt[i].min(m);
        }
    }
    dt
}

/// Euclidean length of a polyline given as image-space points.
fn polyline_length_pts(poly: &[[f64; 2]]) -> f64 {
    poly.windows(2)
        .map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt())
        .sum()
}

/// Zhang–Suen thinning. `img`: 1 = foreground, 0 = background; the 1px border is
/// assumed background (callers pad). Iterates until no pixel is removed.
fn zhang_suen_thin(img: &mut [u8], w: usize, h: usize) {
    loop {
        let mut changed = false;
        for step in 0..2 {
            let mut remove = Vec::new();
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    if img[y * w + x] == 0 {
                        continue;
                    }
                    // Neighbours p2..p9 clockwise from north.
                    let p = [
                        img[(y - 1) * w + x],     // p2 N
                        img[(y - 1) * w + x + 1], // p3 NE
                        img[y * w + x + 1],       // p4 E
                        img[(y + 1) * w + x + 1], // p5 SE
                        img[(y + 1) * w + x],     // p6 S
                        img[(y + 1) * w + x - 1], // p7 SW
                        img[y * w + x - 1],       // p8 W
                        img[(y - 1) * w + x - 1], // p9 NW
                    ];
                    let b: u8 = p.iter().sum();
                    if b < 2 || b > 6 {
                        continue;
                    }
                    // A = 0→1 transitions around the ring.
                    let mut a = 0;
                    for i in 0..8 {
                        if p[i] == 0 && p[(i + 1) % 8] == 1 {
                            a += 1;
                        }
                    }
                    if a != 1 {
                        continue;
                    }
                    let (n, e, s, wst) = (p[0], p[2], p[4], p[6]);
                    if step == 0 {
                        if n * e * s != 0 || e * s * wst != 0 {
                            continue;
                        }
                    } else if n * e * wst != 0 || n * s * wst != 0 {
                        continue;
                    }
                    remove.push(y * w + x);
                }
            }
            if !remove.is_empty() {
                changed = true;
                for idx in remove {
                    img[idx] = 0;
                }
            }
        }
        if !changed {
            break;
        }
    }
}

/// The 8-connected foreground neighbours of pixel `idx` on a padded grid.
fn fg_neighbors(img: &[u8], w: usize, idx: usize) -> Vec<usize> {
    let (x, y) = (idx % w, idx / w);
    let mut out = Vec::with_capacity(8);
    for dy in -1i64..=1 {
        for dx in -1i64..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let ni = ((y as i64 + dy) as usize) * w + (x as i64 + dx) as usize;
            if img[ni] != 0 {
                out.push(ni);
            }
        }
    }
    out
}

/// True when pixels `a` and `b` are within a 3×3 window of each other.
fn are_8_adjacent(a: usize, b: usize, w: usize) -> bool {
    if a == b {
        return false;
    }
    let (ax, ay) = ((a % w) as i64, (a / w) as i64);
    let (bx, by) = ((b % w) as i64, (b / w) as i64);
    (ax - bx).abs() <= 1 && (ay - by).abs() <= 1
}

/// Crossing number: the count of 0→1 transitions around the ordered 8-ring. This
/// is the topological branch count and, unlike a raw neighbour count, is immune
/// to the staircase corners an 8-connected skeleton leaves along slanted lines:
/// 1 = endpoint, 2 = pass-through pixel, ≥3 = junction. Assumes a padded grid so
/// the ring is always in bounds.
fn crossing_number(img: &[u8], w: usize, idx: usize) -> u32 {
    let (x, y) = (idx % w, idx / w);
    // p2..p9 clockwise from north: N, NE, E, SE, S, SW, W, NW.
    let ring = [
        img[(y - 1) * w + x],
        img[(y - 1) * w + x + 1],
        img[y * w + x + 1],
        img[(y + 1) * w + x + 1],
        img[(y + 1) * w + x],
        img[(y + 1) * w + x - 1],
        img[y * w + x - 1],
        img[(y - 1) * w + x - 1],
    ];
    let mut c = 0;
    for i in 0..8 {
        if ring[i] == 0 && ring[(i + 1) % 8] == 1 {
            c += 1;
        }
    }
    c
}

/// A skeleton node is an endpoint (crossing number 1) or a junction (≥ 3);
/// pass-through pixels (2) and isolated pixels (0) are not nodes.
fn is_skeleton_node(img: &[u8], w: usize, idx: usize) -> bool {
    let cn = crossing_number(img, w, idx);
    cn == 1 || cn >= 3
}

/// One edge of the skeleton graph: a branch between two nodes `a` and `b`, with
/// its dense pixel polyline (`pts`, from `a` to `b` inclusive).
struct SkelEdge {
    a: usize,
    b: usize,
    pts: Vec<usize>,
    alive: bool,
}

/// Trace a 1px skeleton into centerline polylines. The skeleton is turned into a
/// node/edge graph (nodes = endpoints/junctions by crossing number, edges =
/// branches between them), which is then simplified so a hand-drawn line doesn't
/// shatter at every little bump: short spurs are pruned and the degree-2 nodes
/// they leave behind are contracted, so the trunk stays one path and only real
/// ≥3-way intersections split it.
fn trace_skeleton(img: &[u8], w: usize, h: usize, dt: &[f32]) -> Vec<Vec<[f64; 2]>> {
    let pt = |idx: usize| [(idx % w) as f64 - 1.0, (idx / w) as f64 - 1.0];
    let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };

    let fg: Vec<usize> = (0..w * h).filter(|&i| img[i] != 0).collect();
    let mut visited = std::collections::HashSet::new();
    let mut paths: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut edges: Vec<SkelEdge> = Vec::new();

    // Walk a chain from `start` through neighbour `first` until the next node (or
    // a dead end / already-walked edge). Next-pixel priority:
    //   1. a neighbouring *node* (junction/endpoint) — so a walk terminates AT a
    //      junction instead of cutting the corner diagonally into an adjacent
    //      arm (the 8-connected pixels around a junction are pass-throughs);
    //   2. a neighbour *not* adjacent to where we came from — so a staircase's
    //      diagonal shortcut doesn't spawn a false branch;
    //   3. any remaining neighbour.
    let walk = |start: usize, first: usize, visited: &mut std::collections::HashSet<(usize, usize)>| {
        let mut poly = vec![start];
        let (mut prev, mut cur) = (start, first);
        visited.insert(key(prev, cur));
        poly.push(cur);
        while !is_skeleton_node(img, w, cur) {
            let mut node_choice = None;
            let mut choice = None;
            let mut fallback = None;
            for q in fg_neighbors(img, w, cur) {
                if q == prev || visited.contains(&key(cur, q)) {
                    continue;
                }
                if is_skeleton_node(img, w, q) {
                    node_choice = Some(q);
                    break;
                }
                if choice.is_none() && !are_8_adjacent(q, prev, w) {
                    choice = Some(q);
                }
                fallback.get_or_insert(q);
            }
            let Some(q) = node_choice.or(choice).or(fallback) else { break };
            visited.insert(key(cur, q));
            poly.push(q);
            prev = cur;
            cur = q;
        }
        poly
    };

    // 1. Branches anchored at nodes (endpoints / junctions) → graph edges.
    for &n in &fg {
        if !is_skeleton_node(img, w, n) {
            continue;
        }
        for m in fg_neighbors(img, w, n) {
            if visited.contains(&key(n, m)) {
                continue;
            }
            let pts = walk(n, m, &mut visited);
            let b = *pts.last().unwrap();
            edges.push(SkelEdge { a: n, b, pts, alive: true });
        }
    }

    // 2. Pure loops: pass-through chains with no node → emitted directly.
    for &s in &fg {
        if is_skeleton_node(img, w, s) {
            continue;
        }
        let Some(m) = fg_neighbors(img, w, s).into_iter().find(|&q| !visited.contains(&key(s, q)))
        else {
            continue;
        };
        let poly = walk(s, m, &mut visited);
        if poly.len() >= 3 {
            paths.push(poly.iter().map(|&i| pt(i)).collect());
        }
    }

    simplify_graph(&mut edges, w, dt);

    for e in &edges {
        if e.alive && e.pts.len() >= 2 {
            paths.push(e.pts.iter().map(|&i| pt(i)).collect());
        }
    }
    paths
}

/// Node → count of alive incident edges (a self-loop counts twice).
fn degree_map(edges: &[SkelEdge]) -> std::collections::HashMap<usize, usize> {
    let mut deg = std::collections::HashMap::new();
    for e in edges.iter().filter(|e| e.alive) {
        *deg.entry(e.a).or_insert(0) += 1;
        *deg.entry(e.b).or_insert(0) += 1;
    }
    deg
}

/// Simplify the skeleton graph in place. Prune short spurs / junction links and
/// contract degree-2 nodes, **interleaved** to a fixpoint: pruning an artefact
/// branch drops a junction to degree 2, which contraction then splices into its
/// neighbour, which can expose the next artefact — so a curved band's messy
/// extrema collapse into the through-path instead of fragmenting.
fn simplify_graph(edges: &mut Vec<SkelEdge>, w: usize, dt: &[f32]) {
    loop {
        let pruned = prune_pass(edges, w, dt);
        let popped = collapse_bubbles(edges, w, dt);
        let contracted = contract_pass(edges);
        if !pruned && !popped && !contracted {
            break;
        }
    }
    edges.retain(|e| e.alive);
}

/// One pass: kill leaf spurs — branches ending at a free endpoint that are short
/// relative to the inscribed disc at the junction they hang off. (Short links
/// *between* two junctions are left intact so real multi-way junctions, which an
/// 8-connected skeleton often spreads over 2 pixels, aren't collapsed.)
///
/// The base must be a real junction (degree ≥ 3). A branch whose *other* end is
/// also free is not a spur — it is the trunk, possibly the last thing left after
/// its siblings were pruned, and deleting it would return nothing at all.
fn prune_pass(edges: &mut [SkelEdge], w: usize, dt: &[f32]) -> bool {
    let deg = degree_map(edges);
    let mut changed = false;
    for e in edges.iter_mut().filter(|e| e.alive) {
        let (da, db) = (deg.get(&e.a).copied().unwrap_or(0), deg.get(&e.b).copied().unwrap_or(0));
        let base = if da == 1 && db >= 3 {
            e.b
        } else if db == 1 && da >= 3 {
            e.a
        } else {
            continue;
        };
        let limit = MIN_SPUR_LEN.max(SPUR_RADIUS_FACTOR * dt[base] as f64);
        if polyline_len(&e.pts, w) < limit {
            e.alive = false;
            changed = true;
        }
    }
    changed
}

/// One pass: pop thinning bubbles — two separate branches joining the *same* pair
/// of nodes, which is what thinning wraps around a small hole in the region. A
/// predicted mask is full of them, and neither spur pruning (both ends are
/// junctions) nor contraction (both nodes are degree 3) can touch one.
///
/// The longest arc survives and the rest are dropped, but only when they are
/// short against the disc at the join — so a hole small relative to the band that
/// contains it pops, while a genuine ring, whose arcs dwarf its own thickness,
/// keeps its loop. Both nodes then fall to degree 2 and contraction splices the
/// trunk back into one path.
fn collapse_bubbles(edges: &mut [SkelEdge], w: usize, dt: &[f32]) -> bool {
    let mut by_pair: std::collections::HashMap<(usize, usize), Vec<usize>> =
        std::collections::HashMap::new();
    for (i, e) in edges.iter().enumerate() {
        if e.alive && e.a != e.b {
            let pair = if e.a < e.b { (e.a, e.b) } else { (e.b, e.a) };
            by_pair.entry(pair).or_default().push(i);
        }
    }

    let mut changed = false;
    for ((a, b), group) in by_pair {
        if group.len() < 2 {
            continue;
        }
        let limit = MIN_SPUR_LEN.max(SPUR_RADIUS_FACTOR * (dt[a].max(dt[b])) as f64);
        let keep = group
            .iter()
            .copied()
            .max_by(|&i, &j| {
                polyline_len(&edges[i].pts, w).total_cmp(&polyline_len(&edges[j].pts, w))
            })
            .expect("group is non-empty");
        for i in group {
            if i != keep && polyline_len(&edges[i].pts, w) < limit {
                edges[i].alive = false;
                changed = true;
            }
        }
    }
    changed
}

/// Contract every degree-2 node (to a fixpoint): splice its two branches into one.
fn contract_pass(edges: &mut Vec<SkelEdge>) -> bool {
    let mut any = false;
    loop {
        let deg = degree_map(edges);
        let Some(v) = deg
            .iter()
            .find(|&(_, &d)| d == 2)
            .map(|(&v, _)| v)
            .filter(|&v| {
                // Skip a lone self-loop (its single edge already gives degree 2).
                edges.iter().filter(|e| e.alive && (e.a == v || e.b == v)).count() == 2
            })
        else {
            break;
        };

        let inc: Vec<usize> = (0..edges.len())
            .filter(|&i| edges[i].alive && (edges[i].a == v || edges[i].b == v))
            .collect();
        let (i1, i2) = (inc[0], inc[1]);

        // Orient edge 1 to END at v, edge 2 to START at v, then concatenate.
        let mut left = std::mem::take(&mut edges[i1].pts);
        let other1 = if edges[i1].b == v {
            edges[i1].a
        } else {
            left.reverse();
            edges[i1].b
        };
        let mut right = std::mem::take(&mut edges[i2].pts);
        let other2 = if edges[i2].a == v {
            edges[i2].b
        } else {
            right.reverse();
            edges[i2].a
        };
        edges[i1].alive = false;
        edges[i2].alive = false;

        left.extend(right.into_iter().skip(1)); // drop the duplicated `v`
        edges.push(SkelEdge { a: other1, b: other2, pts: left, alive: true });
        any = true;
    }
    any
}

/// Total length (px) of a polyline given as padded-grid pixel indices.
fn polyline_len(poly: &[usize], w: usize) -> f64 {
    let mut len = 0.0;
    for pair in poly.windows(2) {
        let (ax, ay) = ((pair[0] % w) as f64, (pair[0] / w) as f64);
        let (bx, by) = ((pair[1] % w) as f64, (pair[1] / w) as f64);
        len += ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
    }
    len
}

/// Axis-aligned bounds `[x, y, w, h]` of a polygon.
pub fn polygon_bounds(points: &[[f64; 2]]) -> [f64; 4] {
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in points {
        minx = minx.min(p[0]);
        miny = miny.min(p[1]);
        maxx = maxx.max(p[0]);
        maxy = maxy.max(p[1]);
    }
    if points.is_empty() {
        return [0.0, 0.0, 0.0, 0.0];
    }
    [minx, miny, maxx - minx, maxy - miny]
}

/// Douglas–Peucker polyline simplification. Contours are pixel-dense; this trims
/// collinear runs so exported polygons are compact.
fn douglas_peucker(pts: &[[f64; 2]], epsilon: f64) -> Vec<[f64; 2]> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let (first, last) = (pts[0], pts[pts.len() - 1]);
    let mut idx = 0;
    let mut dmax = 0.0;
    for i in 1..pts.len() - 1 {
        let d = perp_distance(pts[i], first, last);
        if d > dmax {
            dmax = d;
            idx = i;
        }
    }
    if dmax > epsilon {
        let mut left = douglas_peucker(&pts[..=idx], epsilon);
        let right = douglas_peucker(&pts[idx..], epsilon);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![first, last]
    }
}

fn perp_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = (dx * dx + dy * dy).sqrt();
    if len == 0.0 {
        return ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt();
    }
    (dx * (a[1] - p[1]) - (a[0] - p[0]) * dy).abs() / len
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Longest x-span over all points of all paths (rough length proxy).
    fn max_x_span(paths: &[Vec<[f64; 2]>]) -> f64 {
        paths
            .iter()
            .map(|p| {
                let xs: Vec<f64> = p.iter().map(|q| q[0]).collect();
                xs.iter().cloned().fold(f64::MIN, f64::max)
                    - xs.iter().cloned().fold(f64::MAX, f64::min)
            })
            .fold(0.0, f64::max)
    }

    /// Even-odd point-in-polygon, mirroring the scanline parity that
    /// `commands::vector::fill_polygon` and the editor's SVG layer both use — so
    /// these assertions test what the renderers will actually draw.
    fn inside_evenodd(ring: &[[f64; 2]], x: f64, y: f64) -> bool {
        let n = ring.len();
        let mut inside = false;
        for i in 0..n {
            let (x1, y1) = (ring[i][0], ring[i][1]);
            let (x2, y2) = (ring[(i + 1) % n][0], ring[(i + 1) % n][1]);
            if (y1 <= y && y2 > y) || (y2 <= y && y1 > y) {
                let t = (y - y1) / (y2 - y1);
                if x1 + t * (x2 - x1) > x {
                    inside = !inside;
                }
            }
        }
        inside
    }

    /// A filled disc of radius `r` centred on `(cx, cy)`, minus an optional
    /// concentric bite of radius `hole`.
    fn annulus(w: u32, h: u32, cx: f64, cy: f64, r: f64, hole: f64) -> Vec<u8> {
        let mut m = vec![0u8; (w * h) as usize];
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f64 - cx).powi(2) + (y as f64 - cy).powi(2)).sqrt();
                if d <= r && d > hole {
                    m[(y * w + x) as usize] = 1;
                }
            }
        }
        m
    }

    #[test]
    fn a_donut_keeps_its_hole() {
        let (w, h) = (48u32, 48u32);
        let (c, r, hole) = (24.0, 16.0, 7.0);
        let regions = regions_from_mask(&annulus(w, h, c, c, r, hole), w, h, false);
        assert_eq!(regions.len(), 1, "the annulus is one connected component");
        assert_eq!(regions[0].polygons.len(), 1, "outer and hole bridged into one ring");
        let ring = &regions[0].polygons[0];

        assert!(!inside_evenodd(ring, c, c), "the centre must read as background");
        // Midway through the annulus wall, on each side of the centre.
        let mid = (r + hole) / 2.0;
        assert!(inside_evenodd(ring, c + mid, c), "the wall must read as foreground");
        assert!(inside_evenodd(ring, c - mid, c), "the wall must read as foreground");
        assert!(!inside_evenodd(ring, c, 1.0), "outside stays outside");
    }

    #[test]
    fn two_holes_are_both_cut_out() {
        let (w, h) = (60u32, 40u32);
        let mut m = vec![1u8; (w * h) as usize];
        // Clear the border so the block is not flush against the image edge.
        for x in 0..w {
            m[x as usize] = 0;
            m[((h - 1) * w + x) as usize] = 0;
        }
        for y in 0..h {
            m[(y * w) as usize] = 0;
            m[(y * w + w - 1) as usize] = 0;
        }
        let punch = |m: &mut Vec<u8>, cx: u32, cy: u32| {
            for y in cy - 3..=cy + 3 {
                for x in cx - 3..=cx + 3 {
                    m[(y * w + x) as usize] = 0;
                }
            }
        };
        punch(&mut m, 15, 20);
        punch(&mut m, 45, 20);

        let regions = regions_from_mask(&m, w, h, false);
        assert_eq!(regions.len(), 1);
        let ring = &regions[0].polygons[0];
        assert!(!inside_evenodd(ring, 15.0, 20.0), "first hole");
        assert!(!inside_evenodd(ring, 45.0, 20.0), "second hole");
        assert!(inside_evenodd(ring, 30.0, 20.0), "the bar between them is solid");
    }

    #[test]
    fn a_one_pixel_dropout_is_not_cut_out() {
        // A stray missing pixel is prediction noise; cutting it out would add a
        // bridge corridor to the ring for no visible gain.
        let (w, h) = (32u32, 32u32);
        let mut m = annulus(w, h, 16.0, 16.0, 12.0, 0.0);
        m[(16 * w + 16) as usize] = 0;
        let regions = regions_from_mask(&m, w, h, false);
        assert_eq!(regions[0].polygons.len(), 1);
        assert!(
            inside_evenodd(&regions[0].polygons[0], 16.0, 16.0),
            "a single-pixel dropout must stay filled"
        );
    }

    #[test]
    fn a_solid_blob_is_unchanged_by_hole_handling() {
        let (w, h) = (32u32, 32u32);
        let regions = regions_from_mask(&annulus(w, h, 16.0, 16.0, 10.0, 0.0), w, h, false);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].polygons.len(), 1);
        assert!(inside_evenodd(&regions[0].polygons[0], 16.0, 16.0));
    }

    #[test]
    fn skeleton_background_seed_is_empty() {
        let values = vec![0u8; 6 * 6];
        assert!(component_skeleton_paths(&values, 6, 6, 3, 3).is_empty());
    }

    #[test]
    fn skeleton_of_thick_bar_is_one_line() {
        // A 3px-thick horizontal bar, x in 1..=10, y in 2..=4, on a 12x7 grid.
        let (w, h) = (12u32, 7u32);
        let mut values = vec![0u8; (w * h) as usize];
        for y in 2..=4 {
            for x in 1..=10 {
                values[(y * w + x) as usize] = 1;
            }
        }
        let paths = component_skeleton_paths(&values, w, h, 5, 3);
        assert_eq!(paths.len(), 1, "a straight bar is a single branch");
        // Its centerline spans most of the bar's length (thinning erodes the
        // thick ends inward by ~2px, so a length-10 bar yields a ~6px line).
        assert!(max_x_span(&paths) >= 5.0, "span was {}", max_x_span(&paths));
    }

    #[test]
    fn skeleton_of_slanted_line_stays_one_piece() {
        // A 1px staircase (a hand-drawn "almost straight" slanted line). Its
        // corners have 3 raw neighbours but crossing number 2, so it must trace
        // as a single path — not fragment at every step.
        let (w, h) = (24u32, 10u32);
        let mut values = vec![0u8; (w * h) as usize];
        let mut y = 3u32;
        for x in 1..=20 {
            values[(y * w + x) as usize] = 1;
            if x % 3 == 0 && y + 1 < h {
                y += 1; // step down every few pixels
            }
        }
        let paths = component_skeleton_paths(&values, w, h, 6, 4);
        assert_eq!(paths.len(), 1, "a slanted line must not fragment");
        assert!(max_x_span(&paths) >= 15.0, "span was {}", max_x_span(&paths));
    }

    #[test]
    fn skeleton_of_line_with_nub_stays_one_piece() {
        // A straight line with a 1px bump. The bump makes a degree-3 junction,
        // but pruning the spur + contracting the leftover degree-2 node must
        // re-join the trunk into a single path.
        let (w, h) = (18u32, 9u32);
        let mut values = vec![0u8; (w * h) as usize];
        for x in 1..=15 {
            values[(5 * w + x) as usize] = 1; // horizontal line
        }
        values[(4 * w + 8) as usize] = 1; // one-pixel nub above the middle
        let paths = component_skeleton_paths(&values, w, h, 6, 5);
        assert_eq!(paths.len(), 1, "a line with a small nub must not split");
        assert!(max_x_span(&paths) >= 12.0, "span was {}", max_x_span(&paths));
    }

    #[test]
    fn skeleton_of_wavy_thick_fibre_is_one_path() {
        // A wavy thick "fibre": centerline y = 20 + 9*sin(x/9), ~7px thick. Raster
        // thinning leaves messy chunks at the curve extrema; the graph cleanup
        // must still return a single unbranched centerline (not a pile of
        // fragments).
        let (w, h) = (60u32, 40u32);
        let mut values = vec![0u8; (w * h) as usize];
        for xi in 4..=55 {
            let cx = xi as f64;
            let cy = 20.0 + 9.0 * (cx / 9.0).sin();
            let r = 3.5;
            let r0 = (r + 1.0) as i64;
            for oy in -r0..=r0 {
                for ox in -r0..=r0 {
                    let (px, py) = (cx + ox as f64, cy + oy as f64);
                    if px < 0.0 || py < 0.0 || px >= w as f64 || py >= h as f64 {
                        continue;
                    }
                    if (ox * ox + oy * oy) as f64 <= r * r {
                        values[(py as u32 * w + px as u32) as usize] = 1;
                    }
                }
            }
        }
        let paths = component_skeleton_paths(&values, w, h, 28, 19);
        assert_eq!(paths.len(), 1, "a wavy fibre must trace as one path");
    }

    /// A ~22px-thick bar over `x in 5..=58` on a 64x48 grid. With `bump`, its top
    /// edge sticks up by 2px every fifth column — ordinary boundary roughness for
    /// a painted or predicted region. (1px is below the threshold where thinning
    /// seeds a branch at all; it gets eaten first.)
    fn thick_bar(bump: bool) -> (u32, u32, Vec<u8>) {
        let (w, h) = (64u32, 48u32);
        let mut values = vec![0u8; (w * h) as usize];
        for x in 5..=58u32 {
            let top = if bump && x % 5 == 0 { 10 } else { 12 };
            for y in top..=33 {
                values[(y * w + x) as usize] = 1;
            }
        }
        (w, h, values)
    }

    #[test]
    fn a_rough_thick_bar_is_still_one_line() {
        // The reported failure. Each bump seeds a branch running from the boundary
        // in to the medial axis — about half the thickness, ~11px — so the fixed
        // 5px spur threshold kept every one of them and this came back as *ten*
        // fragments. Judged against the disc at its base, each is noise.
        let (w, h, values) = thick_bar(true);
        let paths = component_skeleton_paths(&values, w, h, 30, 22);
        assert_eq!(paths.len(), 1, "a rough thick bar must not shatter");
        assert!(max_x_span(&paths) >= 30.0, "span was {}", max_x_span(&paths));
    }

    #[test]
    fn roughness_does_not_change_the_result() {
        // The smooth and rough bars differ only in 1px boundary noise, so they
        // must skeletonize the same way. This is the scale-invariance the fixed
        // threshold could not give.
        let (w, h, smooth) = thick_bar(false);
        let (_, _, rough) = thick_bar(true);
        assert_eq!(
            component_skeleton_paths(&smooth, w, h, 30, 20).len(),
            component_skeleton_paths(&rough, w, h, 30, 20).len(),
        );
    }

    #[test]
    fn a_small_hole_does_not_split_the_centerline() {
        // Thinning wraps the skeleton around a hole, leaving two parallel arcs
        // between the same pair of junctions. Spur pruning cannot see them (both
        // ends are junctions) and contraction cannot either (both are degree 3),
        // so before `collapse_bubbles` a single dropout in a predicted mask split
        // the centerline in two.
        let (w, h, mut values) = thick_bar(false);
        for y in 19..=21u32 {
            for x in 30..=32u32 {
                values[(y * w + x) as usize] = 0;
            }
        }
        let paths = component_skeleton_paths(&values, w, h, 10, 20);
        assert_eq!(paths.len(), 1, "a small hole must not split the centerline");
    }

    #[test]
    fn a_ring_keeps_its_loop() {
        // The other side of the bubble rule: an annulus is *made* of a loop, and
        // its arcs dwarf its own thickness, so it must come back whole.
        let (w, h) = (48u32, 48u32);
        let values = annulus(w, h, 24.0, 24.0, 18.0, 13.0);
        let paths = component_skeleton_paths(&values, w, h, 24, 9);
        assert_eq!(paths.len(), 1, "a ring is one closed centerline");
        let len = polyline_length_pts(&paths[0]);
        assert!(len >= 60.0, "the loop was cut short: length {len}");
    }

    #[test]
    fn skeleton_of_plus_has_four_arms() {
        // A plus: 1px vertical + horizontal bars crossing at the centre. Arms are
        // long enough to clear the min-output-length filter.
        let (w, h) = (25u32, 25u32);
        let mut values = vec![0u8; (w * h) as usize];
        let c = 12u32;
        for i in 1..=23 {
            values[(c * w + i) as usize] = 1; // horizontal arm
            values[(i * w + c) as usize] = 1; // vertical arm
        }
        let paths = component_skeleton_paths(&values, w, h, c, c);
        // Four arms radiate from the junction (the walk terminates at it rather
        // than cutting the corner into an adjacent arm).
        assert!(paths.len() >= 4, "expected >= 4 arms, got {}", paths.len());
    }
}
