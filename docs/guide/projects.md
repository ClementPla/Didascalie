# Projects and files

## One file per project

A project is a single `.dida` file: an ordinary SQLite database that holds images,
annotations, label definitions, any trained model and settings. You can copy it,
back it up, version it, or send it to a colleague.

Any SQLite client can open it, and it can be scripted from Python (see
[Python library](../python.md)).

## Embedded or referenced images

When importing, you choose whether images are **embedded** in the project file or
**referenced** on disk.

| | Embedded | Referenced |
| --- | --- | --- |
| Project is self-contained | Yes | No, paths must stay valid |
| File size | Large | Small |
| Sharing | Send one file | Send the file and the images |

Embedded images are stored losslessly. They are never re-encoded to JPEG, because
lossy compression is not acceptable for medical images.

A project can also embed selectively. A size threshold then decides for each
image.

## Sequences

Images can be grouped into **sequences**: a patient, an acquisition, a slide, a
time series. You step through the frames of a sequence in the editor, and the
gallery reports progress per sequence.

At import time, grouping can follow the folder structure. Each subdirectory then
becomes a sequence.

## Labels and tasks

Labels are defined per project and shared by all its images:

- **Segmentation labels** each have a name and a colour, and get their own mask.
- **Classification tasks** are multiclass or multilabel, and a project can have
  several.
- **Text tasks** attach a free-text note to each frame.

Masks are stored per label. Renaming or recolouring a label changes how it is
displayed and leaves the annotation data untouched.
