# Didascalie

Didascalie is a desktop application for annotating medical and biomedical images.
Everything it does — drawing, image processing, and training models — runs on your
own machine. Nothing is uploaded.

It exists because much medical image data cannot be sent to a cloud service, and
the tools that avoid the network tend to assume you will maintain a Python
environment or adopt a whole analysis pipeline.

!!! note "Status"
    This is a solo research project under active development. The core annotation
    workflow is usable day to day. Anything marked **experimental** is not.

## Where to start

<div class="grid cards" markdown>

-   :material-download: **[Installing](install.md)**

    Installers for Windows, macOS and Linux, plus what you need for GPU training.

-   :material-rocket-launch: **[Quickstart](quickstart.md)**

    Create a project, annotate an image, and get the result back out.

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

Raster and vector annotations live on the same image and share one undo history.

## The shape of a project

A project is a single `.dida` file. It is an ordinary SQLite database holding the
images (embedded or referenced on disk), the annotations, the label definitions,
any trained model, and the project settings. Copying, backing up, or handing a
project to a colleague means moving one file.
