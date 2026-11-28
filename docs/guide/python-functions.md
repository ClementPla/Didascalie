# Your own Python functions

Didascalie calls functions you write in Python, running in your own environment
— no ONNX export. The application and the Python process talk over a local
ZeroMQ socket. A function can:

- **segment** the frame open in the editor, or its whole sequence;
- **propose keypoint pairs** in the [registration](registration.md) view;
- take **arguments** you set in the editor — number fields, switches,
  drop-downs — sent with every run (see [Arguments](#arguments)).

!!! note "Experimental"
    This is recent and lightly tested. It does not depend on the
    [Experimental features](../experimental.md) switch.

<!-- SCREENSHOT: editor with the Python functions panel listing two frame functions and one sequence function. -->

## Quick start

Install [pydidascalie](../python.md) with the two packages the server needs:

```bash
pip install git+https://github.com/ClementPla/pydidascalie.git pyzmq msgpack
```

Register a function and serve it:

```python
from didascalie.com import register_seg, serve

@register_seg
def bright_regions(image):
    """Marks the bright pixels."""
    return image.mean(axis=2) > 200      # H × W mask, drawn on the active label

serve()
```

Run the script, then open a project in the editor. A **Python functions** panel
appears in the right column with a row for `bright_regions`. Click the button on
that row to run it on the open frame.

## A complete example

Two pretrained fundus models: one segments lesions, the other the optic disc and
the macula. In the video, `fundus_odmac_toolkit` is run on the open frame and
fills the **OD** and **Macula** labels.

<video src="../../assets/screenshots/python_functions.webm" poster="../../assets/screenshots/python_functions_poster.jpg"
       autoplay loop muted playsinline controls preload="metadata" style="width: 100%"
       aria-label="The Python functions panel in the editor: a registered function is run on a fundus image and draws the optic disc and the macula."></video>

For a microscopy example, where a two-channel image goes to DNAi and the
detected DNA fibers come back to be corrected, see
[Example: DNA fibers with DNAi](dnai.md).

The code is also available as a notebook:
[`examples/registering_python_functions.ipynb`](https://github.com/ClementPla/Didascalie/blob/release/examples/registering_python_functions.ipynb).

```python
import cv2
import numpy as np
from didascalie.com import register_seg, serve
from fundus_lesions_toolkit.constants import LESIONS
from fundus_lesions_toolkit.models import segment
from fundus_odmac_toolkit.models.segmentation import segment as segment_odmac


@register_seg("fundus_lesions_toolkit")
def lesion_segment(image):
    h, w, c = image.shape
    image = cv2.resize(image, (1024, 1024), interpolation=cv2.INTER_AREA)
    # One map per class; the first is the background.
    segmentation = (
        segment(image, autofit_resolution=False, reverse_autofit=False)[1:]
        .cpu()
        .numpy()
    )
    # Back to the frame's resolution.
    segmentations = [
        cv2.resize(
            segmentation[i].astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST
        )
        for i in range(len(segmentation))
    ]
    return {lesion: mask for lesion, mask in zip(LESIONS[1:], segmentations)}


@register_seg("fundus_odmac_toolkit")
def odmac_segment(image):
    h, w, c = image.shape
    image = cv2.resize(image, (512, 512), interpolation=cv2.INTER_AREA)
    segmentation = (
        segment_odmac(image, autofit_resolution=False, reverse_autofit=False)
        .cpu()
        .argmax(0)
        .numpy()
    )

    # Back to the frame's resolution.
    segmentation = cv2.resize(
        segmentation.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST
    )

    return {"OD": segmentation == 1, "Macula": segmentation == 2}


serve()
```

- Each `@register_seg` adds a row to the panel, under the name given, or the
  function's own name.
- Dictionary keys are label names of the project: here those in `LESIONS`, and
  `OD` and `Macula`. Keys that match no label are ignored. Labels not returned
  are left as they are.
- Masks must have the frame's size. Both models predict at a fixed resolution,
  so each function resizes the frame going in and the result coming out, with
  nearest-neighbour interpolation for the masks.

## Segmentation functions

### Parameters

The first parameter is the frame, an H × W × 3 `uint8` RGB array. The others are
optional and only sent when the function names them:

| Parameter | Value |
| --- | --- |
| `masks` | What is currently drawn: `{label name: H × W uint8}` |
| `labels` | The project's label names, in the order of the labels panel |
| `active_label` | Name of the label selected in the editor, or `None` |
| `frame_index` | Index of the frame in its sequence |
| `frame_name` | File path of the frame within the project. For a frame without one, the name of its sequence |

```python
@register_seg
def refine(image, masks, active_label):
    prompt = masks[active_label]
    return sam(image, prompt)
```

Any other parameter needs a default value, or must be declared as an
[argument](#arguments).

### Arguments

Values the user sets in the editor are declared in the decorator, each under the
name of the function parameter that receives it:

```python
from didascalie.com import Boolean, Enum, Float, Int, register_seg

@register_seg(
    "vessels",
    threshold=Float(0.5, min=0, max=1, step=0.05, label="Threshold"),
    min_size=Int(20, min=0, label="Smallest region", hint="In pixels"),
    clean=Boolean(True, label="Remove specks"),
    model=Enum(["fast", "accurate"], default="accurate"),
)
def vessels(image, threshold, min_size, clean, model):
    ...
```

| Type | Editor control | Options |
| --- | --- | --- |
| `Int(default)` | Number field, whole numbers | `min`, `max`, `step` |
| `Float(default)` | Number field | `min`, `max`, `step` |
| `Boolean(default=False)` | Switch | |
| `Enum(choices, default=first)` | Drop-down list | |

All four also take:

- `label`, the name shown in the editor. By default, the parameter's name.
- `hint`, the help line under the control. By default, numbers show their type
  and range.

Number fields are checked before a run: an empty, non-whole or out-of-range
value disables the run button and says why under the field.

The values are kept for the session, so they survive the script being
restarted. `@register_sequence_seg` takes arguments the same way;
`@register_kpts` does not.

### Return value

| Return value | Effect |
| --- | --- |
| `{label name: H × W mask}` | Replaces those labels. The others are untouched. |
| C × H × W array, one mask per label, in the order of the labels panel | Replaces every label. |
| H × W array | Added to the active label, keeping what is there. |
| `None` | Nothing. |
| `Result(masks, message="...")` | Any of the above, and a message shown when the run ends. |

Masks are NumPy arrays or torch tensors, of type:

- **boolean**;
- **float**, thresholded at 0.5;
- **integer**. On an instance label the values are instance ids, from 1 to 255.
  On a semantic label any non-zero value counts as drawn.

On an instance label, a boolean or float mask added to the active label takes
the instance selected in the editor.

A function that exports something rather than drawing can report it:

```python
from didascalie.com import Result, register_seg

@register_seg
def export(image, masks, frame_name):
    path = save_measurements(masks, frame_name)
    return Result(message=f"Saved to {path}")
```

### Whole sequences

`@register_sequence_seg` has the same contract with a leading frame axis, for
trackers and video or 3D models.

| | `register_seg` | `register_sequence_seg` |
| --- | --- | --- |
| First parameter | H × W × 3 | T × H × W × 3 |
| `masks` | `{label: H × W}` | `{label: T × H × W}` |
| `frame_index` | Index in the sequence | Position of the open frame among the frames received |
| `frame_name` | Name of the frame | Name of the open frame |
| Returns | `{label: H × W}`, C × H × W or H × W | `{label: T × H × W}`, T × C × H × W or T × H × W |

```python
from didascalie.com import register_sequence_seg

@register_sequence_seg
def track(frames, masks, frame_index):
    return {"cell": tracker(frames, masks["cell"][frame_index])}
```

If the frames differ in size, the function receives a list of arrays and returns
its masks the same way.

## In the editor

The **Python functions** panel lists each function with the first line of its
docstring.

- **This frame** lists the `@register_seg` functions. A run is a single undo
  step.
- **Whole sequence** lists the `@register_sequence_seg` functions, on sequences
  of more than one frame. You choose the whole sequence or the frames from the
  current one onward, and set the function's arguments. The masks are written
  straight to the project, like [propagating labels](annotating.md); ++ctrl+z++
  reverts the whole run while the sequence stays open.

The arguments of a frame function appear under its row, and the sliders button
folds them away. Those of a sequence function are in its run dialog, which also
shows the progress of the run.

**Use image adjustments**, at the top of the panel, applies to every function
and is off by default. On, functions receive frames with the
[image adjustments](annotating.md) applied, as shown in the editor. It needs
**Apply image adjustments** (++q++) on as well. On a sequence, the same
adjustments apply to every frame. The stored image is never modified.

### Full resolution

**Full resolution**, also at the top of the panel, is on by default. A
microscopy frame imported at a lower resolution level (see
[Microscopy files](projects.md#microscopy-files)) is then read again from its
file and sent at full size, up to about a billion pixels; past that, at the
finest level within it. The masks the function reads are scaled up to that
size, and the masks it returns must have it: they are scaled down to the size
the project holds, by nearest pixel, before being applied.

This needs the original file, where the project recorded it, and
didascalie-bioformats. Without either, the frame is sent at the size the
project holds and a warning says why. Off, every frame is sent as the editor
shows it.

A frame function has 5 minutes to answer, a sequence function an hour.

## Keypoint functions

```python
from didascalie.com import register_kpts

@register_kpts("my_matcher")
def my_matcher(reference, moving, existing):
    # reference, moving: H × W × 3 uint8 RGB arrays
    # existing: pairs already placed, [((rx, ry), (mx, my)), ...]
    pairs = ...
    return pairs  # same format, in pixel coordinates
```

1. Open the registration view and pick the reference and moving frames.
2. Click **Find keypoints with user function** in the sidebar.
3. Pick a function in the list and click the button again.

A call times out after 30 seconds. `register_kpts` was formerly `register`,
which still works.

<!-- SCREENSHOT: registration sidebar connected to Python, with the list of registered functions. -->

## The server

```python
serve(port=5556, host="tcp://*")
```

`serve` blocks. Register every function before calling it.

The application looks at `127.0.0.1:5556`; the panel's header shows the endpoint
it is using. To change it, click the connection
button (:material-link-variant:) at the right of the top toolbar and set the host
and port under **Python functions server**. The registration sidebar has the same
setting under **Change port**.

<!-- SCREENSHOT: the Connections popover, connected to a server. -->

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| The panel does not appear | The script is not running, serves no segmentation function, or the host and port under **Python functions server** do not match. |
| A run button stays disabled | An argument is empty, not a whole number, or outside its range; the reason is under the field. |
| No **Whole sequence** group | The open sequence has a single frame. |
| "Nothing applied" | The function returned no mask, or only keys that are not label names. |
| A shape error | A mask is not the size of the frame it was given (with **Full resolution**, the file's size, not the editor's). |
| "Not at full resolution" | The original microscopy file or didascalie-bioformats was not found, or the full size is too large to send. The frame went at the size the project holds. |
| "Got N masks for M labels" | A C × H × W result needs one mask per project label. Return a dictionary to fill only some. |
| The function raises | The traceback is printed by the script. The application shows its last line. |
| "Python did not answer in time" | The function exceeded its time limit, or the script stopped. |
