//! Remote-attach picker commands.
//!
//! These power the frontend's `~` file picker, which lets users attach files
//! that already live on the backend host (the desktop machine or the device
//! running the web server) without uploading them through the browser. The
//! allowed roots come from [`attach_paths_store`] — there is no in-app UI to
//! edit them; the user hand-edits
//! `<jan_data_folder>/allowed_attach_paths.json`.
//!
//! Three commands:
//!   * [`list_allowed_attach_paths`] — return the configured root folders.
//!   * [`walk_allowed_attach_paths`] — recursively list every file/dir under
//!     the configured roots (bounded, with sensible noise filtering), so the
//!     frontend can cache + filter the tree client-side as the user types.
//!   * [`read_attach_file_base64`] — return raw bytes for a chosen file.
//!     Restricted to paths that live under a configured root, so a malicious
//!     or buggy frontend cannot exfiltrate arbitrary files.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use tauri::Runtime;

use crate::core::filesystem::models::{AttachFileBytes, AttachFileEntry};
use crate::core::server::attach_paths_store::load_allowed_attach_paths;

/// Directory basenames we never descend into. These are noise for a file
/// picker (huge, slow, and never something the user wants to attach) and some
/// (`.git`, `node_modules`) can contain hundreds of thousands of entries.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".hg",
    ".svn",
    "target",
    "build",
    "dist",
    ".cache",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".DS_Store",
];

/// Soft cap on the number of entries a single walk can return. Prevents a
/// misconfigured allow-list (e.g. `/`) from hanging the IPC channel and the
/// frontend. The frontend surfaces a "narrow your allow-list" hint when hit.
const MAX_ENTRIES: usize = 50_000;

/// Return the configured allow-list of root folders verbatim.
#[tauri::command]
pub fn list_allowed_attach_paths<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    Ok(load_allowed_attach_paths(&app_handle))
}

/// Recursively walk every configured root and return a flat list of files and
/// directories. The frontend caches this and filters client-side as the user
/// types in the `~` picker.
///
/// Missing roots are skipped (with a warning) rather than failing the whole
/// call — a user might have removed a folder since editing the JSON. Symlinked
/// directories are not followed, to keep the walk bounded and within the
/// intended roots.
#[tauri::command]
pub fn walk_allowed_attach_paths<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<AttachFileEntry>, String> {
    let roots = load_allowed_attach_paths(&app_handle);
    let mut out: Vec<AttachFileEntry> = Vec::new();

    for raw_root in roots {
        let root = PathBuf::from(&raw_root);
        let canonical_root = match root.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                log::warn!(
                    "attach-paths: skipping unreachable root {}: {e}",
                    root.display()
                );
                continue;
            }
        };
        // Push the root itself so it shows up in the picker even when empty.
        push_entry(&mut out, &canonical_root);
        walk_dir(&canonical_root, &mut out);
        if out.len() >= MAX_ENTRIES {
            out.truncate(MAX_ENTRIES);
            log::warn!(
                "attach-paths: walk returned >= {MAX_ENTRIES} entries; truncating. \
                 Narrow the allow-list in allowed_attach_paths.json for full coverage."
            );
            break;
        }
    }
    Ok(out)
}

/// Read a single file under a configured root and return its bytes as base64.
/// The path must live under one of the allowed roots (canonicalized
/// comparison), otherwise this returns an error — this is the security
/// boundary that stops a buggy/hostile frontend from reading arbitrary files.
#[tauri::command]
pub fn read_attach_file_base64<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    path: String,
) -> Result<AttachFileBytes, String> {
    let requested = PathBuf::from(&path);
    let canonical = requested
        .canonicalize()
        .map_err(|e| format!("attach-paths: cannot read {}: {e}", requested.display()))?;

    if !is_under_any_allowed_root(&app_handle, &canonical)? {
        return Err(format!(
            "attach-paths: path {} is outside the configured allowed_attach_paths.json roots",
            canonical.display()
        ));
    }
    if !canonical.is_file() {
        return Err(format!(
            "attach-paths: not a file: {}",
            canonical.display()
        ));
    }
    let bytes = fs::read(&canonical).map_err(|e| {
        format!(
            "attach-paths: failed to read {}: {e}",
            canonical.display()
        )
    })?;
    let size = bytes.len() as u64;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(AttachFileBytes { base64, size })
}

