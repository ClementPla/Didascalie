---
title: 'Didascalie: local-first annotation of biomedical images with on-device model assistance'
tags:
  - image annotation
  - medical imaging
  - segmentation
  - interactive machine learning
  - Rust
  - desktop application
authors:
  - name: Clément Playout
    orcid: 0000-0000-0000-0000   # TODO: your ORCID
    affiliation: 1
affiliations:
  - name: TODO — affiliation   # e.g. Polytechnique Montréal / CIUSSS de l'Est-de-l'Île-de-Montréal, Canada
    index: 1
date: 25 September 2026
bibliography: paper.bib
---

# Summary

Didascalie is a desktop application for annotating biomedical images. It supports
pixel-level segmentation masks, vector shapes, keypoints, multiclass and
multilabel classification, and short per-frame text notes, with raster and vector
annotation coexisting on the same image rather than being split across separate
tools. A project is a single file — a SQLite database with the `.dida` extension
— holding images (embedded or referenced), annotations, labels and metadata, so
handing a task to a collaborator or archiving a finished dataset is a one-file
operation.

Beyond manual drawing, Didascalie can fit a segmentation model *on the
annotator's own machine* from a handful of scribbles. Dense patch features are
extracted once per image with a frozen self-supervised vision encoder
[@oquab2024dinov2; @simeoni2025dinov3], cached, and used to train a small
convolutional head, which is then stored inside the project file and applied to
unseen frames. No data leaves the machine: encoders are the only network
dependency, they are optional and downloaded inbound once, and no image,
annotation or usage information is ever transmitted.

The application is built as a Rust backend behind a web frontend
(Tauri), ships as a native installer for Windows, macOS and Linux, and is
accompanied by a Python library, `pydidascalie`, that reads and writes the same
project format for scripted import, export and model-assisted pre-population.

# Statement of need

Much biomedical image annotation cannot use the most convenient tooling. Web
platforms such as CVAT and Label Studio are capable and well maintained, but they
require a server and the transfer of images to it, which is often impossible for
clinical data under institutional governance or ethics constraints. Tools that
avoid the network typically make a different trade: ilastik [@berg2019ilastik] and
LABKIT [@arzt2022labkit] offer excellent interactive pixel classification but are
organised around their own analysis pipelines; napari [@napari] is a
Python-first viewer that expects the annotator to maintain a Python environment;
QuPath [@bankhead2017qupath] is specialised for digital pathology; 3D Slicer
[@fedorov2012slicer] is a large volumetric platform aimed at clinical image
computing rather than dataset labelling.

The gap Didascalie addresses is a single-binary desktop application that needs no
server and no Python environment on the annotator's machine, in which raster and
vector annotation live together, a project is one portable file, and model
assistance — training included — runs entirely on the annotator's own hardware.
This makes the privacy property auditable rather than promised: there is no
upload path to trust, because there is no server component at all.

The assistance mechanism is the substantive design choice. Prompted
segmentation models such as SAM [@kirillov2023sam] have made interactive
pre-labelling widely available, and frameworks such as MONAI Label
[@diazpinto2024monailabel] integrate them into clinical annotation workflows;
both, however, generally assume either a GPU server or a substantial local
inference stack. Didascalie instead exploits the observation that features from a
frozen self-supervised transformer are already strong dense descriptors
[@amir2021deepvit]: the expensive encoder runs once per image, and only a small
head is trained. That head fits in seconds to minutes on a laptop, from
scribbles rather than complete masks, and adapts to the specific structures and
modality of the project at hand instead of relying on a general-purpose model's
notion of objects. It is the interactive-machine-learning idea established by
ilastik, with foundation-model features in place of a classical filter bank.

Didascalie further includes an interactive frame-registration mode, in which
corresponding keypoints are placed between a reference and a moving frame and the
estimated homography updates live, with overlay and checkerboard views for
verifying alignment; and an experimental volume mode that treats a sequence as a
voxel volume with a 3D view and a curved projection that can be painted directly.

# Implementation

Image decoding, mask encoding, database access and model training run in Rust,
keeping the interface responsive on large images where a browser or interpreted
layer would stall. Masks are stored run-length encoded per label. Mask
compositing uses WebGPU with a CPU fallback. Encoder inference uses ONNX Runtime;
head training uses the `burn` framework, with a CUDA backend selected at runtime
and a CPU fallback. Correctness-critical logic — mask encoding, geometry,
skeletonisation, volume assembly, dataset assembly — is covered by an automated
test suite run in continuous integration on every change.

# Availability and use

Didascalie is released under the BSD-3-Clause licence, with source and installers
for Windows, macOS and Linux at
<https://github.com/ClementPla/Didascalie>. Annotations produced with it have
been used in published research [@TODO_dnai_study]. Its workflow has been shaped
by continuous feedback from clinicians and researchers annotating real data
across several medical specialties.

# Acknowledgements

The author thanks the clinicians and researchers whose sustained feedback shaped
the annotation workflow. <!-- TODO: name collaborators / funding sources. -->
Portions of the implementation were written with AI coding assistance; the
design, domain requirements and evaluation are the author's own.

# References
