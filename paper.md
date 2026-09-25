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
(Tauri) and ships as a native installer for Windows, macOS and Linux. It is
designed to sit inside an existing machine-learning workflow rather than at the
end of one: the companion Python library `pydidascalie` reads and writes the
project format directly, and a socket protocol lets a running Python process both
drive the application and serve interactive predictions to it.

# Statement of need

Much biomedical image annotation cannot use the most convenient tooling. Web
platforms such as CVAT and Label Studio are capable and well maintained, but they
require a server and the transfer of images to it, which is often impossible for
clinical data under institutional governance or ethics constraints. Tools that
avoid the network make a different trade: ilastik [@berg2019ilastik] and LABKIT
[@arzt2022labkit] offer excellent interactive pixel classification but are
organised around their own pipelines; napari [@napari] expects the annotator to
maintain a Python environment; QuPath [@bankhead2017qupath] is specialised for
digital pathology; and 3D Slicer [@fedorov2012slicer] targets clinical image
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

Didascalie also provides an interactive registration mode, where keypoints placed
between a reference and a moving frame update an estimated homography live, with
overlay and checkerboard views for checking alignment; and an experimental volume
mode that treats a sequence as a voxel volume with a paintable curved projection.

# Implementation

Image decoding, mask encoding, database access and model training run in Rust,
keeping the interface responsive on large images where a browser or interpreted
layer would stall. Masks are run-length encoded per label and composited with
WebGPU, falling back to the CPU. Encoder inference uses ONNX Runtime and head
training the `burn` framework, each selecting a GPU backend at runtime where one
is usable. Correctness-critical logic — mask encoding, geometry, skeletonisation,
volume and dataset assembly — is covered by tests run in continuous integration.

# Interoperability with Python

An annotation tool that cannot round-trip with the ecosystem that consumes its
output is a dead end, so Didascalie exposes three paths into and out of a project.

Because a `.dida` file is an ordinary SQLite database, `pydidascalie` reads and
writes it without going through the application. Predictions from a researcher's
own model can be written into a project so that annotators open a draft and
correct it rather than starting from a blank image; finished annotations can be
iterated directly for training or analysis; and datasets can be converted to and
from COCO and YOLO layouts for other tooling.

Two ZeroMQ channels cover the interactive case. A control channel lets an
external process create a project, load images and step through frames, so
experiments can script the application rather than be clicked through. An
inference channel works in the other direction: a Python process advertises a set
of named capabilities and a protocol version on connection, and the application
calls out to it during annotation — currently to propose keypoint
correspondences for registration.

That second channel is the consequential design choice. The usual way to put a
model inside an annotation tool is to export it to ONNX and embed it, which taxes
every model with an export step that frequently does not survive contact with a
research architecture. A socket boundary instead leaves the model where it was
trained, in the researcher's own environment and dependencies, and asks only that
it answer a request.

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