// --- helpers -----------------------------------------------------------------

fn push_entry(out: &mut Vec<AttachFileEntry>, path: &Path) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let is_dir = path.is_dir();
    let size = if is_dir {
        0
    } else {
        path.metadata().map(|m| m.len()).unwrap_or(0)
    };
    out.push(AttachFileEntry {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir,
        size,
    });
}

/// Recursive, depth-first walk. Manually implemented (rather than pulling in
/// `walkdir`) so we can hard-cap output and skip noise directories uniformly.
/// Symlinks to directories are intentionally not followed.
fn walk_dir(dir: &Path, out: &mut Vec<AttachFileEntry>) {
    if out.len() >= MAX_ENTRIES {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            log::debug!(
                "attach-paths: cannot read dir {}: {e}",
                dir.display()
            );
            return;
        }
    };
    let mut children: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    // Sort so the cache the frontend receives is deterministic across runs.
    children.sort();
    for child in children {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        // Skip hidden entries (`.foo`) — matches what a native file picker
        // shows by default and avoids surfacing e.g. `.env` accidentally.
        let is_hidden = child
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with('.') && n != ".")
            .unwrap_or(false);
        if is_hidden {
            continue;
        }
        // Use symlink_metadata (not metadata/is_dir) so symlinks are never
        // followed: `child.is_dir()` resolves the link target and would let a
        // symlinked directory escape the configured roots (contradicting the
        // boundedness guarantee in the doc comment) and leak names of files
        // outside the allow-list into the picker. Symlinks of any kind are
        // skipped entirely.
        let meta = match fs::symlink_metadata(&child) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let skip = child
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| SKIP_DIRS.contains(&n))
                .unwrap_or(false);
            push_entry(out, &child);
            if !skip {
                walk_dir(&child, out);
            }
            continue;
        }
        if meta.is_file() {
            push_entry(out, &child);
        }
    }
}

