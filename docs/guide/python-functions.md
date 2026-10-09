# Your own Python functions

Didascalie can call functions you write in Python. You decorate a function,
start a small server, and the function shows up in the application:

- a **segmentation** function runs on the frame open in the editor, or on its
  whole sequence, and its masks land on your labels;
- a **keypoint** function proposes correspondences in the
  [registration](registration.md) view.

Your model runs in the environment it was trained in, on your machine. There is
nothing to export to ONNX, and the images never leave the computer: the
application and the Python process talk over a local ZeroMQ socket.

!!! note "Experimental"
    This works, but it is recent and lightly tested. It does not depend on the
    [Experimental features](../experimental.md) switch.

<!-- SCREENSHOT: editor with the Python functions panel listing two frame functions and one sequence function. -->

## Quick start

Install [pydidascalie](../python.md) with the two packages the server needs:

```bash
pip install git+https://github.com/ClementPla/pydidascalie.git pyzmq msgpack
```

Write a script that registers a function and serves it:

```python
from didascalie.com import register_seg, serve

@register_seg
def bright_regions(image):
    """Marks the bright pixels."""
    return image.mean(axis=2) > 200      # H × W mask, drawn on the active label

serve()
```

Run it, then open a project in the editor. Within a few seconds a **Python
functions** panel appears in the right column with a row for `bright_regions`.
Click the button on that row to run it on the open frame. ++ctrl+z++ reverts it.

There is no connect step. Stop the script and the panel goes away.

## A complete example

This script serves two pretrained fundus models. One segments lesions, the other
the optic disc and the macula.

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
    # The model works at its own resolution: bring each map back to the frame's.
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

What to take from it:

- **Several functions, one server.** Each `@register_seg` adds a row to the
  panel. The string is the name shown there; without it the function's own name
  is used.
- **A dictionary targets labels by name.** The keys must be the names of labels
  in the project: here the lesion names in `LESIONS`, and `OD` and `Macula`. A
  key that matches no label is ignored, and the application tells you which.
  Labels you do not return are left as they are.
- **Masks must have the frame's size.** `image` is the frame at full
  resolution, so a model that predicts at another size has to resize its output
  back, as the first function does. Use nearest-neighbour interpolation so
  class values are not blended.
- **Tensors are fine.** The second function returns slices of a torch tensor
  directly.

## Segmentation functions

### What the function receives

The first parameter is the frame: an H × W × 3 `uint8` RGB array.

A function can ask for more by naming extra parameters. Only what is named is
sent, so a function that does not ask for the masks does not pay for their
transfer.

| Parameter | Value |
| --- | --- |
| `masks` | What is currently drawn: `{label name: H × W uint8}` |
| `labels` | The project's label names, in the order of the labels panel |
| `active_label` | Name of the label selected in the editor, or `None` |
| `frame_index` | Index of the frame in its sequence |

This is how you use what is already drawn as a prompt:

```python
@register_seg
def refine(image, masks, active_label):
    prompt = masks[active_label]
    return sam(image, prompt)
```

A parameter with any other name must have a default value. Otherwise the
decorator raises, since the application would have nothing to pass for it.

### What it returns

The shape of the result decides where the masks go.

| Return value | Effect |
| --- | --- |
| `{label name: H × W mask}` | Replaces those labels. The others are untouched. |
| C × H × W array, one mask per label, in the order of the labels panel | Replaces every label. |
| H × W array | Added to the active label, keeping what is there. |
| `None` | Nothing. |

A mask can be:

- **boolean**;
- **float**, thresholded at 0.5;
- **integer**. On an instance label the values are kept as instance ids, from 1
  to 255. On a semantic label any non-zero value counts as drawn.

A boolean or float mask added to the active label of an instance project takes
the instance currently selected in the editor, as a brush stroke would.

NumPy arrays and torch tensors are both accepted.

### Whole sequences

`@register_sequence_seg` is the same contract with a leading frame axis, for
models that need the whole sequence at once, such as trackers and video or 3D
models.

| | One frame | Whole sequence |
| --- | --- | --- |
| First parameter | H × W × 3 | T × H × W × 3 |
| `masks` | `{label: H × W}` | `{label: T × H × W}` |
| `frame_index` | Index in the sequence | Position of the open frame among the frames received |
| Returns | `{label: H × W}`, C × H × W or H × W | `{label: T × H × W}`, T × C × H × W or T × H × W |

```python
from didascalie.com import register_sequence_seg

@register_sequence_seg
def track(frames, masks, frame_index):
    # Follow through the sequence what is drawn on the open frame.
    return {"cell": tracker(frames, masks["cell"][frame_index])}
```

If the frames of the sequence differ in size, the function receives a list of
arrays instead of one stacked array, and returns its masks the same way.

## In the editor

While the editor is open it looks for the server every few seconds. When it
finds one that serves segmentation functions, the **Python functions** panel
appears at the top of the right column. Each function has a row with its name
and the first line of its docstring.

- **This frame** lists the `@register_seg` functions. The button runs the
  function on the open frame. The result is a single undo step, so you can run
  it, look, press ++ctrl+z++, change the Python and run it again.
- **Whole sequence** lists the `@register_sequence_seg` functions, on sequences
  of more than one frame. The button opens a dialog where you choose the whole
  sequence or the frames from the current one onward, and see how many frames
  that is. The masks are written straight to the project, like
  [propagating labels](annotating.md). This cannot be undone, and nothing is
  written unless every frame comes back valid.

A frame function has 5 minutes to answer and a sequence function an hour. The
first call is often the slow one, because that is when the model loads.

## Keypoint functions

A keypoint function proposes pairs of matching points for
[registration](registration.md).

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
2. Click **Find keypoints with user function** in the sidebar. The first time,
   it asks for a host and port.
3. Once connected, the sidebar lists the keypoint functions. Pick one and click
   the button again.

A call times out after 30 seconds.

`register_kpts` used to be called `register`. The old name still works and
prints a deprecation warning.

<!-- SCREENSHOT: registration sidebar connected to Python, with the list of registered functions. -->

## The server

```python
serve(port=5556, host="tcp://*")
```

`serve` blocks until you interrupt it with ++ctrl+c++. Register every function
before calling it.

The application looks at `127.0.0.1:5556`. Do not use port 5555: the application
listens on it itself. To use another port or another machine, set it in the
connection dialog of the registration view. The editor uses the address entered
there, and it is remembered between sessions.

## When something goes wrong

**The panel does not appear.** Check that the script is still running and
printed `listening on …`, that it registers at least one `@register_seg` or
`@register_sequence_seg` function (keypoint functions alone do not show the
panel), and that the port matches. The **Whole sequence** group only shows on
sequences of more than one frame.

**"Nothing applied".** The function returned no mask, or only labels the project
does not have. Dictionary keys must match the label names exactly.

**A shape error.** A mask is not the size of the frame. Resize the model's
output back to `image.shape[:2]`.

**"Got N masks for M labels".** A C × H × W result needs exactly one mask per
project label. Return a dictionary to fill only some of them.

**The function raises.** The full traceback is printed where the script runs.
The application shows its last line.

**"Python did not answer in time".** The function took longer than the limits
above, or the script stopped during the call.
