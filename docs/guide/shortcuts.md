# Keyboard shortcuts

Shortcuts are ignored while the focus is in a text field, so typing a label name
never triggers a tool change.

## Tools

| Action | Keys |
| --- | --- |
| Pen | ++1++ or ++p++ |
| Eraser | ++2++ or ++e++ |
| Lasso | ++3++ or ++shift+l++ |
| Lasso eraser | ++4++ or ++ctrl+shift+e++ |
| Line | ++l++ |
| Pan | ++g++ |
| Path (Bézier) | ++b++ |
| Node (edit points) | ++n++ |
| Select (move/duplicate paths) | ++s++ |
| Vectorize (trace an outline) | ++v++ |
| Skeletonize (trace a centreline) | ++k++ |

Holding the middle mouse button pans from any tool, without switching to Pan.

## Editing

| Action | Keys |
| --- | --- |
| Undo | ++ctrl+z++ |
| Redo | ++ctrl+y++ |

One history covers both raster and vector edits, so ++ctrl+z++ reverses whatever
you did last regardless of which kind it was. An action touching both — rasterising
a shape, for instance — is undone in a single step.

## View

| Action | Keys |
| --- | --- |
| Toggle visibility of all labels | ++tab++ |
| Next label | ++ctrl+tab++ |
| Previous label | ++ctrl+shift+tab++ |
| Toggle edge display | ++ctrl+e++ |
| Toggle image processing | ++q++ |
| Toggle post-processing | ++d++ |
| Zoom in | ++equal++ or ++plus++ |
| Zoom out | ++minus++ |

## Navigation

| Action | Keys |
| --- | --- |
| Next sequence | ++arrow-right++ |
| Previous sequence | ++arrow-left++ |
| Next frame in sequence | ++arrow-up++ |
| Previous frame in sequence | ++arrow-down++ |

## File

| Action | Keys |
| --- | --- |
| Save annotations | ++ctrl+s++ |

Annotations also save automatically a few seconds after you stop editing, and
before navigating away from a frame.
