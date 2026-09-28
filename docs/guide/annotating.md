# Annotating

## Masks

Pixel-level masks, one per segmentation label. Tools: pen, eraser, lasso, lasso
eraser, line, point and flood fill. Brush size is adjustable, and with a pen or
touch device it can follow pressure.

Each label has its own mask, so overlapping annotations of different labels do not
compete for the same pixels.

## Vector shapes

Polygons, lines and keypoints, drawn with the path tool (++b++) and edited point by
point with the node tool (++n++). The select tool (++s++) moves and duplicates whole
shapes.

Vector and raster annotations sit on the same image and share one undo history.

### Converting between the two

- **Vectorize** (++v++) traces the outline of a mask region into an editable shape.
- **Skeletonize** (++k++) traces its centreline instead, which suits vessels, ducts
  and other elongated structures.
- **Rasterize** burns a shape back into the mask.

Each conversion is a single undoable step, even though it touches both subsystems.

## Keypoints

Points with a label, used on their own or as correspondences between two frames for
[registration](registration.md). The gallery can filter by whether a sequence has
keypoints.

## Classification

Multiclass and multilabel tasks, several per project, set from the editor or applied
to a whole selection from [the gallery](gallery.md#batch-classification).

## Text notes

A free-text note per frame, attached to a configurable text task. It belongs to the
frame rather than to any drawn region.

## Saving

Annotations save automatically a few seconds after you stop editing, and before
navigating away from a frame. ++ctrl+s++ saves immediately.

<!-- SCREENSHOT: the editor's left panel showing several labels, one active. -->
