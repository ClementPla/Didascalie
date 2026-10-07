# The gallery and review

The gallery shows the whole dataset: what it contains, what is done, and what
still needs work.

## Filtering

Filter by:

- **name**, matching the sequence title;
- **status**: empty, annotated, or reviewed;
- **keypoint presence**, for sequences with or without keypoints;
- **frame count**, to isolate long or short sequences.

Sort order and thumbnail size are remembered between visits. Filters are reset
when you open a different project.

## Review status

| State | Meaning |
| --- | --- |
| Empty | No annotations |
| Annotated | Has annotations, not yet checked |
| Reviewed | Checked and trusted |

**Only reviewed frames are used to train a model.** Mark a frame reviewed when you
are satisfied with its labels, since the model will learn from them.

Frames can be marked reviewed one by one, and sequences in bulk. Both can be
undone: a batch can be marked un-reviewed the same way.

## Playing a sequence back

The video button on a sequence opens the [inspector](inspect.md), which plays it
with its masks overlaid. Select several sequences and click **Inspect side by
side** to compare them.

## Batch classification

Select several images and apply multiclass or multilabel choices to all of them at
once. When most images of a dataset share a label, this is much quicker than
opening each one.

<!-- SCREENSHOT: the gallery in grid view with a few items selected and the batch
     action visible. -->
