use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::core::state::{AppState, ProviderConfig};

/// Custom header for provider requests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCustomHeader {
    pub header: String,
    pub value: String,
}

/// Request to register/update a remote provider config
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterProviderRequest {
    pub provider: String,
    pub api_key: Option<String>,
    /// Additional keys (after `api_key`) when the upstream returns 401, 403, or 429.
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: Option<String>,
    pub custom_headers: Vec<ProviderCustomHeader>,
    pub models: Vec<String>,
}

pub(crate) fn merge_register_api_keys(api_key: Option<String>, api_keys: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push_unique = |s: String| {
        let t = s.trim().to_string();
        if t.is_empty() {
            return;
        }
        if !out.iter().any(|x| x == &t) {
            out.push(t);
        }
    };
    if let Some(k) = api_key {
        push_unique(k);
    }
    for k in api_keys {
        push_unique(k);
    }
    out
}

/// Shared upsert used by both the Tauri command and the web `/api/invoke`
/// dispatcher (which can't easily construct a `State<AppState>`).
///
/// `providers.json` is treated as authoritative: we load-modify-save it so that
/// a process whose in-memory cache is stale or incomplete (e.g. started before
/// the file existed) never clobbers providers it doesn't know about. The
/// in-memory map is then refreshed to mirror the file.
pub async fn upsert_provider_config(
    app_handle: &AppHandle,
    request: RegisterProviderRequest,
) -> Result<(), String> {
    use crate::core::server::provider_store::{load_provider_configs, save_provider_configs};

    let key_chain = merge_register_api_keys(request.api_key.clone(), request.api_keys.clone());
    let api_key = key_chain.first().cloned();
    let mut config = ProviderConfig {
        provider: request.provider.clone(),
        api_key,
        api_keys: key_chain,
        base_url: request.base_url,
        custom_headers: request
            .custom_headers
            .into_iter()
            .map(|h| crate::core::state::ProviderCustomHeader {
                header: h.header,
                value: h.value,
            })
            .collect(),
        models: request.models,
        model_capabilities: Default::default(),
    };

    let provider_configs = app_handle.state::<AppState>().provider_configs.clone();
    let provider_name = request.provider.clone();
    let mut g = provider_configs.lock().await;

    // Read-modify-write on the authoritative file (small sync I/O under the
    // lock is fine and serialises concurrent mutations).
    let mut map = load_provider_configs(app_handle);
    // Preserve user-configured per-model capabilities across re-registration
    // (they're orthogonal to keys/base_url and not part of the request).
    let preserved_caps = map
        .get(&provider_name)
        .map(|c| c.model_capabilities.clone())
        .unwrap_or_default();
    config.model_capabilities = preserved_caps;
    map.insert(provider_name.clone(), config);
    save_provider_configs(app_handle, &map);
    // Mirror the authoritative on-disk state into the in-memory cache.
    *g = map;

    log::info!("Registered provider config: {provider_name}");
    Ok(())
}

/// Shared removal helper (see [`upsert_provider_config`]).
pub async fn remove_provider_config(app_handle: &AppHandle, provider: &str) -> Result<(), String> {
    use crate::core::server::provider_store::{load_provider_configs, save_provider_configs};

    let provider_configs = app_handle.state::<AppState>().provider_configs.clone();
    let mut g = provider_configs.lock().await;

    let mut map = load_provider_configs(app_handle);
    if map.remove(provider).is_none() {
        // Not on disk; also drop from the in-memory cache if present.
        if g.remove(provider).is_some() {
            save_provider_configs(app_handle, &g);
        }
        return Ok(());
    }
    save_provider_configs(app_handle, &map);
    *g = map;
    log::info!("Unregistered provider config: {provider}");
    Ok(())
}

/// Set per-model capabilities (vision/audio/…) for a provider. Targeted
/// read-modify-write: preserves the provider's keys/base_url and only updates
/// the one model entry — safe for the web UI, which doesn't hold the API key.
pub async fn upsert_provider_model_capabilities(
    app_handle: &AppHandle,
    provider: &str,
    model_id: &str,
    capabilities: Vec<String>,
) -> Result<(), String> {
    use crate::core::server::provider_store::{load_provider_configs, save_provider_configs};

    let provider_configs = app_handle.state::<AppState>().provider_configs.clone();
    let mut g = provider_configs.lock().await;

    let mut map = load_provider_configs(app_handle);
    let entry = map
        .get_mut(provider)
        .ok_or_else(|| format!("Provider '{provider}' is not configured"))?;
    if capabilities.is_empty() {
        entry.model_capabilities.remove(model_id);
    } else {
        entry.model_capabilities
            .insert(model_id.to_string(), capabilities);
    }
    save_provider_configs(app_handle, &map);
    *g = map;
    Ok(())
}

/// Register a remote provider configuration
#[tauri::command]
pub async fn register_provider_config(
    app_handle: AppHandle,
    _state: State<'_, AppState>,
    request: RegisterProviderRequest,
) -> Result<(), String> {
    upsert_provider_config(&app_handle, request).await
}

/// Unregister a provider configuration
#[tauri::command]
pub async fn unregister_provider_config(
    app_handle: AppHandle,
    _state: State<'_, AppState>,
    provider: String,
) -> Result<(), String> {
    remove_provider_config(&app_handle, &provider).await
}

/// Set per-model capabilities (vision/audio/…) for a provider. Targeted update
/// that preserves the provider's API key/base_url.
#[tauri::command]
pub async fn set_provider_model_capabilities(
    app_handle: AppHandle,
    _state: State<'_, AppState>,
    provider: String,
    model_id: String,
    capabilities: Vec<String>,
) -> Result<(), String> {
    upsert_provider_model_capabilities(&app_handle, &provider, &model_id, capabilities).await
}

/// Get provider configuration by name
#[tauri::command]
pub async fn get_provider_config(
    state: State<'_, AppState>,
    provider: String,
) -> Result<Option<ProviderConfig>, String> {
    let provider_configs = state.provider_configs.clone();
    let configs = provider_configs.lock().await;

    Ok(configs.get(&provider).cloned())
}

/// List all registered provider configurations (without sensitive keys)
#[tauri::command]
pub async fn list_provider_configs(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderConfig>, String> {
    let provider_configs = state.provider_configs.clone();
    let configs = provider_configs.lock().await;

    Ok(configs.values().cloned().collect())
}
