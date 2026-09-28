# Auto-update

The desktop app updates itself from its GitHub releases using the Tauri updater
plugin. On the launcher (first screen) it checks the release channel once; if a
newer version is published it offers **Update & restart**.

## How it works

- CI (`.github/workflows/main.yml`) builds on push to `release` via
  `tauri-apps/tauri-action`. When the signing secrets are present it also
  **signs the installers** and uploads a `latest.json` update manifest to the
  release.
- The app fetches `latest.json` from
  `https://github.com/ClementPla/Didascalie/releases/latest/download/latest.json`
  (configured in `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`),
  compares versions, verifies the signature against the embedded public key, and
  downloads + installs the platform installer.

Because `/releases/latest/` points at the newest **published, non-prerelease**
release, the auto-created draft release must be **published** for clients to see
the update.

## One-time setup (required)

The updater only works once a signing keypair exists. This is a manual step —
the private key must never be committed.

1. Generate a keypair (from the repo root):

   ```bash
   npm run tauri signer generate -- -w ~/.tauri/didascalie.key
   ```

   This prints a **public key** and writes the **private key** to the file
   (with the password you choose).

2. Paste the **public key** into `src-tauri/tauri.conf.json`:

   ```json
   "plugins": { "updater": { "pubkey": "<PUBLIC KEY>" } }
   ```

3. Add two **repository secrets** (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — the contents of `~/.tauri/didascalie.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password from step 1

After that, every push to `release` produces signed installers + `latest.json`;
publish the draft release and clients will be offered the update.

> Local `tauri build` also needs those two values in the environment because
> `bundle.createUpdaterArtifacts` is enabled. `npm run tauri dev` and the web
> build don't bundle, so they're unaffected.
