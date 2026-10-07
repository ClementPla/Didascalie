# Annotating

## Masks

Pixel-level masks, one per segmentation label. Tools: pen, eraser, lasso, lasso
eraser, line, point and flood fill. Brush size is adjustable, and can follow
pressure with a pen or touch device.

Each label has its own mask, so annotations of different labels can overlap.

## Vector shapes

Polygons, lines and keypoints. Draw them with the path tool (++b++) and edit them
point by point with the node tool (++n++). The select tool (++s++) moves and
duplicates whole shapes.

Vector and raster annotations are on the same image and share one undo history.

### Converting between the two

- **Vectorize** (++v++) traces the outline of a mask region into an editable shape.
- **Skeletonize** (++k++) traces its centreline, which suits vessels, ducts and
  other elongated structures.
- **Rasterize** burns a shape into the mask.

Each conversion is one undo step.

## Keypoints

Points with a label. They are used on their own, or as correspondences between two
frames for [registration](registration.md). The gallery can filter sequences by
whether they have keypoints.

## Classification

Multiclass and multilabel tasks, several per project. Set them in the editor, or
apply them to a whole selection from
[the gallery](gallery.md#batch-classification).

## Text notes

A free-text note per frame, attached to a configurable text task. The note belongs
to the frame as a whole.

## Saving

Annotations are saved automatically a few seconds after you stop editing, and
before you leave a frame. ++ctrl+s++ saves immediately.

<!-- SCREENSHOT: the editor's left panel showing several labels, one active. -->
