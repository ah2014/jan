//! On-disk persistence for remote provider configurations.
//!
//! [`AppState::provider_configs`](crate::core::state::AppState) is the
//! in-memory source of truth consumed by both the Local API Server proxy and
//! the web UI server. These helpers load it from / save it to
//! `<jan_data_folder>/providers.json` so that:
//!
//!   * provider/model settings configured on the desktop are shared with the
//!     web UI (the web server reads the same map), and
//!   * the configuration survives restarts.
//!
//! The file is serialized as a JSON array of [`ProviderConfig`] (each entry
//! carries its own `provider` key), which matches the shape already returned
//! by the `listProviderConfigs` command.

use std::collections::HashMap;

use tauri::{AppHandle, Runtime};

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::state::ProviderConfig;

const PROVIDERS_FILE: &str = "providers.json";

fn providers_json_path<R: Runtime>(app_handle: &AppHandle<R>) -> std::path::PathBuf {
    let mut p = get_jan_data_folder_path(app_handle.clone());
    p.push(PROVIDERS_FILE);
    p
}

/// Load the persisted provider configs from disk.
///
/// A missing file is normal (first run / nothing configured yet) and yields an
/// empty map. A corrupt file logs a warning and yields an empty map rather than
/// aborting startup.
pub fn load_provider_configs<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> HashMap<String, ProviderConfig> {
    let path = providers_json_path(app_handle);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(e) => {
            log::warn!(
                "Failed to read {}: {e}. Starting with empty provider configs.",
                path.display()
            );
            return HashMap::new();
        }
    };
    match serde_json::from_slice::<Vec<ProviderConfig>>(&bytes) {
        Ok(list) => list
            .into_iter()
            .map(|c| (c.provider.clone(), c))
            .collect(),
        Err(e) => {
            log::warn!(
                "Failed to parse {}: {e}. Starting with empty provider configs.",
                path.display()
            );
            HashMap::new()
        }
    }
}

/// Persist the current provider configs to disk (best-effort; errors are
/// logged but not propagated, since the in-memory map remains authoritative).
pub fn save_provider_configs<R: Runtime>(
    app_handle: &AppHandle<R>,
    configs: &HashMap<String, ProviderConfig>,
) {
    let path = providers_json_path(app_handle);
    let values: Vec<&ProviderConfig> = configs.values().collect();
    match serde_json::to_vec_pretty(&values) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                log::error!("Failed to write {}: {e}", path.display());
            }
        }
        Err(e) => log::error!("Failed to serialize provider configs: {e}"),
    }
}
