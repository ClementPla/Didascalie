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
