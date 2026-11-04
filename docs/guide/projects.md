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

## Supported files

| Group | Formats | Extensions |
| --- | --- | --- |
| Images | PNG, JPEG, BMP, TIFF, WebP | `.png` `.jpg` `.jpeg` `.bmp` `.tif` `.tiff` `.webp` |
| Videos | MP4, MOV, MKV, WebM, AVI | `.mp4` `.m4v` `.mov` `.mkv` `.webm` `.avi` |
| Microscopy | Zeiss CZI, LSM and ZVI; Leica LIF; Nikon ND2; Olympus OIB/OIF and VSI; Imaris IMS; whole-slide SVS, NDPI, SCN and BIF; DeltaVision; Gatan DM; MetaMorph STK; OME-TIFF | `.czi` `.lsm` `.zvi` `.lif` `.nd2` `.oib` `.oif` `.vsi` `.ims` `.svs` `.ndpi` `.scn` `.bif` `.dv` `.r3d` `.dm3` `.dm4` `.stk` `.ome.tif` `.ome.tiff` |

Extensions are recognised whatever their case (`.PNG`, `.Tif`).

### Choosing what to import

When a project is created, and when images are added from the project
settings, **Formats** shows one button per group: **Images**, **Videos** and
**Microscopy**, all on by default. A button turns its whole group on or off; a
group with only some formats on shows a dashed outline and how many are on.

**More options** opens one button per format, to leave out, say, the TIFF files
of a folder but keep its PNGs, and two more settings:

- **Filename pattern**, a regular expression the file name must also match.
  It narrows the formats that are on rather than replacing them: `^scan_` keeps
  only the files whose name starts with `scan_`. The default, `.*`, takes any
  name.
- **Video frame step**, see [Videos](#videos).

The choice is saved with the project and offered again when images are added.

While the files are imported, a progress line shows what is being done (reading
images, indexing videos, converting microscopy files), how many files are done
out of how many, and the file last finished.

### Images

PNG, JPEG, TIFF, BMP and WebP images are imported as they are: 8-bit RGB or
greyscale, and **16-bit** or float greyscale and RGB too. A TIFF whose pages
are greyscale images of one size is read as **one image with a channel per
page**.

Images deeper than 8 bits, or with several channels, keep their values: the
editor shows them through the **Channels** panel (a window, colour and gamma per
channel, shared by the whole sequence), and Otsu and flood fill work on the
values themselves, not on what the screen shows.

#### The Channels panel

Drag the window on a channel's histogram: its edges, or the whole window. The
mouse wheel narrows or widens it, and **Shift** makes either finer. The axis
spans the frame's values (**Data**) or everything the type holds (**Full**),
on a **Linear** or **Log** scale.

**Auto** fits the window, clipping a little more at each press. **Clip** sets
every channel between two percentiles.

DICOM and NIfTI are not supported. Convert them first; the
[Python library](../python.md) can then build the project.

### Microscopy files

The formats of the **Microscopy** group in the table above, OME-TIFF
included, are converted when imported, at their own bit depth. A file is
recognised as OME-TIFF by its name (`.ome.tif`, `.ome.tiff`); other TIFF files are
read as images. Before
the import, a dialog lists every file with its series (fields, positions,
scenes) and lets you choose, per series or for every file at once:

- which channels to keep, by name;
- the slices: every one, the middle one, or a maximum projection;
- the time points: every one, one in N, or the first;
- for very large images, the resolution to import.

Each series becomes a sequence whose frames run through time, then slices. The
frames are stored in the project file, so the original files are not needed
afterwards. The channels start with the names and colours the file records.

The files are read by **didascalie-bioformats**, a separate program installed
with Didascalie on Windows, macOS and Linux (see
[`THIRD_PARTY_NOTICES.md`](https://github.com/ClementPla/Didascalie/blob/release/THIRD_PARTY_NOTICES.md)).
To use another copy, set the `DIDASCALIE_BIOFORMATS` environment variable to
it. Microscopy files cannot be imported on Android tablets.

A 3D volume is imported as a sequence with one image per slice.

### Videos

MP4, M4V, MOV, MKV, WebM and AVI files are imported too, each as one sequence.
**Video frame step** keeps one frame out of N: 1 keeps every frame, 10 one out of
ten. A video always stays on disk, even in an embedded project, and its frames are
decoded when they are shown.

Decoding needs [`ffmpeg`](https://ffmpeg.org/download.html), which is not
installed with Didascalie: install it so that it is on your `PATH`, or set the
`DIDASCALIE_FFMPEG` environment variable to the executable.

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
their path inside it. If the folder is not found when the project opens (it was
moved, or this computer reaches a network share by another path), you are asked
to locate it. You can also do it later with **Locate…** under **Image folder** in
the project settings. The project remembers every path it has been given, so the
same file still opens on the other computers.

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
