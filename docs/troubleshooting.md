# Troubleshooting

## GPU training falls back to the CPU

The status line under the training panel reports the device. If it reads
`CPU (burn ndarray)` on a machine with an NVIDIA GPU, the usual cause is a missing
**CUDA Toolkit**: the backend compiles kernels at runtime through NVRTC, which the
driver alone does not provide.

The log records which CUDA version the build targets and what it searched for.
Find it at:

=== "Windows"

    ```
    %LOCALAPPDATA%\io.github.clementpla.didascalie\logs\Didascalie.log
    ```

=== "macOS"

    ```
    ~/Library/Logs/io.github.clementpla.didascalie/Didascalie.log
    ```

=== "Linux"

    ```
    ~/.local/share/io.github.clementpla.didascalie/logs/Didascalie.log
    ```

Look for a line beginning `[ml] CUDA backend`. To confirm the fallback is the cause
rather than a symptom, set `DIDA_FORCE_CPU=1` and start again: if the run behaves
identically, the GPU path was never the problem.

## The encoder runs on the CPU

A separate question from training. Encoder inference uses ONNX Runtime, and its CUDA
provider needs **cuDNN 9** in addition to the CUDA runtime. The log says so
explicitly when the provider fails to load, naming the missing library.

On Windows, note that NVIDIA installs cuDNN into a CUDA-versioned subdirectory —
`...\NVIDIA\CUDNN\v9.x\bin\12.6\`, not `...\bin\`. Putting the parent directory on
`PATH` is a common mistake and leaves the DLL unfindable.

DirectML is tried next on Windows and needs nothing extra, but it cannot execute
every graph; when it fails the session reopens on the CPU and says so.

## A large image is slow to pan or zoom

Very large images are drawn from a resolution pyramid with native-resolution tiles
loaded for the region you are looking at. The first moments after opening a frame can
be soft while tiles arrive.

If it stays slow, the cause is usually the platform's web view rather than the image:
performance differs markedly between Windows, macOS and Linux for the same file. The
FPS overlay (in the settings menu) distinguishes a rendering problem from a loading
one.

## Annotations from a previous project appear in a new one

This was a real bug, fixed in 0.8.0. Project-scoped state is now cleared when a
project closes. If you see it on a current version, it is a new bug worth reporting —
please include what you did between opening the two projects.

## Reporting something

Open an issue at
[github.com/ClementPla/Didascalie/issues](https://github.com/ClementPla/Didascalie/issues).
The log file named above is the single most useful thing to attach.
