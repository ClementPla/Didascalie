# Python library

A `.dida` file is an ordinary SQLite database, so it is inspectable and scriptable
rather than a proprietary blob. The companion library
[**pydidascalie**](https://github.com/ClementPla/pydidascalie) reads and writes that
format directly, without the application running.

## Installing

It is not published on PyPI. Install from the repository:

```bash
pip install git+https://github.com/ClementPla/pydidascalie.git
```

Requires `numpy` and `Pillow`, plus `pyzmq` if you use the
[Python bridge](experimental.md#keypoint-suggestion).

## Creating a project

```python
from didascalie import DidascalieProject, Label

with DidascalieProject.create("dataset.dida", name="My Dataset") as project:
    project.add_label(Label(name="lesion", color="#FF0000"))
    project.import_folder("/path/to/images")
```

## What it is for

**Pre-populating a project from a model.** Run your own model over a folder and write
the predictions into a `.dida` file. Annotators then open a draft and correct it
instead of starting from a blank image, which is usually much faster than annotating
from scratch.

**Bulk import.** Load a folder of images, optionally with existing masks, without
clicking through the UI file by file.

**Reading results back out.** Iterate over frames, labels and masks directly for
training or analysis.

**Format conversion.** To and from COCO and YOLO, for moving datasets between tools.

## The round trip

The two halves are meant to be used together: write predictions in from Python,
correct them in the application, read the corrected labels back out, retrain, and
repeat. Nothing in that loop needs a server, and the project file is the only thing
that moves between steps.
