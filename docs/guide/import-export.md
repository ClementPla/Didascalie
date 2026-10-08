# Import and export

## Importing

Images are imported from a folder when the project is created, and more can be
added later. Options at import time:

- **recursive**, to walk subdirectories;
- **folders as sequences**, so each subdirectory becomes a sequence;
- a **filename pattern**, to include only matching files;
- **embed or reference** the image data
  ([which to pick](projects.md#embedded-or-referenced-images)).

Existing masks can be imported with the images, so you can continue a partially
labelled dataset.

## Exporting

Annotations can be exported as mask images, or in **COCO** or **YOLO** layout.
COCO and YOLO datasets can also be imported.

## With several accounts

In a project with [several accounts](multi-user.md), import and export work on
the account you are signed in with:

- **Export** writes your annotations, and "reviewed only" means reviewed by you.
  To export another annotator's work, sign in as them.
- **Imported annotations** become yours.
- **Import annotations…** on the start page runs before anyone has signed in. It
  works on a project with a single account without a password; on any other
  project it stops with "Nobody is logged in".

## Or skip the UI

The companion Python library reads and writes `.dida` files directly, including
COCO and YOLO conversion. Prefer it for anything scripted or repeated. See
[Python library](../python.md).

!!! note "DICOM and NIfTI"
    Not supported yet. Supported image formats are PNG, JPEG, TIFF and BMP.
