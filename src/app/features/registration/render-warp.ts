import {
  HomographyTransform,
  Point2D,
  Transform2D,
  applyTransform,
  homographyToCssMatrix3d,
  invertHomography,
} from './registration.model';

// ── Point mapping (used for residuals, predicted target indicator) ─────────

/** Map a point from moving-native to reference-native space. Identity for
 *  non-homography transforms. */
export function mapMovingToRef(p: Point2D, t: Transform2D): Point2D {
  return applyTransform(t, p);
}

/** Map a reference-native point back to moving-native space. Null when the
 *  transform is not a homography or cannot be inverted. */
export function inverseMapToMoving(p: Point2D, t: Transform2D): Point2D | null {
  if (t.type !== 'homography') return null;
  const inv = invertHomography(t);
  if (!inv) return null;
  return applyTransform(inv, p);
}

// ── CSS rendering for the warped moving image ──────────────────────────────

/**
 * The CSS `transform` that warps the moving `<img>` into the reference
 * viewport: `translate(offset) scale(scale) matrix3d(homography)`, applied
 * right to left. The `<img>` must be at top/left 0 with
 * `transform-origin: 0 0`, at the moving image's native size. Null for a
 * non-homography transform.
 */
export function buildWarpedImageTransform(
  transform: Transform2D,
  refViewScale: number,
  refViewOffset: Point2D,
): string | null {
  if (transform.type !== 'homography') return null;

  return `translate(${refViewOffset.x}px, ${refViewOffset.y}px) ` +
         `scale(${refViewScale}) ` +
         homographyToCssMatrix3d(transform as HomographyTransform);
}

/** Why a homography would render badly (degenerate, mirrored, extreme
 *  perspective), or null. Browsers handle such `matrix3d` inconsistently. */
export function diagnoseHomography(t: Transform2D): string | null {
  if (t.type !== 'homography') return null;
  const [h00, h01, _h02, h10, h11, _h12, _h20, _h21, h22] = t.matrix;

  // The upper-left 2×2 determinant is negative for a reflection.
  const det2 = h00 * h11 - h01 * h10;
  if (det2 < 0) return 'mirror-flip';
  if (Math.abs(det2) < 1e-6) return 'degenerate';

  if (!Number.isFinite(h22) || Math.abs(h22 - 1) > 1e-3) return 'unnormalized';

  for (const v of t.matrix) {
    if (!Number.isFinite(v)) return 'non-finite';
  }

  return null;
}