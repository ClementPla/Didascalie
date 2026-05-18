// helpers/render-warp.ts

import {
  HomographyTransform,
  Point2D,
  Transform2D,
  applyTransform,
  homographyToCssMatrix3d,
  invertHomography,
} from './registration.model';

// ==========================================
// Point mapping (used for residuals, predicted target indicator)
// ==========================================

/**
 * Map a single point from moving-native space to reference-native space
 * through the current transform. Identity for non-homography transforms.
 */
export function mapMovingToRef(p: Point2D, t: Transform2D): Point2D {
  return applyTransform(t, p);
}

/**
 * Map a reference-native point back to moving-native space.
 * Returns null when the transform isn't a homography or its inverse is
 * singular. Callers treat null as "no prediction available".
 *
 * Used for the predicted-moving indicator: when the user has placed a
 * pending reference point and there's a fit, we show where it should
 * land on the moving image by running the inverse transform.
 */
export function inverseMapToMoving(p: Point2D, t: Transform2D): Point2D | null {
  if (t.type !== 'homography') return null;
  const inv = invertHomography(t);
  if (!inv) return null;
  return applyTransform(inv, p);
}

// ==========================================
// CSS rendering for the warped moving image
// ==========================================

/**
 * Build the CSS `transform` string that warps a moving-image element from
 * its own image-pixel space into the reference viewport's display space.
 *
 * The composition (innermost first):
 *   1. The moving image is rendered as an HTML img element with its natural
 *      dimensions; coords run from (0,0) to (W_moving, H_moving) in image px.
 *   2. The homography H maps moving-native → ref-native px.
 *   3. The reference viewport's view transform maps ref-native → CSS px in
 *      the viewport.
 *
 * CSS applies transforms right-to-left, so the string is:
 *   `translate(offset) scale(scale) matrix3d(homography)`
 *
 * The moving `<img>` element should be positioned at top:0; left:0 with
 * `transform-origin: 0 0` so the composed transform is exact. The width
 * and height of the `<img>` are set to the moving image's *native*
 * dimensions in CSS px — the scale step handles the resize.
 *
 * Returns null if the transform is non-homography (caller should hide the
 * warped image in that case).
 */
export function buildWarpedImageTransform(
  transform: Transform2D,
  refViewScale: number,
  refViewOffset: Point2D,
): string | null {
  if (transform.type !== 'homography') return null;

  // CSS composition right-to-left: the innermost transform (matrix3d, which
  // operates on the image's own pixel coordinates) goes last in the string.
  // Then scale, then translate.
  return `translate(${refViewOffset.x}px, ${refViewOffset.y}px) ` +
         `scale(${refViewScale}) ` +
         homographyToCssMatrix3d(transform as HomographyTransform);
}

/**
 * Convenience: validate that the homography won't produce a visually broken
 * render (degenerate, mirror-flipped, or extreme perspective). Returns a
 * brief reason string when something's off, or null when the transform is
 * safe to apply.
 *
 * Browsers handle exotic matrix3d inputs inconsistently — some clip silently,
 * some show garbage. We use this to optionally suppress rendering or warn
 * the user when the fit has gone off the rails.
 */
export function diagnoseHomography(t: Transform2D): string | null {
  if (t.type !== 'homography') return null;
  const [h00, h01, _h02, h10, h11, _h12, _h20, _h21, h22] = t.matrix;

  // Determinant of the upper-left 2×2 tells us about reflection.
  const det2 = h00 * h11 - h01 * h10;
  if (det2 < 0) return 'mirror-flip';
  if (Math.abs(det2) < 1e-6) return 'degenerate';

  // h22 should be 1 by canonical normalization. If it's wildly off, something
  // broke in the solver.
  if (!Number.isFinite(h22) || Math.abs(h22 - 1) > 1e-3) return 'unnormalized';

  // Any NaN/Infinity in the matrix.
  for (const v of t.matrix) {
    if (!Number.isFinite(v)) return 'non-finite';
  }

  return null;
}