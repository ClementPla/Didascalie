# Troubleshooting

## GPU training falls back to the CPU

The status line under the training panel reports the device. If it reads
`CPU (burn ndarray)` on a machine with an NVIDIA GPU, the **CUDA Toolkit** is
probably missing. The backend compiles kernels at runtime through NVRTC, which
the driver does not include.

The log records which CUDA version the build targets and what it searched for.
It is at:

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

Look for a line beginning `[ml] CUDA backend`.

To check whether the fallback explains what you are seeing, set
`DIDA_FORCE_CPU=1` and start again. If the run behaves the same, the GPU was
already unused and the fallback is the cause.

## The encoder runs on the CPU

This is independent of training. Encoder inference uses ONNX Runtime, whose CUDA
provider needs **cuDNN 9** as well as the CUDA runtime. When the provider fails to
load, the log names the missing library.

On Windows, NVIDIA installs cuDNN into a CUDA-versioned subdirectory:
`...\NVIDIA\CUDNN\v9.x\bin\12.6\`, and not `...\bin\`. `PATH` must contain the
versioned directory. With only the parent directory, the DLL is not found.

On Windows, DirectML is tried next and needs nothing extra, but it cannot run
every model. When it fails, the session reopens on the CPU and the log says so.

## A large image is slow to pan or zoom

Very large images are drawn from a resolution pyramid, with native-resolution
tiles loaded for the region you are looking at. Just after opening a frame, the
image can look soft until the tiles arrive.

If it stays slow, the cause is usually the platform's web view. The same file
performs differently on Windows, macOS and Linux. Turn on the performance overlay
(top toolbar) to see whether the frame rate is low, which points to rendering, or
normal, which points to loading.

## Annotations from a previous project appear in a new one

This was a bug, fixed in 0.8.0: project state is now cleared when a project
closes. If you see it on a current version, please report it and describe what you
did between opening the two projects.

## Reporting something

Open an issue at
[github.com/ClementPla/Didascalie/issues](https://github.com/ClementPla/Didascalie/issues)
and attach the log file mentioned above.
