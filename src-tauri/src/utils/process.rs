//! Running the external programs the app ships with (ffmpeg, the
//! Bio-Formats reader).

use std::path::PathBuf;
use std::process::Command;

/// The program `name` (without its `.exe`): `env_var` if set, else the copy
/// shipped next to the application, else `fallback` if it exists, else
/// whatever `PATH` resolves.
pub fn find_program(env_var: &str, name: &str, fallback: Option<PathBuf>) -> PathBuf {
    if let Some(path) = std::env::var_os(env_var) {
        return PathBuf::from(path);
    }
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(&file)))
        .filter(|p| p.is_file())
        .or_else(|| fallback.filter(|p| p.is_file()))
        .unwrap_or_else(|| PathBuf::from(file))
}

/// Keep `command` from flashing a console window on Windows.
pub fn no_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The last non-empty line a program wrote to stderr: what went wrong.
pub fn last_error_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("unknown error")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_error_line_skips_trailing_blank_lines() {
        assert_eq!(last_error_line(b"warning\nerror: broken\n\n  \n"), "error: broken");
        assert_eq!(last_error_line(b""), "unknown error");
    }
}
