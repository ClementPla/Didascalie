# Python library

A `.dida` file is an ordinary SQLite database. The companion library
[**pydidascalie**](https://github.com/ClementPla/pydidascalie) reads and writes it
directly. The application does not need to be running.

## Installing

It is not published on PyPI. Install from the repository:

```bash
pip install git+https://github.com/ClementPla/pydidascalie.git
```

Requires `numpy` and `Pillow`, plus `pyzmq` and `msgpack` if you use the
[Python functions bridge](guide/python-functions.md).

## Creating a project

```python
from didascalie import DidascalieProject, Label

with DidascalieProject.create("dataset.dida", name="My Dataset") as project:
    project.add_label(Label(name="lesion", color="#FF0000"))
    project.import_folder("/path/to/images")
```

## What it is for

**Pre-populating a project from a model.** Run your own model over a folder and
write the predictions into a `.dida` file. Annotators then correct a draft, which
is usually much faster than annotating a blank image.

**Bulk import.** Load a folder of images, optionally with existing masks, without
going through the UI.

**Reading results.** Iterate over frames, labels and masks for training or
analysis.

**Format conversion.** To and from COCO and YOLO.

## Files and formats

`import_folder` takes files the way the application does: by extension first
(`extensions=`, or the project's formats), then by `pattern`. It reads PNG,
JPEG, BMP and TIFF images. Videos and microscopy files are skipped: import them
from the application, then read the project from Python.

`get_frame_image` returns a frame as the application shows it, 8-bit RGB. For a
16-bit or multi-channel frame, such as a converted microscopy file,
`raw=True` returns its own values instead, as a `(height, width, channels)`
array of `uint8`, `uint16` or `float32`:

```python
with DidascalieProject("cells.dida") as project:
    values = project.get_frame_image(frame_id, raw=True)
    print(values.dtype, values.shape)   # uint16 (1024, 1024, 3)
```

## Accounts

A project the library creates has no [accounts](guide/multi-user.md). The
application adds one administrator account the first time it opens the file, and
that account owns everything the library wrote.

On a project that has accounts, the library reads and writes the annotations of
one account at a time: the first administrator by default, or the one you name.

```python
from didascalie import DidascalieProject

with DidascalieProject("study.dida", user="First observer") as project:
    print([u.name for u in project.get_users()])
    project.set_user("Second observer")   # switch account
```

`enable_user_accounts()` gives accounts to a project without them, as the
application does, and `add_user()` adds one. This is how to keep a model's
predictions next to the annotators' work instead of over it:

```python
with DidascalieProject("study.dida") as project:
    project.add_user("unet-v2")
    project.set_user("unet-v2")
    project.add_annotation(frame_id, label_id, mask)
```

The model then appears as one more grader on the
[inter-grader agreement](guide/multi-user.md) page, where it is compared with the
annotators or with another model.

## The round trip

These uses combine into a loop: write predictions from Python, correct them in the
application, read the corrected labels back, retrain. No server is involved; the
project file is all that moves between steps.
