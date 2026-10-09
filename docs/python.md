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
[Python bridge](experimental.md#python-bridge).

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

## Accounts

The library does not know about [accounts](guide/multi-user.md) yet. A project it
creates has none; the application adds one administrator account the first time
it opens the file, and that account owns everything the library wrote.

## The round trip

These uses combine into a loop: write predictions from Python, correct them in the
application, read the corrected labels from Python, retrain, and start again. No
server is involved. The project file is all that moves between steps.
