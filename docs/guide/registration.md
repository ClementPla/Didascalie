# Frame registration

Registration aligns two frames of a sequence. You place corresponding keypoints on
both, and a homography is estimated from them.

## The workflow

1. Open the registration view and pick a **reference** frame and a **moving** frame
   from the sequence.
2. Click a point on the reference, then its counterpart on the moving frame. Repeat.
3. The estimated homography updates as you go. A homography needs at least four
   correspondences, and more improve the fit.

Several reference/moving pairs can be saved per sequence as separate cases. A
sequence with several acquisitions can therefore keep one registration for each.

## Checking the result

Check the alignment visually. The numeric fit alone can be misleading.

- **Overlay** blends the warped moving frame over the reference.
- **Checkerboard** alternates tiles from each frame, so misaligned edges break at
  the tile borders.

When the estimated transform is degenerate (a near-singular homography), the
warped image is meaningless. The view hides it and shows a warning.

## Suggested correspondences

A Python function of yours can propose keypoint pairs, so that you do not place
them all by hand. This is experimental: see
[Experimental features](../experimental.md#keypoint-suggestion).

<!-- SCREENSHOT: side-by-side panes with a few numbered correspondences placed. -->
