//! Choosing where the head trains and runs.
//!
//! burn picks its backend at compile time, so both are compiled in and
//! [`Selection::detect`] chooses at run time. There is no `is_available()`:
//! cubecl panics when CUDA is unusable, so the probe catches that panic, once.

use burn::backend::{Autodiff, NdArray};

pub type CpuTrain = Autodiff<NdArray>;
pub type CpuInfer = NdArray;

#[cfg(feature = "gpu")]
pub type GpuTrain = Autodiff<burn::backend::Cuda>;
#[cfg(feature = "gpu")]
pub type GpuInfer = burn::backend::Cuda;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Selection {
    Cpu,
    #[cfg(feature = "gpu")]
    Cuda,
}

impl Selection {
    /// The best backend this machine can run. `DIDA_FORCE_CPU=1` skips the CUDA
    /// probe, for a driver that aborts or hangs instead of panicking.
    pub fn detect() -> Self {
        if forced_cpu() {
            log::info!("[ml] DIDA_FORCE_CPU is set — skipping the CUDA probe");
            return Selection::Cpu;
        }
        #[cfg(feature = "gpu")]
        if cuda_works() {
            return Selection::Cuda;
        }
        Selection::Cpu
    }

    /// Shown in logs and in the UI.
    pub const fn label(self) -> &'static str {
        match self {
            Selection::Cpu => "CPU (burn ndarray)",
            #[cfg(feature = "gpu")]
            Selection::Cuda => "CUDA (GPU)",
        }
    }
}

fn forced_cpu() -> bool {
    std::env::var("DIDA_FORCE_CPU")
        .map(|v| v != "0" && !v.is_empty())
        .unwrap_or(false)
}

// The probe relies on catching a panic. Under `panic = "abort"` the process
// would die on any machine without a usable CUDA runtime: fail the build.
#[cfg(all(feature = "gpu", panic = "abort"))]
compile_error!(
    "`panic = \"abort\"` breaks the CUDA probe in this module: it relies on \
     `catch_unwind` to fall back to the CPU backend, and abort turns that \
     fallback into a hard crash on any machine without a usable CUDA runtime. \
     Remove `panic = \"abort\"` from the release profile in Cargo.toml."
);

/// The CUDA version this binary was built against, as `"major.minor"`. cudarc
/// fixes it at compile time and derives the NVRTC file names from it; see
/// `CUDARC_CUDA_VERSION` in `.github/workflows/main.yml`.
#[cfg(feature = "gpu")]
fn built_for_cuda() -> String {
    let v = cudarc::driver::sys::CUDA_VERSION;
    format!("{}.{}", v / 1000, (v % 1000) / 10)
}

/// Whether a CUDA context can be created and used. Probed once, with a real
/// kernel: burn is lazy, so allocating a tensor proves nothing.
#[cfg(feature = "gpu")]
pub fn cuda_works() -> bool {
    use burn::tensor::Tensor;
    use std::sync::OnceLock;

    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| {
        // Logged before the probe: a driver that aborts or hangs leaves no other trace.
        log::info!("[ml] probing for a usable CUDA device…");
        // A failed probe is expected on a CPU-only machine: no backtrace for it.
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let ok = std::panic::catch_unwind(|| {
            let device = Default::default();
            let t = Tensor::<GpuInfer, 1>::ones([8], &device);
            let sum: f32 = (t.clone() + t)
                .sum()
                .into_data()
                .iter::<f32>()
                .next()
                .unwrap_or(0.0);
            // 8 elements of 1.0, doubled.
            assert!((sum - 16.0).abs() < 1e-3, "cuda probe returned {sum}");
        })
        .is_ok();
        std::panic::set_hook(prev);
        if ok {
            log::info!("[ml] CUDA backend available — head will train on the GPU");
        } else {
            log::info!(
                "[ml] CUDA backend unavailable — falling back to CPU. \
                 This build targets CUDA {} and loads NVRTC by trying {:?}. \
                 NVRTC ships with the CUDA Toolkit, not the driver, so this is \
                 expected on a machine with no toolkit; if one *is* installed, \
                 check that its nvrtc DLL is named in that list and is on PATH.",
                built_for_cuda(),
                cudarc::get_lib_name_candidates("nvrtc"),
            );
        }
        ok
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_always_yields_a_usable_backend() {
        let s = Selection::detect();
        assert!(!s.label().is_empty());
    }

    #[test]
    #[cfg(feature = "gpu")]
    fn the_cuda_probe_is_stable() {
        assert_eq!(cuda_works(), cuda_works());
    }
}
