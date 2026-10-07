# The gallery and review

The gallery lists the sequences of the project, with their progress. It is where
you pick what to work on, check what is left, and act on several sequences at
once.

<!-- SCREENSHOT: the gallery in grid view with a few items selected and the batch
     actions visible. -->

## Opening a sequence

Double-click a sequence to open it in the editor. Each sequence also has buttons
to:

- open it in the [inspector](inspect.md), which plays it with its masks;
- open the [registration view](registration.md) (**Pair keypoints**), for
  sequences with at least two frames.

Hovering over a sequence with several frames previews them in its thumbnail.

## Finding sequences

- **Search** by sequence name.
- **Status**: not started, in progress or reviewed.
- **Frame count**, to keep only long or short sequences.
- **Keypoints**, to keep sequences with or without keypoints.

Sequences can be sorted by name, number of frames or progress, and shown as a
grid or a list. **Reset filters** clears the filters.

The sort order, the layout and the thumbnail size are remembered. Filters are
reset when you open another project.

## Review status

| Status | Meaning |
| --- | --- |
| Not started | No annotation |
| In progress | Has annotations, not fully reviewed |
| Reviewed | Checked |

**Only reviewed frames are used to train a model.** Mark a frame reviewed when you
are satisfied with its labels.

A frame is marked reviewed from the editor, with the review button or by saving
with ++ctrl+s++. In the gallery, the review button of a sequence marks all its
frames, and **Mark as reviewed** does the same for the selection. Both can be
undone with **Mark as not reviewed**.

## Acting on several sequences

Click sequences to select them. ++shift++ + click selects a range, and
**Select all** takes everything that matches the current filters.

With a selection you can:

- **Mark as reviewed** or **not reviewed**;
- **Inspect side by side**, with up to six sequences;
- apply a classification, as described below.

### Batch classification

If the project has classification tasks, choose the classes above the gallery
and click **Apply**. Every frame of the selected sequences gets them.

This is quicker than opening each image when most of a dataset shares a class.

## Refreshing

**Refresh** reloads the list. With auto-refresh on, the gallery reloads every few
seconds, which is useful while a script writes to the project.
