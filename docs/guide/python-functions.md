# Your own Python functions

Didascalie can call functions you write in Python:

- a **segmentation** function runs on the frame open in the editor, or on its
  whole sequence;
- a **keypoint** function proposes correspondences in the
  [registration](registration.md) view.

The model runs in your own Python environment, with no ONNX export. The
application and the Python process talk over a local ZeroMQ socket.

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
the macula.

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
    # One map per class; the first is the background.
    segmentation = segment(image)[1:].cpu().numpy()
    # Back to the frame's resolution.
    segmentations = [
        cv2.resize(segmentation[i].astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
        for i in range(len(segmentation))
    ]
    return {lesion: mask for lesion, mask in zip(LESIONS[1:], segmentations)}


@register_seg("fundus_odmac_toolkit")
def odmac_segment(image):
    segmentation = segment_odmac(image)
    return {"OD": segmentation[1], "Macula": segmentation[2]}


serve()
```

- Each `@register_seg` adds a row to the panel, under the name given, or the
  function's own name.
- Dictionary keys are label names of the project: here those in `LESIONS`, and
  `OD` and `Macula`. Keys that match no label are ignored. Labels not returned
  are left as they are.
- Masks must have the frame's size. A model that predicts at another resolution
  has to resize its output, with nearest-neighbour interpolation.

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

```python
@register_seg
def refine(image, masks, active_label):
    prompt = masks[active_label]
    return sam(image, prompt)
```

Any other parameter needs a default value.

### Return value

| Return value | Effect |
| --- | --- |
| `{label name: H × W mask}` | Replaces those labels. The others are untouched. |
| C × H × W array, one mask per label, in the order of the labels panel | Replaces every label. |
| H × W array | Added to the active label, keeping what is there. |
| `None` | Nothing. |

Masks are NumPy arrays or torch tensors, of type:

- **boolean**;
- **float**, thresholded at 0.5;
- **integer**. On an instance label the values are instance ids, from 1 to 255.
  On a semantic label any non-zero value counts as drawn.

On an instance label, a boolean or float mask added to the active label takes
the instance selected in the editor.

### Whole sequences

`@register_sequence_seg` has the same contract with a leading frame axis, for
trackers and video or 3D models.

| | `register_seg` | `register_sequence_seg` |
| --- | --- | --- |
| First parameter | H × W × 3 | T × H × W × 3 |
| `masks` | `{label: H × W}` | `{label: T × H × W}` |
| `frame_index` | Index in the sequence | Position of the open frame among the frames received |
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
  current one onward. The masks are written straight to the project, like
  [propagating labels](annotating.md), and this cannot be undone.

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

The application looks at `127.0.0.1:5556`. To change it, click **Connections**
(:material-link-variant:) at the right of the top toolbar and set the host and
port under **Python functions server**.

The same popover sets the **Remote-control port**, the one Didascalie itself
listens on (5555 by default). It applies after a restart, and must differ from
the server's port when both run on the same machine.

<!-- SCREENSHOT: the Connections popover, connected to a server. -->

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| The panel does not appear | The script is not running, serves no segmentation function, or the host and port in **Connections** do not match. |
| No **Whole sequence** group | The open sequence has a single frame. |
| "Nothing applied" | The function returned no mask, or only keys that are not label names. |
| A shape error | A mask is not the size of the frame. |
| "Got N masks for M labels" | A C × H × W result needs one mask per project label. Return a dictionary to fill only some. |
| The function raises | The traceback is printed by the script. The application shows its last line. |
| "Python did not answer in time" | The function exceeded its time limit, or the script stopped. |
