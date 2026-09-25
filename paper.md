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

Didascalie is a desktop application for annotating biomedical images. It is
intended for work where the images cannot be uploaded to a remote service. The
application installs as a single binary on Windows, macOS and Linux and requires no
server and no Python environment on the annotator's machine.

- **Annotation types.** Raster masks, vector polygons and lines, keypoints,
  multiclass and multilabel classification, and per-frame text notes. Raster and
  vector annotations share one image and one undo history.
- **Project files.** A `.dida` project is a SQLite database containing images
  (embedded or referenced), annotations, labels and metadata. Masks are run-length
  encoded per label.
- **Dataset-level workflow.** A filterable gallery reports annotation and review
  progress, and applies classification labels to a selection of images in one
  action.
- **Stroke-bounded operators.** Dynamic Otsu thresholding, flood fill with a
  tolerance, superpixel selection and connected-component erasure, with optional
  morphological opening and a connectivity constraint.
- **Display adjustments.** Brightness, contrast, gamma, tone curves and inversion.
  These can be applied to the pixels the operators read, not only to the rendered
  view.
- **Model assistance.** A small convolutional head is trained from scribbles over
  cached features from a frozen encoder, and saved in the project file.
- **Large images.** A resolution pyramid with native-resolution tiles fetched on
  demand. Gigapixel microscopy images can be annotated at full resolution.
- **Registration.** Keypoint correspondences between two frames, a homography
  estimated as points are placed, and overlay and checkerboard views for checking
  alignment.
- **Volume mode (experimental).** A sequence is treated as a voxel volume, with a
  3D view and a paintable curved projection.
- **Python interoperability.** A companion library reads and writes the project
  format and converts to and from COCO and YOLO. Two socket channels connect a
  running Python process to the application.

# Statement of need

Many biomedical annotation tasks cannot use web-hosted tools. CVAT and Label Studio
are capable and actively maintained, but both require a server and the transfer of
images to it, which institutional data-governance and ethics constraints often
prohibit. Tools that avoid that transfer carry other constraints. ilastik
[@berg2019ilastik] and LABKIT [@arzt2022labkit] provide interactive pixel
classification within their own analysis pipelines. napari [@napari] requires the
annotator to maintain a Python environment. QuPath [@bankhead2017qupath] is
specialised for digital pathology. 3D Slicer [@fedorov2012slicer] addresses
clinical image computing, and dataset labelling is not its focus.

Didascalie occupies a different position: a single installed binary in which raster
and vector annotation share one document, a project is one portable file, and model
training runs on the annotator's own hardware. The application has no server
component, so there is no upload path to audit. Encoders are its only network
dependency; they are optional, fetched once, and no image, annotation or usage data
is transmitted.

Assistance is organised in layers. The first requires no setup: a brush stroke acts
as the prompt, and each operator listed above is confined to the region that stroke
covers. Display adjustments can be routed into these operators, so an annotator can
raise contrast on a faint structure until it is visible and the operator then reads
the same pixels.

The second layer trains a model. Prompted segmentation models such as SAM
[@kirillov2023sam] have made interactive pre-labelling widely available, and MONAI
Label [@diazpinto2024monailabel] integrates such models into clinical workflows.
Both assume a GPU server or a substantial local inference stack. Didascalie instead
uses the finding that features from a frozen self-supervised transformer already act
as strong dense descriptors [@amir2021deepvit; @oquab2024dinov2;
@simeoni2025dinov3]. The encoder runs once per image and its output is cached; only
a small head is trained. Training takes seconds to minutes on a laptop and consumes
scribbles, so the head adapts to the structures and modality of the project at hand.
The approach follows ilastik's interactive machine learning, substituting
foundation-model features for a classical filter bank.

# Implementation

Image decoding, mask encoding, database access and model training are implemented in
Rust behind a web frontend, which keeps the interface responsive on images where a
browser or interpreted layer stalls. Masks are composited with WebGPU and fall back
to the CPU. Encoder inference uses ONNX Runtime and head training uses the `burn`
framework; each selects a GPU backend at runtime when one is usable. Mask encoding,
geometry, skeletonisation, volume assembly and dataset assembly are covered by tests
run in continuous integration.

Scale is handled by a resolution pyramid. Levels halve until the coarsest has a
longest side of 4096 px. The view draws the finest level that oversamples the
viewport and composites native-resolution tiles over it for the region under
inspection. Images too large for a browser to decode as a single bitmap therefore
remain editable at full resolution, and the annotator never handles tiles or crops.

Annotation output has to reach the tools that consume it. The project format is
plain SQLite, so `pydidascalie` reads and writes projects without the application
running, and a model's predictions can be written into a project for annotators to
correct. Two ZeroMQ channels handle the interactive case. One allows an external
process to create a project, load images and step through frames, so an experiment
can drive the application. The other is called by the application during annotation:
a Python process advertises named capabilities and a protocol version when it
connects, and currently supplies keypoint correspondences. This second direction
avoids exporting models to ONNX, which often fails on research architectures. The
model stays in the environment it was trained in and only answers requests.

# Availability and use

Didascalie is released under the BSD-3-Clause licence. Source and installers are
available at <https://github.com/ClementPla/Didascalie>. Annotations produced with
it have been used in published research [@TODO_dnai_study], and its workflow
reflects continuing feedback from clinicians and researchers working with real data
in several specialties.

# Acknowledgements

The author thanks the clinicians and researchers whose sustained feedback shaped the
annotation workflow. <!-- TODO: name collaborators / funding sources. -->
Portions of the implementation were written with AI coding assistance. The design,
domain requirements and evaluation are the author's own.

# References
