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
change slice. Wheel zooms; right- or middle-drag pans.

<!-- SCREENSHOT: slice canvas with curves A and B drawn and the dashed rulings between them. -->
<!-- SCREENSHOT: the resulting projection view, with the current-slice line visible. -->

### Painting on the projection

The pencil button turns the projection into a canvas. It uses the editor's
active label, brush size and eraser.

A projection pixel stands for a whole segment between A and B, so you choose
where along it the paint lands: the **depth** slider goes from A (0) to B (1).
++shift++ + wheel moves it, ++ctrl++ + wheel changes the brush size. The
"at depth" projection mode shows exactly the surface you are painting on.

One stroke can touch many slices. They are all saved with the frame, and the
stroke is a single step in the editor's undo history.

<!-- SCREENSHOT: painting on the projection: brush cursor, depth slider and the "Painting <label> at depth…" hint. -->

### Detaching the views

Each view can fill the editor area (++esc++ to go back) or open in its own
window, for a second monitor. A detached view stays live: it follows edits and
slice changes like the docked one.

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

Functions you write in Python can be called from the application: one kind
proposes keypoint pairs for [registration](guide/registration.md), another
segments the frame or the sequence open in the editor. The application sends the
images to a Python process over ZeroMQ and gets the result back.

Your model runs in the environment it was trained in. You do not have to export
it to ONNX, which often fails on research architectures.

### Python side

Needs [pydidascalie](python.md) with `pyzmq` and `msgpack`. Decorate the
functions, then serve them:

```python
from didascalie.com import register_kpts, register_seg, register_sequence_seg, serve

@register_seg
def vessels(image):
    """Segments the vessels."""          # first docstring line shows in the editor
    return {"vessel": model(image) > 0.5}

serve()  # 127.0.0.1:5556, where the application looks by default
```

`serve` blocks. Any number of functions can be registered; each takes its own
name, or the one you pass (`@register_seg("my name")`). If a function raises,
the traceback is printed in the Python process and the application shows the
last line.

### Keypoint suggestion

```python
@register_kpts("my_matcher")
def my_matcher(reference, moving, existing):
    # reference, moving: H × W × 3 uint8 RGB arrays
    # existing: pairs already placed, [((rx, ry), (mx, my)), ...]
    pairs = ...
    return pairs  # same format, in pixel coordinates
```

`register_kpts` was called `register` before; the old name still works and
warns.

1. Open the registration view and pick the reference and moving frames.
2. Click **Find keypoints with user function** in the sidebar. The first time,
   it asks for a host and port (default `127.0.0.1:5556`, which must match
   `serve`).
3. Once connected, the sidebar lists the registered functions. Pick one and
   click the button again.

A call times out after 30 seconds.

<!-- SCREENSHOT: registration sidebar connected to Python, with the list of registered functions. -->

### Segmentation

A `@register_seg` function receives the open frame as an H × W × 3 uint8 RGB
array. It can ask for more by naming extra parameters; only what is named is
sent:

| Parameter | Value |
| --- | --- |
| `masks` | What is currently drawn: `{label name: H × W uint8}` |
| `labels` | The project's label names, in the order of the labels panel |
| `active_label` | Name of the label selected in the editor, or `None` |
| `frame_index` | Index of the frame in its sequence |

```python
@register_seg
def refine(image, masks, active_label):
    prompt = masks[active_label]
    return sam(image, prompt)
```

What it returns decides where the masks go:

| Return value | Effect |
| --- | --- |
| `{label name: H × W mask}` | Replaces those labels. The others are untouched. |
| C × H × W array, one mask per label in order | Replaces every label. |
| H × W array | Added to the active label, keeping what is there. |

A mask can be boolean, float (thresholded at 0.5) or integer. On an
instance label, integer values are kept as instance ids; a boolean or float mask
added to the active label takes the instance selected in the editor. Torch
tensors are accepted.

`@register_sequence_seg` is the same with a leading frame axis: the function
receives T × H × W × 3 (a list of arrays if the frames differ in size), `masks`
is `{label name: T × H × W}`, and it returns `{label name: T × H × W}`,
T × C × H × W, or T × H × W. `frame_index` is the position of the open frame
within the frames received.

```python
@register_sequence_seg
def track(frames, masks, frame_index):
    return {"cell": tracker(frames, masks["cell"][frame_index])}
```

#### In the editor

There is nothing to connect. While the editor is open it looks for the server
every few seconds, and when it finds one serving segmentation functions a
**Python functions** panel appears in the right column. It disappears when the
server stops.

- **This frame** lists the `@register_seg` functions. The button next to one
  runs it on the open frame. The result is a single undo step.
- **Whole sequence** lists the `@register_sequence_seg` functions, on sequences
  of more than one frame. The button opens a dialog where you choose the whole
  sequence or the frames from the current one onward. The masks are written
  straight to the project, like [propagating labels](guide/annotating.md), and this
  cannot be undone.

The editor looks at the host and port last used in the registration view's
connection dialog, `127.0.0.1:5556` by default.

A frame function has 5 minutes to answer, a sequence function an hour.

<!-- SCREENSHOT: editor with the Python functions panel listing two frame functions and one sequence function. -->
