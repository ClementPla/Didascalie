<h1 align="center">Didascalie</h1>

<p align="center">
  A desktop tool for annotating medical images, running entirely on your own machine.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-BSD--3--Clause-blue">
  <img alt="Desktop" src="https://img.shields.io/badge/desktop-Tauri%20v2-24C8DB">
  <img alt="UI" src="https://img.shields.io/badge/UI-Angular%2020-DD0031">
  <img alt="Core" src="https://img.shields.io/badge/core-Rust-000000">
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey">
  <img alt="Status" src="https://img.shields.io/badge/status-in%20development-orange">
</p>

---

Segmentation masks, classification labels, keypoints, and a few other annotation types — with nothing leaving your machine.

It's a solo research project, built mostly for my own work in medical image analysis, where the data often can't be uploaded to a cloud service. It is under active development, and the name recently changed from *LabelMed*. Expect rough edges, breaking changes, and features in varying states of completeness.

The name: a *didascalie* is a stage direction — one of the little notes in a play script. It seemed like a reasonable word for annotations, which are really just notes added to data. (Pronounced *di-da-ska-LEE*.)

> **Status:** early and evolving. The core annotation workflow is usable day-to-day; the parts marked *experimental* below are not.

<!-- Suggested image: a screenshot of the editor with an image open and a mask drawn. One honest screenshot is plenty. -->
<!-- ![The editor](doc/images/editor.png) -->

## What it does

- **Runs locally.** Annotation and image processing happen on your machine; nothing is uploaded. This is the main reason the tool exists.
- **Segmentation masks**, drawn with brush, polygon, line, point, and flood-fill tools. A few classical helpers (thresholding, flood fill, CRF edge cleanup) are there to make manual masking a bit less tedious.
- **Classification labels**, both multiclass and multilabel, with several tasks per project.
- **Keypoints** and **vector shapes** (polygons/lines) as annotation types, plus short **text notes** per frame (tied to a configurable text task, not to a specific drawn region).
- **Multi-frame projects.** Images can be grouped into sequences and navigated frame by frame (this is just navigation — there is no automatic propagation of annotations between frames).
- **Frame registration.** Pick a reference and a moving frame from a sequence, place corresponding keypoints between them, and see the estimated homography update in real time, with fairly advanced visualization options for checking the alignment.
- **One file per project.** A project is a single `.dida` file (SQLite underneath) holding the images (embedded or referenced), masks, labels, and metadata. Easy to copy, back up, or hand to someone else.
- **Image adjustments for readability.** Brightness/contrast, gamma correction, and color inversion, applied on the fly while you look at an image — these only change what you see, not the underlying data.
- **A filterable gallery to track progress.** Filter by review status, by whether keypoints are present, or by name, and sequences show how much of their content has been annotated/reviewed — useful for keeping track of where you are in a larger dataset.
- **Batch classification from the gallery.** Select several images at once and apply multiclass/multilabel classification choices to all of them in one action, instead of opening each one individually.

## Why you might use it

There are several good open-source annotation tools already, so here are a few honest reasons this one might suit you:

- **A responsive UI, even on large medical images.** The heavy work — mask encoding, image decoding, file I/O — runs in a compiled Rust backend rather than in a browser tab or a Python layer, so the canvas stays responsive instead of freezing on big files. Masks are RLE-encoded, and the gallery lazy-loads thumbnails as they scroll into view, so it holds up on datasets with a lot of images.
- **Both vector and raster annotation, in the same tool.** Pixel-level segmentation masks (brush/polygon/flood-fill) and vector shapes (polygons, lines, keypoints) live side by side on the same image, instead of forcing you into one paradigm or a separate tool for each.
- **Genuinely multiplatform.** Ships as a native installer for Windows, macOS (Intel and Apple Silicon), and Linux, built from the same codebase.
- **Projects are one shareable file.** Since a whole project is a single `.dida` file, handing an annotation task to a collaborator — or getting the results back — is just sending one file, not a folder of images plus a separate database or a running server.
- **It's been used for real work.** Annotations produced with it have gone into published research (for example, the DNAi study<!-- TODO: add citation / DOI / link -->), not just demos.
- **Shaped by people who actually annotate.** It has been developed with continuous feedback from clinicians and researchers across several medical fields who use it on real data, so the workflow reflects how experts actually work rather than my own assumptions.
- **Open to suggestions.** It's a young, solo project without a fixed roadmap set in stone — if there's a feature or workflow you need, it's genuinely easy to influence what gets built next. See [Contributing](#contributing).

## Experimental / work in progress

These exist in the codebase but are not finished or well tested — use with low expectations:

- **SAM-based mask refinement.** There is an ONNX-based model path for turning a coarse mask into a cleaner one, but it is not polished, benchmarked, or reliable yet.
- **Keypoint suggestion for registration.** An optional bridge to a Python process (over ZeroMQ) can suggest keypoint correspondences for the registration mode above, instead of placing them all by hand. Rough and narrow in scope for now.

Planned, not started yet:

- **Converting between raster and vector shapes.** Vector shapes can already be rasterized into a mask internally, but going the other way — turning a painted mask into an editable vector shape — doesn't exist yet. The goal is to make that conversion work both ways.

## The `.dida` format and the Python library

A `.dida` file is an ordinary SQLite database, so it's inspectable and scriptable, not a proprietary blob. The companion Python library, [**pydidascalie**](https://github.com/ClementPla/pydidascalie), reads and writes that format directly. Typical uses:

- **Pre-populate a project from a model.** Run your own segmentation/classification model over a folder of images and write the predictions straight into a `.dida` file, so annotators open the app and start from a draft instead of a blank image — you correct the model instead of annotating from scratch.
- **Bulk import.** Load a folder of images (optionally with existing masks) into a new project without clicking through the UI one file at a time.
- **Read results back out.** Once annotation is done, iterate over frames/labels/masks directly from Python for training or analysis.
- **Convert to/from COCO and YOLO**, for moving datasets in or out of other tooling.

It's **not published on PyPI** — install it straight from the repo:

```bash
pip install git+https://github.com/ClementPla/pydidascalie.git
```

```python
from didascalie import DidascalieProject, Label

with DidascalieProject.create("dataset.dida", name="My Dataset") as project:
    project.add_label(Label(name="lesion", color="#FF0000"))
    project.import_folder("/path/to/images")
```

Requires `numpy` and `Pillow` (and `pyzmq` if you use the optional Python bridge described below).

## Installing

Prebuilt installers for **Windows, macOS (Intel and Apple Silicon), and Linux** are built automatically by GitHub Actions and attached to each release — download the one for your platform from the [Releases page](https://github.com/ClementPla/Didascalie/releases).

### Building from source

If you'd rather build it yourself:

**Requirements:** [Node.js + npm](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install), and the [Angular CLI](https://angular.dev/tools/cli).

```bash
git clone https://github.com/ClementPla/Didascalie.git
cd Didascalie
npm install
npm run tauri dev      # run in development
npm run tauri build    # build binaries (in src-tauri/target/release/)
```

## Built with

Angular 20 (UI) · Tauri v2 / Rust (desktop shell and native processing) · OpenCV compiled to WASM (image operations) · ONNX Runtime (the experimental model path) · ZeroMQ (the experimental Python bridge).

## Contributing

It's a one-person project, so responses may be slow, but bug reports and suggestions are welcome — please open an issue. If you work with medical images and something is missing or awkward, I'd like to hear about it.

## License

BSD 3-Clause. See [`LICENSE`](LICENSE).
