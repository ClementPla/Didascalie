# Didascalie

Didascalie is a desktop application for annotating medical and biomedical images.
Drawing, image processing and model training all run on your own machine. Nothing
is uploaded.

A lot of medical image data cannot be sent to a cloud service. The tools that work
offline usually expect you to maintain a Python environment or to adopt a whole
analysis pipeline. Didascalie is an installer and a project file.

!!! note "Status"
    This is a solo research project under active development. The core annotation
    workflow is usable day to day. Features marked **experimental** are less
    reliable.

## Where to start

<div class="grid cards" markdown>

-   :material-download: **[Installing](install.md)**

    Installers for Windows, macOS and Linux, plus what you need for GPU training.

-   :material-rocket-launch: **[Quickstart](quickstart.md)**

    Create a project, annotate an image, and export the result.

-   :material-book-open-variant: **[User guide](guide/projects.md)**

    Projects, annotation types, assisted labelling, review workflow.

-   :material-language-python: **[Python library](python.md)**

    Read and write project files from Python, and convert to COCO or YOLO.

</div>

## What it can annotate

| Type | Notes |
| --- | --- |
| Segmentation masks | Brush, polygon, line, point, flood fill |
| Vector shapes | Polygons, lines and keypoints, convertible to and from masks |
| Classification | Multiclass and multilabel, several tasks per project |
| Keypoints | Including correspondences between frames for registration |
| Text notes | Per frame, attached to a configurable text task |

Raster and vector annotations are drawn on the same image and share one undo
history.

## Project files

A project is a single `.dida` file. It is an ordinary SQLite database that holds
the images (embedded or referenced on disk), the annotations, the label
definitions, any trained model and the project settings. To back up a project or
give it to a colleague, copy that file.
