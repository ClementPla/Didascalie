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

- **Runs locally.** Annotation, image processing and model training all happen on your machine. Nothing is uploaded. This is why the tool exists.
- **Segmentation masks**, drawn with brush, polygon, line, point and flood-fill tools.
- **Vector shapes** (polygons, lines, keypoints) on the same image as the masks, with one undo history covering both. Masks can be traced into editable shapes and shapes rasterised back into masks, including tracing a region's centreline instead of its outline.
- **Classification labels**, multiclass and multilabel, with several tasks per project.
- **Text notes** per frame, tied to a configurable text task rather than to a drawn region.
- **Very large images.** A resolution pyramid with native-resolution tiles loaded on demand, so gigapixel microscopy can be annotated at full zoom without the browser trying to decode the whole thing at once.
- **Multi-frame projects.** Images can be grouped into sequences and navigated frame by frame.
- **Frame registration.** Pick a reference and a moving frame from a sequence, place corresponding keypoints, and watch the estimated homography update as you go, with overlay and checkerboard views for checking the result.
- **One file per project.** A project is a single `.dida` file (SQLite underneath) holding the images (embedded or referenced), masks, labels, trained models and metadata. Easy to copy, back up, or hand to someone else.
- **Image adjustments for readability.** Brightness, contrast, gamma, tone curves and colour inversion, applied while you look at an image. They change what you see, and optionally what the assistance tools read, but never the stored pixels.
- **A filterable gallery to track progress.** Filter by review status, keypoint presence or name. Sequences show how much of their content is annotated and reviewed, and individual frames can be marked reviewed too.
- **Batch classification from the gallery.** Select several images and apply multiclass/multilabel choices to all of them at once.

## Assistance while annotating

Two kinds, with different setup costs.

**Nothing to set up.** Rough in a region with the brush and refine it inside that stroke: dynamic Otsu thresholding, flood fill with a tolerance, superpixel selection, connected-component erasure, with optional morphological opening and a connectivity constraint. These are deterministic and instant, and the image adjustments above can be routed into them, so you can raise contrast on a faint structure until it's visible and have the algorithm read the same pixels you do.

**Train a model on your own data.** Scribble on a few frames and Didascalie fits a small segmentation head, then applies it to the rest. Dense features come from a frozen self-supervised encoder (DINOv3 by default), computed once per image and cached; only the head is trained, which takes seconds to minutes on a laptop rather than needing a GPU server. The fitted head is saved inside the project file and restored when you reopen it. The encoder is downloaded once, on request; nothing is sent anywhere.

## Why you might use it

There are several good open-source annotation tools already. Reasons this one might suit you:

- **A responsive UI on large medical images.** Mask encoding, image decoding and file I/O run in a compiled Rust backend instead of a browser tab or a Python layer, so the canvas stays responsive on big files. Masks are run-length encoded and the gallery lazy-loads thumbnails as they scroll into view.
- **Vector and raster annotation in one tool.** Pixel-level masks and vector shapes coexist on the same image, and convert between each other, so you aren't forced into one paradigm or a second tool for the other.
- **Multiplatform.** Native installers for Windows, macOS (Intel and Apple Silicon) and Linux, from the same codebase.
- **Projects are one shareable file.** Sending an annotation task to a collaborator, or getting the results back, means sending one file rather than a folder of images plus a database or a running server.
- **Model assistance without a server.** Training and inference happen on the machine doing the annotating, which matters when the images can't leave it.
- **It's been used for real work.** Annotations made with it have gone into published research (the DNAi study<!-- TODO: add citation / DOI / link -->).
- **Built with feedback from people who annotate.** Clinicians and researchers across several medical fields have used it on real data throughout development, and the workflow reflects that.
- **Open to suggestions.** A young solo project with no fixed roadmap, so it's easy to influence what gets built next. See [Contributing](#contributing).

## Experimental / work in progress

These exist but are unfinished and lightly tested — use with low expectations:

- **SAM-based mask refinement.** An ONNX model path for cleaning up a coarse mask. Not polished, benchmarked or reliable yet.
- **Keypoint suggestion for registration.** An optional bridge to a Python process (over ZeroMQ) can propose keypoint correspondences instead of placing them all by hand. Rough and narrow in scope.
- **3D volume mode.** Treats a sequence as a voxel volume, with a 3D view and a curved projection you can paint directly. Usable enough to be interesting, not enough to rely on.

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

Requires `numpy` and `Pillow` (and `pyzmq` if you use the optional Python bridge described above).

## Installing

Prebuilt installers for **Windows, macOS (Intel and Apple Silicon), and Linux** are built automatically by GitHub Actions and attached to each release — download the one for your platform from the [Releases page](https://github.com/ClementPla/Didascalie/releases).

GPU training is optional. Without a GPU the head trains on the CPU, which is slower but works. To use an NVIDIA GPU you need the **CUDA Toolkit** installed, not just a driver: the training backend compiles its kernels at runtime with NVRTC, which ships with the toolkit. The app reports which device it selected, and falls back to the CPU if the GPU path isn't usable.

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

Building with GPU support needs the CUDA Toolkit; `cargo build --no-default-features` skips it.

## Built with

Angular 20 and PrimeNG (UI) · Tauri v2 / Rust (desktop shell and native processing) · SQLite via rusqlite (project files) · WebGPU (mask compositing, with a CPU fallback) · ONNX Runtime (encoder inference) · burn (training the segmentation head) · three.js (the experimental 3D view) · ZeroMQ (the experimental Python bridge).

## Contributing

It's a one-person project, so responses may be slow, but bug reports and suggestions are welcome — please open an issue. If you work with medical images and something is missing or awkward, I'd like to hear about it.

## License

BSD 3-Clause. See [`LICENSE`](LICENSE).
