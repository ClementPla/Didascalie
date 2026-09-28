# Frame registration

Registration aligns two frames of a sequence by placing corresponding keypoints and
estimating a homography between them.

## The workflow

1. Open the registration view and pick a **reference** frame and a **moving** frame
   from the sequence.
2. Click a point on the reference, then its counterpart on the moving frame. Repeat.
3. The estimated homography updates as you go. Four correspondences is the minimum
   for a homography; more improve the fit.

Several reference/moving pairs can be saved per sequence as separate cases, so a
sequence with multiple acquisitions does not lose earlier work.

## Checking the result

Verification views matter more than the numeric fit:

- **Overlay** blends the warped moving frame over the reference.
- **Checkerboard** alternates tiles from each, making edge discontinuities obvious.

The view warns when the estimated transform is degenerate — a near-singular
homography produces visual nonsense, so it is hidden rather than drawn.

## Suggested correspondences

An optional bridge to a Python process can propose keypoint pairs instead of placing
them all by hand. This is experimental and narrow in scope — see
[Experimental features](../experimental.md#keypoint-suggestion).

<!-- SCREENSHOT: side-by-side panes with a few numbered correspondences placed. -->
