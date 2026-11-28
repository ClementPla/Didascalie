# Annotating

Double-click a sequence in the gallery to open it in the editor.

<!-- SCREENSHOT: the whole editor with a mask drawn, labels panel on the left and settings on the right. -->

## Labels

Click a label in the left panel to make it active. Everything you paint goes to
the active label. ++ctrl+tab++ and ++ctrl+shift+tab++ move to the next and
previous label.

The panel also has:

- an **opacity** slider for the masks;
- a button to hide or show all labels (++tab++);
- a button to clear every label on the frame.

++ctrl+e++ shows the masks as outlines.

## Painting masks

Each label has its own mask, so two labels can cover the same pixels.

| Tool | Key |
| --- | --- |
| Pen | ++p++ |
| Line | ++l++ |
| Lasso | ++shift+l++ |
| Eraser | ++e++ |
| Lasso eraser | ++ctrl+shift+e++ |

The lasso tools work on a closed outline you draw: the lasso fills it, the lasso
eraser clears it.

++ctrl++ + wheel changes the brush size. With a stylus, **Pressure sensitivity**
makes the brush wider as you press harder.

Options next to the tools:

- **Swap labels**: the stroke replaces any other label under it.
- **All labels** (eraser): erases every label, not only the active one.
- **Connected regions** (eraser): removes every connected region the stroke
  touches, which is quicker than rubbing out a region pixel by pixel.

A stroke does not have to follow the boundary. With **Auto-segment** (++d++), an
operator refines each stroke when you release it. See
[Assisted labelling](assistance.md).

### Instances

In an instance-segmentation project, each label separates up to 255 objects per
frame. Select the instance to paint in the labels panel. With
**Auto-increment instance after each stroke**, every stroke starts a new object.

## Vector shapes

Shapes are outlines and lines drawn on top of the image. They stay editable
point by point, unlike a mask. An outline can be open or closed, and a closed one
can be filled.

| Tool | Key | What it does |
| --- | --- | --- |
| Draw shape | ++b++ | Click to place the points of a new outline or line |
| Box | ++r++ | Drag to draw a box |
| Ellipse | ++o++ | Drag to draw an ellipse |
| Edit points | ++n++ | Drag the points of an existing shape |
| Select | ++s++ | Move, rotate, duplicate or delete a whole shape |

While dragging out a box or an ellipse, ++shift++ keeps it square or circular
and ++ctrl++ draws it from its center. Both are ordinary shapes once drawn, so
**Edit points** can reshape them.

A selected shape shows a pivot at its center with a knob above it. Drag the
pivot to move the shape and the knob to rotate it; hold ++shift++ to rotate in
15° steps. With several shapes selected they move and rotate together.

A box or an ellipse selected on its own also shows a grip on each side: drag one
to move that side in or out, the opposite side staying where it is. This works
at any rotation. The pivot also appears on a shape just drawn with **Box** or **Ellipse**, and
clicking another shape with those tools moves it there.

### Converting between masks and shapes

- **Trace outline** (++v++): click a painted region to get its border as a shape.
- **Trace centerline** (++k++): click a painted region to get its centreline as a
  line. Use it for vessels, ducts and other elongated structures.
- **Rasterize** (the paint-roller button next to the vector tools): paints every
  shape back into the mask of its label.

## Display options

The menu on the right of the editor has a few more switches:

- **Apply image adjustments** (++q++): brightness, contrast, gamma and tone
  curves, set in the settings panel. The stored image is never modified, but the
  [operators](assistance.md#adjustments-feed-the-operators) see the adjusted one.
- **Show only edges** (++ctrl+e++): masks as outlines.
- **Show bounding boxes**: a box around each connected region of each label.
  **Merge boxes across labels** boxes the regions of all visible labels
  together. **Erase an object by clicking its bounding box** makes a click on a
  box, with the eraser active, remove that region, or delete that shape.
- **Fit to view after navigation** (on by default): the image is refitted when
  you change frame. Turn it off to keep the same zoom and position while
  comparing frames.
- **GPU rendering** (on by default): draws the labels on the GPU, which is
  faster on large images. The application falls back to the CPU by itself when
  the GPU is unavailable; turn it off if the labels display incorrectly.

## Moving around

| Action | Keys |
| --- | --- |
| Pan | ++g++, hold ++space++, or middle mouse button |
| Zoom | Wheel, or ++plus++ and ++minus++ |
| Next / previous frame | ++arrow-up++ / ++arrow-down++ |
| Next / previous sequence | ++arrow-right++ / ++arrow-left++ |

## Undo

++ctrl+z++ undoes and ++ctrl+y++ redoes. Mask and shape edits share one history.
A conversion between the two is one step.

The history belongs to the frame. It is reset when you open another frame.

## Working on a sequence

For a sequence with several frames, the **Navigation** panel adds:

- **Propagate labels…**: copies the labels of the current frame to the following
  frames, or to all the other frames. You can copy all labels or only the active
  one. The copied labels replace what the target frames had. The copy button in
  the editor menu repeats the last choice, after asking for confirmation.
- **Clear sequence**: removes the labels of every frame.
- **Inspect sequence**: plays the sequence with its labels. See
  [Inspecting sequences](inspect.md).

## Classification and text

If the project has classification tasks or text fields, they appear in the left
panel under the labels. They apply to the frame as a whole.

To classify many images at once, use
[batch classification](gallery.md#batch-classification) in the gallery.

## Keypoints

Keypoints are used as correspondences between two frames. They are placed in the
registration view, not in the editor. See [Frame registration](registration.md).

## Saving and review

Annotations are saved automatically a few seconds after you stop editing, and
when you leave a frame.

++ctrl+s++ saves immediately and marks the frame **reviewed**. You can also mark
or unmark a frame, or the whole sequence, with the two review buttons. Only
reviewed frames are used to [train a model](assistance.md#training-a-model-on-your-own-data).

All shortcuts are listed in [Keyboard shortcuts](shortcuts.md).
