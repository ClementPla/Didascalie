# The gallery and review

The gallery is the dataset-level view: what exists, what is done, and what still
needs attention.

## Filtering

Filter by:

- **name**, matching the sequence title;
- **status** — empty, annotated, or reviewed;
- **keypoint presence**, for sequences with or without keypoints;
- **frame count**, to isolate long or short sequences.

Sort order and thumbnail size are remembered between visits. Filters are not: they
describe the project you are in, so they reset when you open a different one.

## Review status

Three states, and the distinction matters:

| State | Meaning |
| --- | --- |
| Empty | No annotations |
| Annotated | Has annotations, not yet checked |
| Reviewed | Checked and trusted |

**Only reviewed frames are used to train a model.** Marking reviewed is therefore a
statement about label quality, not just progress tracking.

Frames can be marked reviewed individually, and sequences in bulk. Both can be
reversed — marking a batch un-reviewed is available alongside marking it reviewed.

## Batch classification

Select several images and apply multiclass or multilabel choices to all of them at
once. For datasets where most images share a label, this is far quicker than opening
each one.

<!-- SCREENSHOT: the gallery in grid view with a few items selected and the batch
     action visible. -->
