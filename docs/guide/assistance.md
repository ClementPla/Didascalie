# Assisted labelling

There are two kinds of help, with very different setup costs.

## Operators bounded by your stroke

These need nothing installed and run instantly. The pattern is the same for all of
them: rough in a region with the brush, then apply an operator, which is confined to
the area your stroke covered. Nothing outside it is touched.

| Operator | What it does |
| --- | --- |
| Dynamic Otsu | Thresholds within the stroke, choosing the split automatically |
| Flood fill | Grows from the stroke while pixels stay within a tolerance |
| Superpixel selection | Snaps the mask to superpixel boundaries (experimental) |
| Connected-component erasure | Removes the connected region you click |

Two options apply to several of them:

- **Morphological opening** removes speckle left behind by a threshold.
- **Connectivity constraint** keeps only the component touching your stroke,
  discarding anything disconnected.

### Adjustments can feed the operators

Brightness, contrast, gamma, tone curves and inversion normally change only what
you see. They can also be routed into the operators, so a faint structure you had
to boost to see is the same structure the algorithm reads. Toggle this with ++q++.

This matters on low-contrast images: without it you raise contrast to find the
boundary and the operator still works on the original, near-flat pixels.

## Training a model on your own data

Scribble on a few frames, train, and apply the result to the rest of the project.

How it works: a frozen self-supervised encoder (DINOv3 by default) produces dense
features for each image. Those are computed once and cached, because they are the
expensive part and they never change — the encoder is not trained. What *is* trained
is a small convolutional head on top, which takes seconds to minutes even on a CPU.

Consequences worth knowing:

- **Scribbles are enough.** You do not need complete masks. A few strokes of
  foreground and background per frame is the intended input.
- **It adapts to your project.** The head learns the structures and modality in
  front of it, rather than applying a general-purpose model's idea of objects.
- **The model is saved in the project.** Reopening the `.dida` file restores the
  fitted head, so predictions stay reproducible and travel with the data.
- **Only reviewed frames are used for training.** Frames marked reviewed are
  treated as trustworthy labels; partially annotated frames are not.

The encoder is downloaded once, on request, the first time you use it. Nothing is
sent anywhere.

!!! tip "If training is slow"
    Check the device reported under the training panel. See
    [Troubleshooting](../troubleshooting.md#gpu-training-falls-back-to-the-cpu).
