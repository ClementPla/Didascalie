# Experimental features

These exist in the application but are unfinished and lightly tested. They are
hidden until you enable experimental features in the settings menu.

Treat them as previews: they may change shape or be removed.

## 3D volume mode

Treats a sequence as a voxel volume rather than a stack of independent frames, with
a 3D view and a curved projection that can be painted directly — useful when a
structure runs across slices and is awkward to follow frame by frame.

The 3D view can be detached into its own window while staying part of the
application.

Interesting enough to try; not something to depend on.

## SAM-based mask refinement

An ONNX model path for turning a coarse mask into a cleaner one. Not benchmarked and
not reliable. The assisted-labelling tools in
[Assisted labelling](guide/assistance.md) are the supported route.

## Keypoint suggestion

An optional bridge to a Python process, over ZeroMQ, that can propose keypoint
correspondences for [registration](guide/registration.md) instead of placing them by
hand.

The bridge is general: a Python process announces which capabilities it provides when
it connects, and the application calls them during annotation. Keypoint
correspondence is the only one wired up so far.

The advantage of this arrangement is that your model stays in the environment it was
trained in. There is no export step to ONNX, which often fails on research
architectures.

## Superpixel selection

Snaps a mask to superpixel boundaries. Usable, but less predictable than the other
stroke-bounded operators.
