# Projects and files

## One file per project

A project is a single `.dida` file: an ordinary SQLite database holding images,
annotations, label definitions, any trained model, and settings. It can be copied,
backed up, versioned, or handed to a colleague as one file.

Because the format is plain SQLite, it is also inspectable with any SQLite client
and scriptable from Python — see [Python library](../python.md).

## Embedded or referenced images

When importing, you choose whether images are **embedded** in the project file or
**referenced** on disk.

| | Embedded | Referenced |
| --- | --- | --- |
| Project is self-contained | Yes | No — paths must stay valid |
| File size | Large | Small |
| Sharing | Send one file | Send the file and the images |

Embedding stores images losslessly. This is deliberate: lossy recompression is not
acceptable for medical imaging, so embedded images are not re-encoded to JPEG.

A size threshold decides per image when the project is set to embed selectively.

## Sequences

Images can be grouped into **sequences** — a patient, an acquisition, a slide, a
time series. Sequences are a navigation and organisation unit: you step through
frames within one, and the gallery reports progress per sequence.

Grouping can follow the folder structure at import time, so a directory of
directories becomes a set of sequences.

## Labels and tasks

Labels are defined per project and shared across all its images:

- **Segmentation labels** each have a name and a colour, and get their own mask.
- **Classification tasks** are multiclass or multilabel, and a project can have
  several.
- **Text tasks** attach a free-text note to each frame.

Changing a label's colour affects display only. Masks are stored per label, so
renaming or recolouring never rewrites annotation data.
