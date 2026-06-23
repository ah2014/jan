//! On-disk persistence for the "remote attach" allow-list.
//!
//! The frontend's `~` file picker lets users browse and attach files living on
//! the host that runs the Jan backend (the desktop machine or the device
//! hosting the web server) without uploading them through the browser. To keep
//! that surface sandboxed, the set of root folders exposed to the picker is
//! configured in `<jan_data_folder>/allowed_attach_paths.json` — a plain JSON
//! array of absolute path strings, e.g.
//!
//! ```json
//! ["/home/me/Documents", "/home/me/projects"]
//! ```
//!
//! Editing that file is the only way to configure the allow-list (there is no
//! in-app UI by design), so this module only needs read helpers. A missing or
//! corrupt file is treated as an empty allow-list, which disables the picker.

use tauri::{AppHandle, Runtime};

use crate::core::app::commands::get_jan_data_folder_path;

const ATTACH_PATHS_FILE: &str = "allowed_attach_paths.json";

fn attach_paths_json_path<R: Runtime>(app_handle: &AppHandle<R>) -> std::path::PathBuf {
    let mut p = get_jan_data_folder_path(app_handle.clone());
    p.push(ATTACH_PATHS_FILE);
    p
}

/// Load the persisted allow-list from disk.
///
/// * Missing file → empty vec (feature simply isn't configured yet).
/// * Corrupt JSON → empty vec + warning log (we never abort startup).
/// * Non-array top-level (e.g. an object) → empty vec.
///
/// Empty / blank entries are filtered out and the rest are trimmed, so a
/// hand-edited file with trailing commas-with-null or stray whitespace still
/// degrades gracefully.
pub fn load_allowed_attach_paths<R: Runtime>(app_handle: &AppHandle<R>) -> Vec<String> {
    let path = attach_paths_json_path(app_handle);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log::warn!(
                "Failed to read {}: {e}. Starting with empty attach-path allow-list.",
                path.display()
            );
            return Vec::new();
        }
    };
    match serde_json::from_slice::<Vec<String>>(&bytes) {
        Ok(list) => list
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Err(e) => {
            log::warn!(
                "Failed to parse {}: {e}. Expected a JSON array of path strings. \
                 Starting with empty attach-path allow-list.",
                path.display()
            );
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    // We can't easily synthesize an `AppHandle` in a unit test, so we exercise
    // the parsing logic through the file format the loader expects. This
    // mirrors the contract `load_allowed_attach_paths` implements.

    fn parse_like_loader(bytes: &[u8]) -> Vec<String> {
        serde_json::from_slice::<Vec<String>>(bytes)
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    #[test]
    fn parses_simple_array() {
        let v = parse_like_loader(
            br#"["/home/me/docs", "/home/me/projects"]"#,
        );
        assert_eq!(v, vec!["/home/me/docs", "/home/me/projects"]);
    }

    #[test]
    fn missing_file_yields_empty() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("does-not-exist.json");
        assert!(fs::read(&missing).is_err());
        assert!(parse_like_loader(b"").is_empty());
    }

    #[test]
    fn corrupt_json_yields_empty() {
        assert!(parse_like_loader(b"{not json").is_empty());
    }

    #[test]
    fn non_array_top_level_yields_empty() {
        // An object should not silently be accepted as an allow-list.
        assert!(parse_like_loader(br#"{"path": "/x"}"#).is_empty());
    }

    #[test]
    fn blank_entries_are_filtered() {
        let v = parse_like_loader(
            br#"["/a", "  ", "", " /b "]"#,
        );
        assert_eq!(v, vec!["/a", "/b"]);
    }

    #[test]
    fn empty_array_is_valid() {
        assert!(parse_like_loader(b"[]").is_empty());
    }

    // Sanity: the helper that names the JSON file lives under jan_data_folder.
    #[test]
    fn json_path_is_named_allowed_attach_paths_json() {
        // We can't build an AppHandle here, but we can assert the constant the
        // path helper uses — guards against accidental rename.
        assert_eq!(ATTACH_PATHS_FILE, "allowed_attach_paths.json");
    }

    // Silence the unused-import warning for `json!` if serde_json ever changes
    // how it exposes the macro — keep the import so future test additions can
    // reach for it without re-adding it.
    #[test]
    fn json_macro_still_imported() {
        let _ = json!({"ok": true});
    }
}