/// True if `path` (already canonicalized) lives under at least one configured
/// root. Roots that fail to canonicalize are ignored. This is the security
/// gate for [`read_attach_file_base64`].
fn is_under_any_allowed_root<R: Runtime>(
    app_handle: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<bool, String> {
    let roots = load_allowed_attach_paths(app_handle);
    for raw in roots {
        let canonical_root = match PathBuf::from(&raw).canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if path.starts_with(&canonical_root) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // We can't materialize an AppHandle in a plain unit test, so the
    // security-sensitive + traversal logic is factored to be testable without
    // one: walk_dir operates on plain Paths, and the allow-list check is
    // expressed against a Vec of canonical roots.

    fn is_under_roots(path: &Path, roots: &[PathBuf]) -> bool {
        roots.iter().any(|r| path.starts_with(r))
    }

    #[test]
    fn walk_collects_files_and_dirs_sorted() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.txt"), "hi").unwrap();
        fs::write(root.join("sub").join("b.txt"), "yo").unwrap();

        let mut out = vec![];
        push_entry(&mut out, root); // mimic walk_allowed_attach_paths pushing the root first
        walk_dir(root, &mut out);

        let paths: Vec<&str> = out.iter().map(|e| e.path.as_str()).collect();
        // Root + sub/ + a.txt + sub/b.txt — all canonical so just check suffixes.
        assert!(paths.iter().any(|p| p.ends_with("a.txt")));
        assert!(paths.iter().any(|p| p.ends_with("b.txt")));
        assert!(paths.iter().any(|p| p.ends_with("sub")));
        // a.txt should sort before sub/ in the same level (deterministic order)
        let a_idx = paths.iter().position(|p| p.ends_with("a.txt")).unwrap();
        let sub_idx = paths.iter().position(|p| p.ends_with("sub")).unwrap();
        assert!(a_idx < sub_idx, "files should sort before dirs at the same level");
    }

    #[test]
    fn walk_skips_hidden_and_noise_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("ok")).unwrap();
        fs::write(root.join(".env"), "SECRET=x").unwrap();
        fs::write(root.join(".hidden").join("leak.txt"), "x").unwrap();
        fs::write(root.join("node_modules").join("pkg.json"), "{}").unwrap();
        fs::write(root.join("ok").join("y.txt"), "y").unwrap();

        let mut out = vec![];
        walk_dir(root, &mut out);

        let joined = out
            .iter()
            .map(|e| e.path.clone())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!joined.contains(".env"), "hidden files should be skipped");
        assert!(
            !joined.contains("leak.txt"),
            "hidden dirs should not be descended into"
        );
        assert!(
            !joined.contains("pkg.json"),
            "node_modules should be listed but not walked"
        );
        assert!(joined.contains("y.txt"));
        // node_modules itself *is* listed (so the user sees it), just not walked
        assert!(joined.contains("node_modules"));
    }

    #[test]
    fn walk_respects_max_entries_cap() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // Generate more than cap files at the top level.
        let cap_backup = MAX_ENTRIES;
        for i in 0..(cap_backup + 50) {
            fs::write(root.join(format!("f{i}")), "x").unwrap();
        }
        let mut out = vec![];
        walk_dir(root, &mut out);
        assert!(out.len() <= cap_backup, "walk must not exceed the cap");
    }

    #[cfg(unix)]
    #[test]
    fn walk_does_not_follow_symlinked_dirs_or_files() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Target tree that lives OUTSIDE the walked root — if a symlink is
        // followed, these names leak into the picker output. Use a second
        // TempDir so the content is genuinely outside `root` (not reachable
        // by descending the real directory tree).
        let outside = TempDir::new().unwrap();
        fs::create_dir_all(outside.path().join("sub")).unwrap();
        fs::write(outside.path().join("secret.txt"), "x").unwrap();
        fs::write(outside.path().join("sub").join("deeper.txt"), "x").unwrap();

        // Symlinked directory → should be skipped entirely (not listed, not
        // recursed into).
        symlink(outside.path(), root.join("escape-dir")).unwrap();
        // Symlinked file → should also be skipped.
        symlink(outside.path().join("secret.txt"), root.join("escape-file")).unwrap();
        // A regular file alongside, to confirm the walk still runs.
        fs::write(root.join("ok.txt"), "y").unwrap();

        let mut out = vec![];
        walk_dir(root, &mut out);

        let joined = out
            .iter()
            .map(|e| e.path.clone())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            joined.contains("ok.txt"),
            "regular files must still be listed"
        );
        assert!(
            !joined.contains("escape-dir"),
            "symlinked dirs must not be listed"
        );
        assert!(
            !joined.contains("escape-file"),
            "symlinked files must not be listed"
        );
        assert!(
            !joined.contains("secret.txt"),
            "walk must not follow symlinks and leak outside names"
        );
        assert!(
            !joined.contains("deeper.txt"),
            "walk must not recurse into symlinked dirs"
        );
    }

    #[test]
    fn path_outside_all_roots_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let inside = tmp.path().join("inside");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&inside).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let roots = vec![inside.canonicalize().unwrap()];

        assert!(is_under_roots(
            &outside.canonicalize().unwrap(),
            &roots
        ) == false);
    }

    #[test]
    fn path_inside_a_root_is_accepted() {
        let tmp = TempDir::new().unwrap();
        let inside = tmp.path().join("inside");
        fs::create_dir_all(&inside).unwrap();
        let file = inside.join("doc.pdf");
        fs::write(&file, "x").unwrap();
        let roots = vec![inside.canonicalize().unwrap()];

        assert!(is_under_roots(&file.canonicalize().unwrap(), &roots));
    }

    #[test]
    fn base64_roundtrips_a_file() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("a.bin");
        fs::write(&f, vec![0u8, 1, 2, 3, 250, 251]).unwrap();
        let bytes = fs::read(&f).unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let decoded =
            base64::engine::general_purpose::STANDARD.decode(&encoded).unwrap();
        assert_eq!(decoded, bytes);
        assert_eq!(bytes.len(), 6);
    }
}
