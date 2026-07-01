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
- **Keypoints**, **vector shapes** (polygons/lines), and short **text notes** per region.
- **Multi-frame projects.** Images can be grouped into sequences and navigated frame by frame (this is just navigation — there is no automatic propagation of annotations between frames).
- **One file per project.** A project is a single `.dida` file (SQLite underneath) holding the images (embedded or referenced), masks, labels, and metadata. Easy to copy, back up, or hand to someone else.

## Why you might use it

There are several good open-source annotation tools already, so here are a few honest reasons this one might suit you:

- **Native, Rust-backed processing.** The heavy work — encoding masks, image operations, file I/O — runs in a compiled Rust backend rather than in a browser tab or a Python layer. It stays responsive on large medical images, keeps a small footprint, and needs no server or Docker setup.
- **Projects are one shareable file.** Since a whole project is a single `.dida` file, handing an annotation task to a collaborator — or getting the results back — is just sending one file, not a folder of images plus a separate database or a running server.
- **It's been used for real work.** Annotations produced with it have gone into published research (for example, the DNAi study<!-- TODO: add citation / DOI / link -->), not just demos.
- **Shaped by people who actually annotate.** It has been developed with continuous feedback from clinicians and researchers across several medical fields who use it on real data, so the workflow reflects how experts actually work rather than my own assumptions.

## Experimental / work in progress

These exist in the codebase but are not finished or well tested — use with low expectations:

- **SAM-based mask refinement.** There is an ONNX-based model path for turning a coarse mask into a cleaner one, but it is not polished, benchmarked, or reliable yet.
- **Frame-to-frame registration** with a keypoint-assist step, including an optional bridge to a Python process (over ZeroMQ) that can suggest keypoints. Rough and narrow in scope for now.

## The `.dida` format and the Python library

A `.dida` file is an ordinary SQLite database, so it's inspectable and scriptable. A small companion library, [`didascalie`](https://github.com/ClementPla/Didascalie), can:

- create and read projects,
- import a folder of images,
- import precomputed masks, and
- convert to/from COCO and YOLO.

The library is **not published on PyPI** — install it from source if you want it. It requires `numpy` and `Pillow` (and `pyzmq` for the optional Python bridge).

```python
from didascalie import DidascalieProject, Label

with DidascalieProject.create("dataset.dida", name="My Dataset") as project:
    project.add_label(Label(name="lesion", color="#FF0000"))
    project.import_folder("/path/to/images")
```

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
