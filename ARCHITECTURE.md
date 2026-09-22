# Architecture

A map of how Didascalie fits together, for anyone (including future me) opening
the codebase cold. It documents the non-obvious design decisions — the things
you can't infer by reading one file.

## Stack & processes

Didascalie is a [Tauri v2](https://v2.tauri.app/) desktop app: an **Angular 20**
frontend (the WebView) talking to a **Rust** backend over Tauri's IPC.

```
┌───────────────────────────── Tauri window ─────────────────────────────┐
│  WebView (Angular 20 + PrimeNG + Tailwind)                              │
│    UI, all interactive editing, the canvas/WebGPU compositor           │
│                    │  invoke('command', args)  ▲  Response             │
│                    ▼                           │                        │
│  Rust core (rusqlite, image, imageproc)                                │
│    persistence (.dida SQLite), decode/encode, geometry, heavy CPU work │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Frontend** (`src/app`) owns all interaction and rendering. Masks are edited
  in-memory as typed arrays and composited on-device (WebGPU, CPU fallback), so
  drawing never round-trips to Rust.
- **Backend** (`src-tauri/src`) owns the file (`.dida`), image decode/encode,
  and CPU-heavy algorithms (contours, skeleton, superpixel, CRF, tiling). It is
  **stateless per call** except for a few caches (decoded-frame, thumbnails).
- **The boundary** is `src/app/lib/api.ts` (one typed wrapper per Tauri command)
  ↔ `src-tauri/src/lib.rs` `invoke_handler![…]` (~60 commands, grouped by module
  under `src-tauri/src/commands/`). If you add a command, it goes in both places.

Large binary payloads (masks, image tiles) cross as `ArrayBuffer` /
`tauri::ipc::Response`, **not** base64, to avoid multi-hundred-MB copies.

## The `.dida` project file

A project is a single SQLite file (`.dida`; `.labelmed` from the old name still
opens). Schema in `src-tauri/src/storage/schema.rs`, versioned by
`PRAGMA user_version` (`SCHEMA_VERSION`, currently **3**) with forward-compat
guard: a newer file refuses to open in an older build; an older file is migrated
on open. Core tables:

| Table | Holds |
|---|---|
| `project` | single-row JSON config (labels/tasks definitions) |
| `labels` | segmentation labels (name, color, `is_instance`, order) |
| `sequences` / `frames` | images grouped into sequences; pixels embedded (`embedded_data` BLOB) or referenced (`relative_path` + `content_hash`) |
| `annotations` | **raster** masks, one row per (frame, label), `encoding` + `mask_data` BLOB |
| `vector_annotations` | **vector** shapes, one row per (frame, label), `shapes` JSON |
| `classifications` | per (frame, task) selected classes; multiclass/multilabel |
| `text_descriptions` | per (frame, text-task) free text |
| `registrations` / `keypoint_pairs` | homography + keypoint correspondences per (ref, moving) frame pair |

## Two annotation data models (important)

Segmentation lives in **two parallel representations** that the editor keeps
side by side and can convert between:

### 1. Raster — one `Uint8Array` per label
The source of truth for painted masks. Each label is a `width*height`
`Uint8Array`: `0` = absent, `1` = present (semantic), `1..255` = instance id
(instance labels). **Colour is not stored in the pixels** — it's applied at
composite time from a per-label palette. This cuts memory ~4× vs the old
RGBA-canvas-per-label model and makes recolour/opacity/visibility free.

- Pixel ops are plain typed-array loops in `src/app/Core/misc/label-ops.ts`
  (commit stroke, swap-under-stroke, erase component, downsampled bbox scan) —
  synchronous, no IPC.
- Persistence: value-aware run-length encoding (`rle8`) in
  `src-tauri/src/storage/rle.rs`. Old encodings (`rle`, `png`) still decode; every
  save rewrites as `rle8` (lazy upgrade).
- Compositing: `web-gpucanvas-compositor.service.ts` (WebGPU, uploads layers as an
  `r8uint` texture array + palette) with a CPU fallback in `canvas-manager.service.ts`.

### 2. Vector — `VectorShape[]` per label
Bezier paths / polygons / polylines, edited with the Select/Path/Node tools.
A `VectorShape` is `{ id, labelId, closed, filled, nodes: VectorNode[] }`; a node
carries its anchor + two bezier handles. Pure geometry (flatten, hit-test,
bounds, path `d` string, split, translate) lives in
`src/app/Components/pages/editor/drawable-canvas/vector/vector.model.ts`. Stored
verbatim as JSON in `vector_annotations`.

### Converting between them (`convert.service.ts`)
- **Rasterize**: burn vector shapes into the label mask, delete the shapes.
- **Vectorize**: trace a clicked component's outer contour into a closed shape.
- **Skeletonize**: thin a clicked component to its 1px centerline and split it at
  junctions into open paths.

The last two call Rust (`vectorize_component`, `skeletonize_component` →
`commands/formats/geometry.rs`); all are single compound undo steps.

### Propagating labels across a sequence
Copying one frame's labels onto the rest of its sequence runs **entirely in
SQLite** (`src-tauri/src/commands/propagation.rs`), not through the editor. Both
stored forms are already cheap to copy — a raster mask is a compressed `rle8`
BLOB, a vector row is opaque JSON — so propagation is a row copy with no decode
and no mask crossing IPC. Doing it frame-by-frame in the frontend would mean
shipping a ~136 MB mask per label per frame.

Three rules keep raster and vector behaving as one thing:

- **Both tables move together, in one transaction.** A frame's segmentation
  state is (raster rows ∪ vector rows), and the editor converts between them.
- **Replace deletes what the source lacks.** No source row for a label in scope
  ⇒ the target's row is removed, or the copy would leak stale labels.
- **Mismatched frame sizes are skipped**, not written: masks are flat
  `width*height` arrays and vector nodes are image-pixel coords.

The frontend side (`Services/Labels/propagation.service.ts`) flushes pending
edits first — the backend copies what's *in the database* — resolves targets from
`SequenceService`, and emits `propagated$` so views over frames that aren't
displayed (navigator status dots, gallery) refresh. There is deliberately **no
undo**: the editor timeline is per-frame and in-memory, so the dialog states the
affected frame count instead.

## The editor (the complexity hotspot)

`src/app/Components/pages/editor/drawable-canvas` is where most of the code and
subtlety is. It's decomposed into single-responsibility services:

| Service | Responsibility |
|---|---|
| `canvas-manager.service` | owns the label `Uint8Array`s + stroke buffer; CPU composite; bbox scan |
| `web-gpucanvas-compositor.service` | GPU composite of uint8 layers + palettes; edge (Sobel) pass |
| `orchestrator.service` | ties image + masks + view together; drives redraws; display pyramid |
| `zoom-pan.service` | view transform; image↔viewport↔screen coordinate conversions |
| `draw.service` + `tools/*` | brush/line/lasso stroke pipeline (rasterized on a bounded buffer) |
| `vector-editor.service` | vector shapes + Select/Path/Node tool state machines + vector undo |
| `convert.service` | rasterize / vectorize / skeletonize bridges |
| `post-process.service` | Otsu / flood-fill / SAM / CRF / superpixel (call Rust, write result into active mask) |
| `undo-redo.service` | unified raster+vector timeline (per-layer snapshot stacks + compound groups) |
| `image-adjustment/*` | on-the-fly brightness/gamma/invert (view-only LUT) |
| `tiled-image.service` | native-resolution tiles fetched on zoom for very large images |
| `state-manager` / `bbox-manager` | shared editor flags; bbox overlay data |

State style: **signals** for reactive state, **RxJS Subjects** for event streams
(e.g. `changed$`, `committed$`, `loaded$`). Services are `providedIn: 'root'`
singletons; the one-way dependency rule that avoids DI cycles is *editors emit
events, `io.service` subscribes* (never the reverse).

### Save is dirty-tracked
`io.service.save()` only re-sends **raster** masks whose label is in `dirtyLabels`
(populated by `markLabelDirty`), because a full mask is ~136 MB at 8k×17k.
Pure-vector edits go through `markDirty()` only, so they never re-ship a raster
mask. See [the save note in `io.service.ts`](src/app/Services/io.service.ts).

### Large images
Anything with a side > 4096 px (WebKit's canvas cap) uses: a server-side
downsampled **overview** as the backdrop (`get_frame_overview`), a display
**pyramid** built from the decoded `<img>` (`pyramid.service`), **viewport-sized
CPU compositing** of the masks, native **tiles** fetched on zoom
(`tiled-image.service` ↔ `get_frame_tile`), and a **bounded stroke buffer**.
Normal-sized images keep the simpler full-resolution path unchanged.

### 3D mode: the sequence as a volume (experimental)
With 3D mode on, `services/mask-volume.service.ts` keeps the open sequence
resident as one `W×H×D` `Uint8Array` per label (Z = frame index, slowest axis),
filled by two bulk commands (`commands/volume.rs`: `load_label_volume`,
`load_sequence_image_volume`). The 2D editor does not copy slices in and out:
`io.service.load()` *binds* the canvas manager's label layers to `subarray`
views of the current slice (`CanvasManagerService.bindMasks`), so tools,
compositor and undo write straight into the volume and changing frame skips the
annotation IPC. Saving is untouched — the frame is still saved before every
navigation, and its masks are the slice views.

The invariant that keeps this safe: **a borrowed slice is never cleared or
loaded into.** Anything about to overwrite the layers with another frame's data
calls `detachMasks()` first (owned copies). Writes that bypass the editor
(propagation, clearing the sequence) call `MaskVolumeService.reload()`.

The views live in `experimental/volume3d/` and plug into the editor through two
descriptor hooks (`editorPanes`, `canvasOverlays`), so core code never imports
them. Both follow edits through `MaskVolumeService.edited$`:

- **3D view** (three.js, WebGL2). Label surfaces are meshed in a worker
  (`mesher/`) in 32³ bricks: surface nets over a lightly blurred occupancy for
  the smooth surface, greedy-meshed faces for the exact voxels. An edit sends
  only the changed slices; the worker diffs them to find what changed and
  remeshes just the bricks around it (tens of ms). Image planes and the
  ray-marched volume rendering sample the image volume as a 3D texture.
- **Projection view.** Two curves drawn on the slice (splines through the
  clicked points) are resampled by normalised arc length; a fragment shader
  reduces the image (max/mean/min) along the segment joining corresponding
  points, one output row per slice. Labels are bit-packed into an integer 2D
  array texture so an edit re-uploads only its slice.

  Painting on the projection writes back at a chosen depth `t` along each
  segment (`projection-painter.service.ts`): one brush dab is a ball around
  that point, possibly spanning many slices. Slices other than the open one
  are marked dirty in the volume and persisted by `io.save()` (via
  `MaskVolumeService.saveDirty()`). A stroke joins the editor's undo timeline
  as an **external action** (`UndoRedoService.pushExternal`): it undoes itself
  from a sparse before/after diff, survives frame changes (the per-frame
  history is otherwise reset on load), and rebases the open frame's layer
  history so a later 2D undo doesn't silently drop it.

The two views live in a resizable panel beside the canvas and can each be
**maximized** over the editor area or **detached** into their own OS window
(`volume-layout.service.ts`, `volume-panel.component.ts`). Detaching does not
start a second app: `shared/detached-window` opens a blank popup and moves the
view's DOM into it, so it keeps running in the main window's JavaScript
context (volume, WebGL, workers untouched). This is why the main window is
created in Rust (`create_main_window` in `lib.rs`, `create: false` in
`tauri.conf.json`): its `on_new_window` handler answers `window.open` with an
opener-linked webview. Code in a detachable view must use its own window's
frame clock and ResizeObserver (`ownerWindow`), not the globals.

## Import / export (pluggable formats)

Anything that isn't `.dida` goes through a canonical intermediate representation
and a format registry, all in `src-tauri/src/commands/formats/`:

- `storage.rs` adapts `.dida` ↔ the IR (a dataset of images + typed annotations).
- `mod.rs` defines the `ExportFormat` / `ImportFormat` traits + an option schema.
- `coco.rs`, `yolo.rs`, `masks.rs` implement those traits (round-trip).
- `geometry.rs` derives polygons/boxes/skeletons the object formats need.

Add a format by implementing the traits and registering it — the generic
import/export UI (`Components/pages/export`, launcher import dialog) is
schema-driven and needs no per-format UI code.

## Experimental features

Unstable work (CRF, superpixel, SAM/MedSAM) is gated behind a feature-flag
registry in `src/app/experimental/` (`feature-flags.service`, `registry.ts`,
per-feature folders). These are hidden unless the experimental switch is on — the
line between "stable, daily-usable" and "not yet" is deliberate.

## Release & update

Pushing to the `release` branch triggers the GitHub Actions `publish` workflow
(`.github/workflows/main.yml`): a signed, 4-platform Tauri build published as a
GitHub release. Installed apps auto-update via the Tauri updater plugin
(`src/app/Services/update.service.ts`, launcher banner + toolbar version badge).
`ci.yml` is the quality gate (frontend build + `cargo test`/`clippy`/`fmt`).

## Where to start reading

1. `src/app/lib/api.ts` — the whole backend surface at a glance.
2. `src-tauri/src/storage/schema.rs` — the data model.
3. `src/app/Core/misc/label-ops.ts` — the raster model in ~200 readable lines.
4. `…/drawable-canvas/vector/vector.model.ts` — the vector model.
5. `…/drawable-canvas/service/orchestrator.service.ts` — how a frame is drawn.
