//! Tauri command surface for the web UI server.
//!
//! Mirrors the Local API Server's `start_server` / `stop_server` /
//! `get_server_status` trio, plus `set_web_password` and
//! `get_web_server_config`. Web-server settings persist in `store.json`
//! (via `tauri-plugin-store`) so the server can auto-start on launch.
//!
//! Commands are concrete over `tauri::AppHandle` (= `AppHandle<Wry>`):
//! the web server is desktop-only, and `WebCtx` holds a concrete handle.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::state::AppState;
use crate::core::web_server::auth::hash_password;
use crate::core::web_server::server::{start_web_server as run_web_server, stop_web_server as stop_web_server_task, WebCtx};

const STORE_KEY: &str = "web_server";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServerSettings {
    pub host: String,
    pub port: u16,
    /// SHA-256 hex of the configured password (never the raw password).
    pub password_hash: Option<String>,
    pub autostart: bool,
    pub enabled: bool,
    /// Optional override for the built web UI directory.
    pub ui_path: Option<String>,
}

impl Default for WebServerSettings {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 8181,
            password_hash: None,
            autostart: false,
            enabled: false,
            ui_path: None,
        }
    }
}

fn store_path(app_handle: &AppHandle) -> PathBuf {
    let mut p = get_jan_data_folder_path(app_handle.clone());
    p.push("store.json");
    p
}

fn load_settings(app_handle: &AppHandle) -> WebServerSettings {
    let path = store_path(app_handle);
    let Ok(store) = app_handle.store(path) else {
        return WebServerSettings::default();
    };
    match store.get(STORE_KEY) {
        Some(v) => serde_json::from_value(v).unwrap_or_default(),
        None => WebServerSettings::default(),
    }
}

fn save_settings(app_handle: &AppHandle, settings: &WebServerSettings) {
    let path = store_path(app_handle);
    if let Ok(store) = app_handle.store(path) {
        let _ = store.set(STORE_KEY, serde_json::to_value(settings).unwrap_or_default());
        let _ = store.save();
    }
}

/// Resolve the web UI directory. Precedence (first existing directory wins):
/// explicit setting > `JAN_WEB_UI_PATH` env > bundled resource > dev candidates.
fn resolve_ui_path(app_handle: &AppHandle, override_path: &Option<String>) -> PathBuf {
    // 1. Explicit per-instance override.
    if let Some(p) = override_path {
        return expand_home(p);
    }
    // 2. Environment override.
    if let Ok(env_path) = std::env::var("JAN_WEB_UI_PATH") {
        if !env_path.is_empty() {
            return PathBuf::from(env_path);
        }
    }
    // 3. Bundled resource (production): <resource_dir>/web-ui
    if let Ok(res) = app_handle.path().resource_dir() {
        let candidate = res.join("web-ui");
        if candidate.is_dir() {
            return candidate;
        }
    }
    // 4. Dev candidates. Under `tauri dev` the binary's CWD is `src-tauri/`,
    //    not the repo root, so a bare relative path misses; resolve from the
    //    crate's manifest dir and also walk up from CWD as a fallback.
    let manifest_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("web-app")
        .join("dist");
    if manifest_candidate.is_dir() {
        return manifest_candidate;
    }
    // Walk up from CWD looking for `web-app/dist` (covers other launch dirs).
    if let Ok(cwd) = std::env::current_dir() {
        let mut cur: Option<&Path> = Some(&cwd);
        while let Some(dir) = cur {
            let candidate = dir.join("web-app").join("dist");
            if candidate.is_dir() {
                return candidate;
            }
            cur = dir.parent();
        }
    }
    // Last resort: the relative path (lets the caller emit a helpful error).
    PathBuf::from("web-app/dist")
}

/// Minimal `~` -> home-directory expansion (the only path-expansion we need).
fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix('~') {
        let home = std::env::var(if cfg!(target_os = "windows") {
            "USERPROFILE"
        } else {
            "HOME"
        });
        if let Ok(home) = home {
            return PathBuf::from(format!("{home}{rest}"));
        }
    }
    PathBuf::from(p)
}

#[derive(Debug, Deserialize)]
pub struct StartWebServerConfig {
    pub host: String,
    pub port: u16,
    /// Optional; when present, updates the stored password hash.
    pub password: Option<String>,
    pub ui_path: Option<String>,
}

