# Installing

## Installers

Prebuilt installers are attached to every release. Download the one for your
platform from the [Releases page](https://github.com/ClementPla/Didascalie/releases).

=== "Windows"

    Download the `.msi` or `.exe` installer and run it. The build is not
    code-signed, so Windows may warn that the publisher is unrecognised.

=== "macOS"

    Download the `.dmg` for your architecture (Apple Silicon or Intel) and drag
    the app to Applications. The build is not notarised, so open it the first
    time with **right-click → Open**.

=== "Linux"

    Download the `.AppImage` and make it executable, or the `.deb` if you are on a
    Debian-derived distribution.

Didascalie checks for new releases on start-up and can update itself in place.

## Optional: GPU training

By default, the segmentation head is trained on the CPU. This is slower but needs
nothing installed.

To train on an NVIDIA GPU you need the **CUDA Toolkit** in addition to the driver.

!!! warning "A driver on its own is not enough"
    The training backend compiles its kernels at runtime through NVRTC, which
    ships with the CUDA Toolkit. With only a driver installed, Didascalie finds no
    NVRTC and falls back to the CPU. Training then runs slowly and no error is
    shown.

    The status line under the training panel reports which device was selected. If
    it reads `CPU (burn ndarray)` while you expected a GPU, see
    [Troubleshooting](troubleshooting.md#gpu-training-falls-back-to-the-cpu).

Encoder inference is separate. It uses ONNX Runtime, which can run on CUDA, on
DirectML (Windows) or on the CPU. Its CUDA path also needs **cuDNN 9**.

## Building from source

**Requirements:** [Node.js and npm](https://nodejs.org/),
[Rust](https://www.rust-lang.org/tools/install), and the
[Angular CLI](https://angular.dev/tools/cli).

```bash
git clone https://github.com/ClementPla/Didascalie.git
cd Didascalie
npm install
npm run tauri dev      # run in development
npm run tauri build    # build installers into src-tauri/target/release/
```

Building with GPU support requires the CUDA Toolkit. To build without it:

```bash
cargo build --no-default-features
```
