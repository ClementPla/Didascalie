# Assisted labelling

There are two kinds of help. The first needs no setup. The second needs a model
download and a few annotated frames.

## Operators bounded by your stroke

These need nothing installed and run instantly. They all work the same way: paint
roughly over a region with the brush, then apply an operator. The operator only
changes pixels inside the area your stroke covered.

| Operator | What it does |
| --- | --- |
| Dynamic Otsu | Thresholds within the stroke, choosing the split automatically |
| Flood fill | Grows from the stroke while pixels stay within a tolerance |
| Superpixel selection | Snaps the mask to superpixel boundaries ([experimental](../experimental.md#superpixel-selection)) |
| Connected-component erasure | Removes the connected region you click |

Two options apply to several of them:

- **Morphological opening** removes speckle left by a threshold.
- **Connectivity constraint** keeps only the component touching your stroke.

![Assisted labelling with Otsu thresholding](../assets/screenshots/assisted_labelling.gif)
### Adjustments can feed the operators

Brightness, contrast, gamma, tone curves and inversion normally change not only affect what you see, but the operators too.

Use this on low-contrast images. Otherwise you raise the contrast to see a faint
boundary, and the operator still works on the original, nearly flat pixels.

## Training a model on your own data

Scribble on a few frames, train, and apply the result to the rest of the project.

A frozen self-supervised encoder (DINOv3 by default) produces dense features for
each image. The encoder is not trained, so the features are computed once and
cached. This is the slow part. A small convolutional head is then trained on top
of the features, which takes seconds to minutes, even on a CPU.

In practice:

- **Scribbles are enough.** You do not need complete masks. A few strokes of
  foreground and background per frame are the intended input.
- **It adapts to your project.** The head learns the structures and the modality
  of your images. It is not a general-purpose object model.
- **The model is saved in the project.** Reopening the `.dida` file restores the
  trained head, so predictions are reproducible and travel with the data.
- **Only reviewed frames are used for training.** Partially annotated frames that
  are not marked reviewed are ignored.
- **With several accounts, it learns from yours.** Training uses the frames you
  annotated and reviewed. The trained model itself is shared: there is one per
  project, so training replaces it for every account. See
  [Several annotators](multi-user.md).

The encoder is downloaded once, the first time you use it. No data is sent
anywhere.

!!! tip "If training is slow"
    Check the device reported under the training panel. See
    [Troubleshooting](../troubleshooting.md#gpu-training-falls-back-to-the-cpu).
