# Experimental features

These features work but are unfinished. They are lightly tested, they will
probably change, and some may be removed. Back up your project before using them
on real data.

## Turning them on

Click the wrench button at the right of the top toolbar and switch on
**Experimental features**. The setting is remembered between sessions.

The switch controls [3D volume mode](#3d-volume-mode),
[superpixel selection](#superpixel-selection) and
[MedSAM refinement](#medsam-mask-refinement). Switching it off leaves 3D mode
and resets the post-processing mode if one of the experimental ones was
selected. The [Python bridge](#python-bridge) does not depend on the switch.
It is listed here because it is equally unfinished.

<!-- SCREENSHOT: top toolbar with the wrench popover open and the switch on. -->

## 3D volume mode

3D mode opens a sequence as a single volume, with the frame index as the depth
axis. You still annotate slice by slice, and two more views appear beside the
canvas: a 3D view of the labels, and a curved projection you can paint on. Use it
when a structure runs through many slices and is hard to follow one frame at a
time.

### Requirements

The toggle (cube icon, **View** group of the editor menu) only appears on
sequences. Its tooltip says why when the mode is unavailable:

- at least two frames, all the same size;
- at least one segmentation label;
- no frame side above 4096 px;
- the volume must fit in 1.5 GB. It takes
  `width × height × frames × (labels + 2)` bytes, so 200 frames of 512 × 512
  with 3 labels need about 260 MB.

In 3D mode, ++shift++ + wheel scrolls through slices.

<!-- SCREENSHOT: editor in 3D mode: slice canvas on the left, 3D view and projection panel on the right. -->

### 3D view

Shows the labels in space and updates as you paint. The header buttons toggle
four layers, which can be combined:

| Layer | Shows |
| --- | --- |
| Label surfaces | A smoothed mesh of each label |
| Label voxels | The exact voxels, as blocks |
| Image planes | The current slice plus sagittal and coronal cuts through the image |
| Volume rendering | The image itself, as maximum intensity or composite |

Drag to orbit, right-drag to pan, scroll to zoom. Clicking a surface or a plane
jumps to that slice.

The gear menu contains opacities, plane positions, the intensity window, and two
settings that affect the result more than the others:

- **Slice spacing** is the distance between slices, in pixels. Set it to match
  your acquisition, otherwise the volume looks squashed or stretched.
- **Mesh detail** (auto, full, half, quarter). Lower it if meshing lags on a
  large volume.

<!-- SCREENSHOT: 3D view with label surfaces and image planes on, a vessel-like structure visible. -->
<!-- SCREENSHOT: same volume with "Label voxels" vs "Label surfaces", side by side. -->
<!-- SCREENSHOT: 3D view settings popover (gear menu). -->

### Projection view

Unrolls the volume along a surface you define with two curves, **A** and **B**,
drawn on the slice. Each pixel of the projection summarises the image along the
segment joining matching points of A and B. The horizontal axis is the position
along the curves; the vertical axis is the slice index.

To set a curve, open the **A** or **B** menu and either:

- **Draw on the slice**: click to add points, double-click or ++enter++ to
  finish;
- **From a label or path**: click an existing mask or vector path to reuse its
  shape.

Curves stay editable on the slice: drag a point to move it, double-click the
curve to add one, right-click a point (or select it and press ++delete++) to
remove it. If the projection looks twisted, the two curves run in opposite
directions: use **Reverse** in one of the menus.

The gear menu selects how the image is reduced along each segment: maximum,
mean, minimum, or the value at a single depth.

The horizontal line across the projection marks the current slice. Drag it to
change slice. Wheel zooms; drag pans (middle-drag while painting).

<!-- SCREENSHOT: slice canvas with curves A and B drawn and the dashed rulings between them. -->
<!-- SCREENSHOT: the resulting projection view, with the current-slice line visible. -->

### Painting on the projection

The pencil button turns the projection into a canvas for the editor's raster
tools: pen, line, lasso and the erasers, with the active label and brush size.
Refining a stroke with Otsu or flood fill, erasing whole components and the
[touch and pen options](android.md#tablet-controls) work as on the slice, and
the image adjustments apply to the projection too. Right-click, or a long
press, opens the label picker.

Vector tools and the model-based refinements (MedSAM, superpixels) need a
frame, so they do nothing here; with one of those refinements selected, a
stroke is kept as drawn.

A projection pixel stands for a whole segment between A and B, so you choose
where along it the paint lands: the **depth** slider goes from A (0) to B (1).
++shift++ + wheel moves it, ++ctrl++ + wheel changes the brush size. The
"at depth" projection mode shows exactly the surface you are painting on.

What you draw is written half the brush size on each side of that surface,
along the segment: a wide brush makes a thick sheet, and a lasso is as thick
as the current brush.

One stroke can touch many slices. They are all saved with the frame, and the
stroke is a single step in the editor's undo history.

<!-- SCREENSHOT: painting on the projection: brush cursor, depth slider and the "Painting <label> at depth…" hint. -->

### Detaching the views

Each view can fill the editor area (++esc++ to go back) or open in its own
window, for a second monitor. A detached view stays live: it follows edits and
slice changes like the docked one. There is no separate window on a tablet.

<!-- SCREENSHOT: 3D view detached into its own window next to the main window. -->

## Superpixel selection

A post-processing mode that snaps a brush stroke to superpixel boundaries. With
the switch on, **Superpixel** is added to the mode list in the
**Post-processing** section of the tool settings.

Paint roughly over a region. The stroke is replaced by the superpixels it
touches whose colour matches the dominant colour under the stroke.

| Setting | Effect |
| --- | --- |
| Show superpixels | Draws the boundaries over the image. Turn it on first to judge the count |
| Superpixel count | 500 to 8000. More means smaller cells and finer edges |
| Color tolerance | How far a cell's colour may be from the stroke's. Raise it if cells are missed |
| Min. overlap | Fraction of a cell the stroke must cover to count. Raise it if the mask spills over |

The result depends heavily on the count, which is why it is less predictable
than Otsu or flood fill, described in
[Assisted labelling](guide/assistance.md#operators-bounded-by-your-stroke).

<!-- SCREENSHOT: image with "Show superpixels" on, plus the superpixel settings panel. -->
<!-- SCREENSHOT: before/after: a rough stroke, then the mask snapped to superpixels. -->

## MedSAM mask refinement

A post-processing mode that turns a rough stroke into a cleaner mask with a
SAM-style model, downloaded on first use. With the switch on, **MedSAM** is
added to the mode list in the **Post-processing** section of the tool settings.

Its only setting is **Threshold**, the confidence a pixel needs to be kept.

It has not been benchmarked and the results vary a lot between modalities. It
does nothing on [very large images](guide/large-images.md). For model
assistance, prefer
[training on your own data](guide/assistance.md#training-a-model-on-your-own-data).

<!-- SCREENSHOT: before/after: a rough stroke and the mask MedSAM returns (optional). -->

## Python bridge

Functions you write in Python can be called from the application: to segment
the frame or the sequence open in the editor, or to propose keypoint pairs for
registration. It has its own page:
[Your own Python functions](guide/python-functions.md).
