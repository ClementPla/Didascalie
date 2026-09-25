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

Didascalie is a desktop application for annotating biomedical images, built for
settings where the images cannot be uploaded anywhere. It installs as a single
binary on Windows, macOS and Linux and needs no server and no Python environment on
the annotator's machine.

- **Annotation types.** Raster masks, vector polygons and lines, keypoints,
  multiclass and multilabel classification, and per-frame text notes — raster and
  vector on one image, under a single undo history.
- **One file per project.** A `.dida` project is an ordinary SQLite database of
  images (embedded or referenced), annotations, labels and metadata; masks are
  run-length encoded per label.
- **Dataset-level workflow.** A filterable gallery tracks annotation and review
  progress, and applies classification labels to a whole selection at once.
- **Stroke-bounded operators.** Dynamic Otsu thresholding, flood fill with a
  tolerance, superpixel selection, connected-component erasure and CRF edge
  cleanup, with optional morphological opening and a connectivity constraint.
- **Adjustments that feed the algorithms.** Brightness, contrast, gamma, tone
  curves and inversion apply to what the operators see, not only the display.
- **On-device model assistance.** A small convolutional head trained from
  scribbles over cached frozen-encoder features, stored in the project file.
- **Very large images.** A resolution pyramid with native-resolution tiles fetched
  on demand, making gigapixel-scale microscopy annotatable.
- **Registration.** Keypoint correspondences with a live homography estimate, and
  overlay and checkerboard views for checking alignment.
- **Volume mode (experimental).** A sequence as a voxel volume, with a 3D view and
  a paintable curved projection.
- **Python interoperability.** A companion library reads and writes the format and
  converts to and from COCO and YOLO; two socket channels connect a running Python
  process.

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

Didascalie's gap is a single-binary application in which raster and vector
annotation live together, a project is one portable file, and model assistance —
training included — runs on the annotator's own hardware. That makes the privacy
property auditable rather than promised: there is no upload path to trust, because
there is no server component at all. Encoders are the only network dependency, they
are optional and fetched inbound once, and no image, annotation or usage
information is ever transmitted.

Assistance is layered so that setup cost is proportional to the help obtained, and
the first layer costs nothing: a rough brush stroke *is* the prompt, and each
operator above is confined to the region that stroke covers. Routing the display
adjustments into those operators matters more than it sounds — on a low-contrast
image the annotator tunes until a structure is visible, and the algorithm then sees
the same pixels they do.

The second layer is the substantive design choice. Prompted segmentation models
such as SAM [@kirillov2023sam] have made interactive pre-labelling widely
available, and frameworks such as MONAI Label [@diazpinto2024monailabel] integrate
them into clinical workflows; both generally assume a GPU server or a substantial
local inference stack. Didascalie instead exploits the observation that features
from a frozen self-supervised transformer are already strong dense descriptors
[@amir2021deepvit; @oquab2024dinov2; @simeoni2025dinov3]: the expensive encoder
runs once per image and is cached, and only a small head is trained. That head fits
in seconds to minutes on a laptop, from scribbles rather than complete masks, and
adapts to the structures and modality of the project at hand rather than relying on
a general-purpose model's notion of objects. It is the interactive machine-learning
idea established by ilastik, with foundation-model features in place of a classical
filter bank.

# Implementation

Image decoding, mask encoding, database access and model training run in Rust
behind a web frontend, which is what keeps the interface responsive where a browser
or interpreted layer would stall. Masks are composited with WebGPU, falling back to
the CPU; encoder inference uses ONNX Runtime and head training the `burn` framework,
each selecting a GPU backend at runtime where one is usable. Correctness-critical
logic — mask encoding, geometry, skeletonisation, volume and dataset assembly — is
covered by tests run in continuous integration.

The resolution pyramid is the load-bearing piece for scale. Levels halve to a
coarsest longest side of 4096 px, the view draws the finest level that oversamples
the viewport, and native-resolution tiles are composited over that overview for the
region under inspection. Images far past what a browser can decode as one bitmap
therefore stay annotatable at full resolution, with no tiling exposed to the user.

An annotation tool that cannot round-trip with the ecosystem consuming its output
is a dead end. Because the format is plain SQLite, `pydidascalie` reads and writes
projects without going through the application, so a researcher's own model can
write predictions in for annotators to correct rather than start from blank. Of the
two ZeroMQ channels, one lets an external process create a project, load images and
step through frames, so an experiment can script the application; the other is
called *by* the application during annotation, after a Python process advertises
named capabilities and a protocol version on connection — currently to propose
keypoint correspondences. That direction is deliberate: embedding a model normally
means exporting it to ONNX, a step that frequently does not survive contact with a
research architecture, whereas a socket boundary leaves the model in the
environment it was trained in and asks only that it answer a request.

# Availability and use

Didascalie is BSD-3-Clause licensed, with source and installers at
<https://github.com/ClementPla/Didascalie>. Annotations made with it have been used
in published research [@TODO_dnai_study], and its workflow has been shaped by
continuous feedback from clinicians and researchers annotating real data across
several specialties.

# Acknowledgements

The author thanks the clinicians and researchers whose sustained feedback shaped
the annotation workflow. <!-- TODO: name collaborators / funding sources. -->
Portions of the implementation were written with AI coding assistance; the design,
domain requirements and evaluation are the author's own.

# References
