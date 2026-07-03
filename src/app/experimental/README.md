# Experimental features

Everything in this folder is hidden behind the **Experimental features**
switch (wrench button in the app toolbar, persisted in `localStorage`).
Core code never imports a feature's services or components directly — it only
talks to [`feature-flags.service.ts`](feature-flags.service.ts) and the
generic helpers in [`registry.ts`](registry.ts).

## Layout

```
experimental/
├── descriptor.ts            # ExperimentalFeatureDescriptor contract + flag ids
├── registry.ts              # EXPERIMENTAL_FEATURES list + lookup helpers
├── feature-flags.service.ts # master switch (signal, persisted)
├── experimental.directive.ts# *experimental structural directive
├── experimental-settings/   # toolbar button + popover with the switch
└── <feature>/               # one self-contained folder per feature
    ├── <feature>.feature.ts # the descriptor: the feature's only public API
    ├── <feature>.service.ts # logic/state (providedIn: 'root')
    └── ...components        # settings panes, etc.
```

## Adding a new experimental feature

1. Create a folder `experimental/<name>/` with a service holding the
   feature's logic and state (do **not** add state to `EditorService` or
   other core services).
2. Add the flag id to the `ExperimentalFeature` union in `descriptor.ts`.
3. Export an `ExperimentalFeatureDescriptor` from
   `<name>/<name>.feature.ts` wiring the feature in:
   - `postProcess` — modes added to the Processing panel (option enum value,
     helper text, optional settings component, `run` handler);
   - `onImageLoaded` — invalidate per-image caches;
   - `getOverlay` — an image-native canvas to composite over the image;
   - `onDisabled` — hide any visible state when the switch turns off.
4. Register it in `EXPERIMENTAL_FEATURES` in `registry.ts` (one line).

For experimental UI that lives inside otherwise-stable templates, wrap it
with the structural directive instead of an `@if`:

```html
<button *experimental="'myfeature'">…</button>
```

Handlers receive an `Injector` and resolve the feature's services through it,
so nothing outside this folder gains an import on feature internals.
Rust-side commands (e.g. `crf_refine`, `superpixel_refine`) stay registered
unconditionally in `src-tauri`; they are simply unreachable while the
feature's UI is hidden.
