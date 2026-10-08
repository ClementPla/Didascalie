# Projects and files

## One file per project

A project is one `.dida` file. It contains the images (or the paths to them), the
annotations, the labels, the trained model if there is one, and the settings.
When [several people annotate](multi-user.md) the project, their accounts and
each one's annotations are in that same file.

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

Labels and tasks are defined for the whole project, and shared by all of its
[accounts](multi-user.md): every annotator works with the same labels.

- **Segmentation labels** have a name and a colour. Each label has its own mask
  on each frame, so labels can overlap.
- **Instance segmentation** is a project option. Each label then separates up to
  255 objects per frame.
- **Classification tasks** are multiclass (one choice) or multilabel (several). A
  project can have several multiclass tasks and one multilabel task.
- **Text fields** hold a free-text note per frame.

Renaming or recolouring a label does not change the masks.

## Changing a project after it is created

The **Project settings** page (the cog in the top bar) edits the open project.
It is reserved to [administrators](multi-user.md#roles), because what it changes
is shared: deleting a label erases it from every account's annotations, and the
counts shown before a deletion cover all accounts.
There is no Save button: each change is written to the project file as you make
it.

| You can | What happens to the annotations |
| --- | --- |
| Rename the project | Nothing. The file keeps its name and place. |
| Rename a label, task, class or text field | They follow the new name. |
| Change a label's colour | Every frame shows the new colour. |
| Add a label, task, class or text field | Nothing. |
| Reorder labels (drag the handle) | Nothing, but labels get new class numbers in later exports. |
| Switch segmentation, classification or text off | They are hidden, not deleted. Switch it back on to get them back. |
| Delete a label | Its masks and shapes are erased on every frame. |
| Delete a task or a class | The answers given with it are erased. |
| Delete a text field | The text written in it is erased. |

!!! danger "Deletions are permanent"

    Deleting a label, task, class or text field that has been used erases those
    annotations from the project file straight away. ++ctrl+z++ does not bring
    them back. The page tells you how many frames are affected and asks you to
    confirm; copy the `.dida` file first if you are not sure.

    Deleting a label also discards the trained model if it predicts that label.

Semantic or instance segmentation is chosen when the project is created and
cannot be changed afterwards.

### Adding images

**Add images** on the same page imports a folder into the project. Images the
project already has are skipped, so the same folder can be added again after
new files arrive.

- A folder **inside the project's image folder** is added the same way as at
  creation. With **folders as sequences**, new files in a folder that is already
  a sequence are appended to that sequence.
- A folder **anywhere else** is always embedded in the project file, because a
  project can only reference images in its one image folder. Its sequences are
  new ones, even when their names match existing ones.
