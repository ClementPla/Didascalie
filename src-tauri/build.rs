fn main() {
    // The application manifest asks Windows for common controls 6, without
    // which `TaskDialogIndirect` (native dialogs) is missing. tauri-build
    // embeds it in the app only, so the test binary failed to start with
    // STATUS_ENTRYPOINT_NOT_FOUND. The linker embeds the same request in every
    // binary instead, tests included.
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");

    // The target triple, by which a debug build finds the microscopy reader
    // that `npm run fetch-reader` downloads (see `microscopy::reader_path`).
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=DIDASCALIE_TARGET={target}");
    }

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
             name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
             processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}
