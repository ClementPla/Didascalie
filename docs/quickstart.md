# Quickstart

This walks through one project end to end: create it, annotate an image, train a
head on a few scribbles, and read the result back out.

## 1. Create a project

Launch Didascalie and choose **New project**. You will be asked for:

- a **name** and where to save the `.dida` file;
- an **input folder** of images;
- whether to **embed** the images or reference them on disk
  ([which to pick](guide/projects.md#embedded-or-referenced-images));
- which **annotation types** the project uses — segmentation, classification, text.

Define at least one segmentation label before continuing. Each gets a name and a
colour.

<!-- SCREENSHOT: the new-project dialog with a folder chosen and one label defined. -->

## 2. Annotate a frame

The gallery opens on the imported images. Double-click one to open the editor.

Pick the pen (++p++) and draw. Switch labels with ++ctrl+tab++. Undo is ++ctrl+z++
and covers both mask and vector edits.

To save effort, draw roughly and then let an operator tidy the boundary — see
[Assisted labelling](guide/assistance.md#operators-bounded-by-your-stroke).

<!-- SCREENSHOT: the editor with a mask drawn over an image. -->

## 3. Mark it reviewed

When a frame is finished, mark it **reviewed**. This is not only bookkeeping: model
training uses reviewed frames only, so marking is what promotes a frame from
"worked on" to "trustworthy label".

## 4. Train on a few scribbles

Open the model panel. With a handful of reviewed frames, train. The first run
downloads the encoder and computes features per image, which is the slow part;
afterwards features are cached and retraining is fast.

Apply the result to unlabelled frames, then correct the predictions rather than
drawing from scratch. Details in [Assisted labelling](guide/assistance.md).

## 5. Get the data out

Either export from the app — see [Import and export](guide/import-export.md) — or
read the project directly from Python:

```python
from didascalie import DidascalieProject

with DidascalieProject.open("dataset.dida") as project:
    for frame in project.frames():
        masks = project.masks(frame)
        ...
```

See [Python library](python.md).
