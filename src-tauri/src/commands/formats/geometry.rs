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
    /// Outer contour rings, image-pixel coordinates.
    pub polygons: Vec<Vec<[f64; 2]>>,
}

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
    let mut polygons = Vec::new();
    for c in find_contours::<u32>(&img) {
        if c.border_type == BorderType::Outer && c.points.len() >= 3 {
            let ring: Vec<[f64; 2]> =
                c.points.iter().map(|p| [p.x as f64, p.y as f64]).collect();
            let simplified = douglas_peucker(&ring, 1.5);
            if simplified.len() >= 3 {
                polygons.push(simplified);
            }
        }
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

/// Minimum length (px) of an endpoint branch (spur) kept in the traced skeleton.
/// Trims the short hairs thinning leaves along a thick/rough shape's edges; the
/// degree-2 node each pruned spur leaves behind is then contracted so the trunk
/// stays continuous. Kept below a typical real branch length.
const MIN_SPUR_LEN: f64 = 5.0;
/// Douglas–Peucker tolerance for skeleton polylines (finer than contour tracing
/// so curved centerlines stay smooth).
const SKELETON_EPSILON: f64 = 1.0;
/// Minimum length (px) of a returned centerline path. Prunes the tiny artefact
/// branches thinning leaves at curve extrema; the longest path is always kept.
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

    // Work on a 1px-padded grid (1 = fg) so thinning/tracing never touch the
    // image border; coords are shifted back by 1 when emitting points.
    let (wu, hu) = (w as usize, h as usize);
    let (pw, ph) = (wu + 2, hu + 2);
    let mut grid = vec![0u8; pw * ph];
    for y in 0..hu {
        for x in 0..wu {
            if bin[y * wu + x] != 0 {
                grid[(y + 1) * pw + (x + 1)] = 1;
            }
        }
    }

    zhang_suen_thin(&mut grid, pw, ph);

    let simplified: Vec<Vec<[f64; 2]>> = trace_skeleton(&grid, pw, ph)
        .into_iter()
        .map(|poly| douglas_peucker(&poly, SKELETON_EPSILON))
        .filter(|poly| poly.len() >= 2)
        .collect();

    // Drop leftover clutter (the tiny artefact branches raster thinning leaves at
    // a thick curved band's high-curvature extrema) while always keeping the
    // longest path, so an unbranched fibre comes back as a single clean line.
    let max_len = simplified
        .iter()
        .map(|p| polyline_length_pts(p))
        .fold(0.0, f64::max);
    let keep_min = MIN_OUTPUT_LEN.min(max_len);
    simplified
        .into_iter()
        .filter(|p| polyline_length_pts(p) >= keep_min)
        .collect()
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
fn trace_skeleton(img: &[u8], w: usize, h: usize) -> Vec<Vec<[f64; 2]>> {
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

    simplify_graph(&mut edges, w);

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
fn simplify_graph(edges: &mut Vec<SkelEdge>, w: usize) {
    loop {
        let pruned = prune_pass(edges, w);
        let contracted = contract_pass(edges);
        if !pruned && !contracted {
            break;
        }
    }
    edges.retain(|e| e.alive);
}

/// One pass: kill leaf spurs — short branches ending at a free endpoint. (Short
/// links *between* two junctions are left intact so real multi-way junctions,
/// which an 8-connected skeleton often spreads over 2 pixels, aren't collapsed.)
fn prune_pass(edges: &mut [SkelEdge], w: usize) -> bool {
    let deg = degree_map(edges);
    let mut changed = false;
    for e in edges.iter_mut().filter(|e| e.alive) {
        let (da, db) = (deg.get(&e.a).copied().unwrap_or(0), deg.get(&e.b).copied().unwrap_or(0));
        let is_spur = (da == 1 || db == 1) && polyline_len(&e.pts, w) < MIN_SPUR_LEN;
        if is_spur {
            e.alive = false;
            changed = true;
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
        // fragments, which is what the naive tracer produced).
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
