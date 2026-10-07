# Development notes

!!! note "Not a developer guide yet"
    This section contains internal notes. A contributor guide (architecture,
    storage schema, how to add a format or an encoder) is planned but not written.

## Working on these docs

One-time setup, then a live-reloading server:

```bash
pip install -r docs/requirements.txt
npm run docs:serve      # or: mkdocs serve
```

It serves on <http://127.0.0.1:8000/>, watches `docs/` and `mkdocs.yml`, rebuilds on
save and reloads the browser. Changing `mkdocs.yml` itself also triggers a rebuild.

```bash
npm run docs:build      # mkdocs build --strict, as Read the Docs runs it
```

`--strict` turns warnings into errors. A broken internal link or a page missing
from the navigation then fails the build.

## Building the application

See [Building from source](../install.md#building-from-source).

## Running the checks

```bash
npm run build                # frontend production build (type + template check)
npm run lint                 # eslint
npm test                     # frontend unit tests
```

`npm test` needs a browser for Karma. If it cannot find one, point `CHROME_BIN` at
an installed Chrome or Chromium.

```bash
cd src-tauri
cargo test --lib             # backend tests
cargo clippy --all-targets   # lints
cargo fmt --check            # formatting
```

Continuous integration runs the frontend build, lint and tests, and the backend tests
and clippy, on every push and pull request.

## API documentation

Two generators, neither part of this site yet:

- `npm run compodoc:build` documents the Angular frontend.
- `cargo doc --open` documents the Rust backend.

## Notes kept for reference

- [Auto-update](auto-update.md): how the Tauri updater is set up, and the signing
  keypair it needs.
- Literature review on few-shot scribble segmentation: background for the
  assisted-labelling design. Served at
  `development/literature-review-fewshot-scribble/` but left out of the navigation
  because of its length.
