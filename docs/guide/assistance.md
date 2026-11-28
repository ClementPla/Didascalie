# Assisted labelling

## Operators bounded by your stroke

These need nothing installed and run instantly. Switch on **Auto-segment** (++d++)
and pick the operator under **Post-processing mode** in the settings panel. Then
paint roughly over a region: when you release the stroke, the operator refines it,
changing only pixels inside the area your stroke covered.

| Operator | What it does |
| --- | --- |
| Otsu | Thresholds within the stroke, choosing the split automatically |
| Flood Fill | Grows from the pixel you clicked while colours stay within **Tolerance** |
| Superpixel | Snaps the mask to superpixel boundaries ([experimental](../experimental.md#superpixel-selection)) |

Otsu and flood fill share four options:

- **Use inverse image** takes the other side: the darker structure for Otsu,
  everything but the filled region for flood fill.
- **Smooth** rounds the outline. Its strength is relative to the brush size:
  at 100 %, what is narrower than about half the brush is rounded off.
- **Fill holes** fills the holes enclosed in the selection.
- **Force connectivity** keeps only the largest region.

Otsu also has **Denoise**, which blurs the image before thresholding it, so
that pixel noise does not end up in the outline.

To remove a whole region at once, use the eraser with **Connected regions** on;
see [Painting masks](annotating.md#painting-masks).

<video src="../../assets/screenshots/assisted_labelling.webm" poster="../../assets/screenshots/assisted_labelling_poster.jpg"
       autoplay loop muted playsinline controls preload="metadata" style="width: 100%"
       aria-label="A rough stroke refined with Otsu, traced into a shape, adjusted point by point, then painted back into the mask."></video>

### Correcting the result by hand

When the operator gets the outline almost right, fix it as a shape instead of
repainting it. This is the second half of the video above:

1. **Trace outline** (++v++): click the mask to get its border as a shape.
2. **Edit points**: drag the points that are off.
3. **Rasterize**: paint the corrected shape back into the mask.

See [Converting between masks and shapes](annotating.md#converting-between-masks-and-shapes).

### Adjustments feed the operators

With **Apply image adjustments** on (++q++), the operators read the adjusted image:
brightness, contrast, gamma and tone curves change what Otsu and flood fill see,
not only what you see. On a low-contrast image, raise the contrast until the
structure stands out, then paint. The stored image is never modified.

## Training a model on your own data

!!! warning "Very experimental"
    Lightly tested, and likely to change.

Scribble on a few frames, train, and apply the result to the rest of the project.

Each image is turned into dense features, and a small convolutional head is
trained on top of them, which takes seconds to minutes, even on a CPU. The
features come either from the **built-in features** (fast, offline, nothing to
set up) or from a pretrained self-supervised encoder such as DINO, downloaded
once from the same page. The encoder itself is not trained, so its features can
be saved to disk and reused.

In practice:

- **It fits your project**, not a general-purpose model: the head learns the
  structures and the modality of your images.
- **The model is saved in the project.** Reopening the `.dida` file restores the
  trained head, so predictions travel with the data.
- **Only reviewed frames are used for training**, and at least two are needed so
  that one can be held out to measure accuracy. Annotated frames that are not
  marked reviewed are ignored; the page says how many.

### Training

Open **Segmentation head lab** (:material-chart-line: in the top bar). Choose the
features, the **Labels to predict**, and if needed the **Image size**,
**Samples per image** and **Training passes**, then click **Train model**. The
page reports the accuracy on the held-out frames. **Delete model** removes the
trained head from the project; **Clear saved features** frees the disk space
the features take.

### Predicting

In the editor, the **Model** group of the toolbar runs the trained head on the
open frame. Its arrow chooses what you get back:

- **Painted pixels**: the predicted masks replace the labels' masks;
- **Editable paths**: each predicted region traced as a closed shape;
- **Centerlines**: each region thinned to open lines.

With the pencil toggle next to it on, what you have already drawn on the frame is
used as hints. A prediction is one undo step: correct it by hand, mark the frame
reviewed, and retrain.

No data is sent anywhere: an encoder is only downloaded, once.

!!! tip "If training is slow"
    Check the device reported on the **Segmentation head lab** page. See
    [Troubleshooting](../troubleshooting.md#gpu-training-falls-back-to-the-cpu).