#[tauri::command]
pub async fn start_web_server(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    config: StartWebServerConfig,
) -> Result<u16, String> {
    let mut settings = load_settings(&app_handle);
    settings.host = config.host.clone();
    settings.port = config.port;
    settings.ui_path = config.ui_path.clone();

    // Update password if a new one was supplied.
    if let Some(ref pw) = config.password {
        if !pw.is_empty() {
            let hash = hash_password(pw);
            settings.password_hash = Some(hash.clone());
            *state.web_password.lock().await = Some(hash);
        }
    }
    // Sync the in-memory hash from settings if the server is being started
    // without a fresh password (e.g. autostart).
    {
        let mut guard = state.web_password.lock().await;
        if guard.is_none() {
            *guard = settings.password_hash.clone();
        }
    }

    let password_empty = state
        .web_password
        .lock()
        .await
        .as_deref()
        .map(|h| h.is_empty())
        .unwrap_or(true);
    if password_empty {
        return Err("No password set. Configure a password before starting the web server.".into());
    }

    let ui_path = resolve_ui_path(&app_handle, &settings.ui_path);
    log::info!("Starting web server (UI root: {})", ui_path.display());

    let ctx = WebCtx {
        app_handle: app_handle.clone(),
        password_hash: state.web_password.clone(),
        ui_path,
    };

    let actual_port =
        run_web_server(state.web_server_handle.clone(), ctx, config.host, config.port)
            .await
            .map_err(|e| e.to_string())?;

    settings.enabled = true;
    settings.port = actual_port;
    save_settings(&app_handle, &settings);
    Ok(actual_port)
}

#[tauri::command]
pub async fn stop_web_server(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    stop_web_server_task(state.web_server_handle.clone())
        .await
        .map_err(|e| e.to_string())?;

    let mut settings = load_settings(&app_handle);
    settings.enabled = false;
    save_settings(&app_handle, &settings);
    Ok(())
}

#[tauri::command]
pub async fn get_web_server_status(state: State<'_, AppState>) -> Result<bool, String> {
    let guard = state.web_server_handle.lock().await;
    Ok(guard.is_some())
}

#[derive(Debug, Serialize)]
pub struct WebServerConfigResponse {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub password_configured: bool,
    pub autostart: bool,
    pub ui_path: Option<String>,
}

#[tauri::command]
pub async fn get_web_server_config(app_handle: AppHandle) -> Result<WebServerConfigResponse, String> {
    let settings = load_settings(&app_handle);
    Ok(WebServerConfigResponse {
        enabled: settings.enabled,
        host: settings.host,
        port: settings.port,
        password_configured: settings.password_hash.is_some(),
        autostart: settings.autostart,
        ui_path: settings.ui_path,
    })
}

#[tauri::command]
pub async fn set_web_password(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<(), String> {
    if password.is_empty() {
        return Err("Password must not be empty".into());
    }
    let hash = hash_password(&password);
    *state.web_password.lock().await = Some(hash.clone());

    let mut settings = load_settings(&app_handle);
    settings.password_hash = Some(hash);
    save_settings(&app_handle, &settings);
    Ok(())
}

#[tauri::command]
pub async fn set_web_server_autostart(app_handle: AppHandle, autostart: bool) -> Result<(), String> {
    let mut settings = load_settings(&app_handle);
    settings.autostart = autostart;
    save_settings(&app_handle, &settings);
    Ok(())
}

/// Called from `setup()` to auto-start the web server if the user enabled it.
pub async fn maybe_autostart(app_handle: AppHandle) {
    let settings = load_settings(&app_handle);
    if !settings.autostart || !settings.enabled {
        return;
    }
    if settings
        .password_hash
        .as_deref()
        .map(|h| h.is_empty())
        .unwrap_or(true)
    {
        log::warn!("Web server autostart skipped: no password configured");
        return;
    }

    let state = app_handle.state::<AppState>();
    *state.web_password.lock().await = settings.password_hash.clone();

    let ui_path = resolve_ui_path(&app_handle, &settings.ui_path);
    let ctx = WebCtx {
        app_handle: app_handle.clone(),
        password_hash: state.web_password.clone(),
        ui_path,
    };
    match run_web_server(state.web_server_handle.clone(), ctx, settings.host, settings.port).await {
        Ok(port) => log::info!("Web server auto-started on port {port}"),
        Err(e) => log::error!("Web server autostart failed: {e}"),
    }
}
