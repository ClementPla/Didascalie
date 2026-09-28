# Import and export

## Importing

Images are imported from a folder when the project is created, and more can be added
later. Options at import time:

- **recursive**, to walk subdirectories;
- **folders as sequences**, so each subdirectory becomes a sequence;
- a **filename pattern**, to include only matching files;
- **embed or reference** the image data
  ([which to pick](projects.md#embedded-or-referenced-images)).

Existing masks can be imported alongside the images, so a partially labelled dataset
does not start from nothing.

## Exporting

Annotations export to mask images, and to **COCO** and **YOLO** layouts. Both of
those conversions also work in the other direction, so a dataset can be brought in
from other tooling and taken back out.

## Or skip the UI

Since a `.dida` file is plain SQLite, the companion Python library reads and writes
it directly — including COCO and YOLO conversion — which is usually better for
anything scripted or repeated. See [Python library](../python.md).

!!! note "DICOM and NIfTI"
    Not supported yet. Images go in through the standard formats
    (PNG, JPEG, TIFF, BMP).
