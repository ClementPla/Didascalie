# Projects and files

## One file per project

A project is one `.dida` file. It contains the images (or the paths to them), the
annotations, the labels, the trained model if there is one, and the settings.

The file is a SQLite database. You can open it with any SQLite client, or read
and write it from Python with the [companion library](../python.md).

To back up or share a project, copy the file while it is closed. While a project
is open, `-wal` and `-shm` files sit next to it and hold the latest changes.

## Supported images

Images must be **8-bit RGB** (8-bit greyscale also works), in PNG, JPEG, TIFF or
BMP.

16-bit images, images with more than three channels, DICOM and NIfTI are not
supported. Convert them first: apply the intensity window you want and export
8-bit slices. The [Python library](../python.md) can then build the project.

A 3D volume is imported as a sequence with one image per slice.

## Embedded or referenced images

At import, images are either **embedded** in the project file or **referenced**
on disk.

| | Embedded | Referenced |
| --- | --- | --- |
| Project is self-contained | Yes | No |
| File size | Large | Small |
| Sharing | Send one file | Send the file and the image folder |

Embedded images are stored losslessly.

Referenced images are found through the input folder chosen at creation and
their path inside it. If you move or rename that folder, the project can no
longer load them.

Even in a referenced project, files under 100 KB are embedded.

## Sequences

Every image belongs to a **sequence**. A sequence can hold a single image, or
several frames that belong together: the slices of a volume, the frames of a
video, the visits of a patient.

With **folders as sequences**, each subdirectory of the input folder becomes one
sequence. Otherwise each image is its own sequence.

Sequences are what the gallery lists and reports progress on. The editor steps
through the frames of the open sequence, and
[registration](registration.md), [the inspector](inspect.md) and
[3D mode](../experimental.md#3d-volume-mode) all work on one sequence. 3D mode
needs every frame of the sequence to have the same size.

## Labels and tasks

Labels and tasks are defined for the whole project.

- **Segmentation labels** have a name and a colour. Each label has its own mask
  on each frame, so labels can overlap.
- **Instance segmentation** is a project option. Each label then separates up to
  255 objects per frame.
- **Classification tasks** are multiclass (one choice) or multilabel (several). A
  project can have several multiclass tasks and one multilabel task.
- **Text fields** hold a free-text note per frame.

Renaming or recolouring a label does not change the masks.
