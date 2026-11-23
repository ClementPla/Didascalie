# Example: DNA fibers with DNAi

This page connects [DNAi](https://github.com/ClementPla/DNAi), a deep-learning
tool for DNA fiber analysis, to Didascalie through a
[Python function](python-functions.md). DNAi segments the fibers of the open
frame, its result arrives as masks on the **CldU** and **IdU** labels, and you
correct those masks with the usual tools.

<video src="../../assets/screenshots/dnai_integration.webm" poster="../../assets/screenshots/dnai_integration_poster.jpg"
       autoplay loop muted playsinline controls preload="metadata" style="width: 100%"
       aria-label="A two-channel CZI image of DNA fibers is adjusted in the Channels panel, sent to DNAi from the Python functions panel, and the detected fibers come back as masks that are then corrected with the eraser."></video>

In the video, the notebook on the left serves two DNAi models, and Didascalie on
the right has a two-channel CZI image open (AF488 in green, AF594 in red):

1. the channels are adjusted in the **Channels** panel;
2. **DNAi - ensemble** is run from the **Python functions** panel, and the
   notebook prints the progress of the segmentation;
3. the detected fibers come back as masks;
4. a wrong detection is removed with the eraser.

## What you need

- A project with two segmentation labels named **CldU** and **IdU**, the names
  the function returns.
- [pydidascalie](../python.md) with the server's packages, and DNAi, in the same
  Python environment:

```bash
pip install git+https://github.com/ClementPla/pydidascalie.git pyzmq msgpack
pip install git+https://github.com/ClementPla/DNAi.git
```

DNAi uses the GPU when PyTorch finds one; see its
[installation notes](https://github.com/ClementPla/DNAi#installation).

## The script

Run it as a script or in a notebook. The models are downloaded the first time
they are loaded.

```python
from didascalie.com import register_seg, serve
from dnafiber.data.preprocess import preprocess
from dnafiber.deployment import run_one_file
from dnafiber.model.utils import get_ensemble_models, get_error_detection_model

models = get_ensemble_models()
error_model = get_error_detection_model()  # optional: filters out false positives


@register_seg(name="DNAi")
def dnai(image):
    """Segment DNA fibers with DNAi."""
    h, w, _ = image.shape
    image = image[:, :, [1, 0, 2]]  # green channel first, then red
    image = preprocess(image)
    fibers = run_one_file(image, models, error_detection_model=error_model).valid_copy()
    labelmap = fibers.get_labelmap(h, w, 3)  # each fiber drawn 3 px wide
    return {"CldU": labelmap == 1, "IdU": labelmap == 2}


serve()
```

- `image` is the frame as the editor shows it (see below), an H × W × 3 RGB
  array.
- `preprocess` prepares it the way DNAi was trained. It assumes 0.13 µm per
  pixel; pass `pixel_size=` if your images differ.
- `valid_copy()` keeps the fibers DNAi could classify.
- `get_labelmap` draws each fiber segment with its analog: 1 for CldU, 2 for
  IdU. The dictionary sends each one to its label.

To compare models, register several functions in the same script, one per
model, as in the video: each gets its own row in the panel.

## What DNAi receives

The function gets the frame **as the Channels panel renders it**: each channel
windowed and drawn in its colour. Two things follow:

- **The colours decide the channel order.** The line
  `image[:, :, [1, 0, 2]]` puts the green channel first, so with AF488 in
  green and AF594 in red, as in the video, DNAi sees AF488 as its first analog.
  Change the colours in the panel, or this line, to match your staining.
- **The window decides the contrast.** A channel whose window is too wide
  reaches DNAi faint. **Auto** on each channel is a good start.

The **Image adjustments** (brightness, contrast, curve) are not sent unless you
turn on **Use image adjustments** at the top of the **Python functions** panel.

## Correcting the result

The run is a single undo step: ++ctrl+z++ removes it entirely.

- **A false detection:** the eraser with **Connected regions** removes every
  fiber its stroke touches, as in the video.
- **A missed or broken fiber:** draw it with the pen on **CldU** or **IdU**.
- **The wrong analog:** erase the segment and redraw it on the other label.

When a frame is right, mark it **reviewed**:
[model training](assistance.md) uses only reviewed frames, and
[exports](import-export.md) can be limited to them.

## Credits

DNAi is developed by Clément Playout and colleagues. If you use it, please cite:

> Playout C, Mehrjoo Y, Duval R, Boucher MC, Costantino S, Wurtele H. DNAi: an
> open-source AI tool for unbiased DNA fiber analysis. *Nucleic Acids Research*.
> 2026;54(7):gkag335. [doi:10.1093/nar/gkag335](https://doi.org/10.1093/nar/gkag335)
