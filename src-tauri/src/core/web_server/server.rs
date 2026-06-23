//! Web UI HTTP server.
//!
//! A self-contained hyper server that runs inside the Tauri process alongside
//! the desktop GUI. It serves:
//!   * the static web UI build (with SPA fallback to `index.html`),
//!   * `POST /api/invoke` — a JSON dispatch endpoint that mirrors Tauri's
//!     `invoke()` model and reuses the existing command implementations,
//!   * `POST /api/proxy` — a server-side LLM gateway that forwards requests to
//!     the configured provider's `base_url`, streaming the response back. The
//!     web UI targets this instead of the provider directly, so API keys never
//!     reach the browser and the (possibly non-CORS) llama.cpp /
//!     OpenAI-compatible server only needs to be reachable from this process,
//!   * `POST /api/auth/login` | `logout` | `GET /api/auth/check` — the
//!     single-password gate.
//!
//! Provider/model settings are shared with the desktop app: both read/write the
//! same persisted `providers.json` via the command surface above.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use futures_util::StreamExt;
use hyper::body::HttpBody;
use hyper::header::{CONTENT_TYPE, SET_COOKIE};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::core::app::commands::{
    get_app_configurations, get_jan_data_folder_path,
};
use crate::core::filesystem::commands::{
    exists_sync, file_stat, join_path, mkdir, read_file_sync, readdir_sync, rm,
    write_file_sync,
};
use crate::core::filesystem::attach_path_commands::{
    list_allowed_attach_paths, read_attach_file_base64, walk_allowed_attach_paths,
};
use crate::core::server::remote_provider_commands::{
    remove_provider_config, upsert_provider_config, upsert_provider_model_capabilities,
    RegisterProviderRequest,
};
use crate::core::state::{AppState, ProviderConfig};
use crate::core::threads::commands::{
    create_message, create_thread, create_thread_assistant, delete_message,
    delete_thread, get_thread_assistant, list_messages, list_threads,
    modify_message, modify_thread, modify_thread_assistant,
};
use crate::core::web_server::auth::{
    clear_cookie, create_session_token, parse_cookie, session_cookie, verify_password,
    verify_session_token, COOKIE_NAME,
};

/// Handle type for the web server lifecycle (mirrors the proxy server handle).
pub type WebServerHandle =
    tokio::task::JoinHandle<Result<(), Box<dyn std::error::Error + Send + Sync>>>;

/// Shared, mutable context passed to every request handler.
#[derive(Clone)]
pub struct WebCtx {
    pub app_handle: AppHandle,
    /// SHA-256 hex of the configured password. `None` until the user sets one.
    /// Live-mutable so `set_web_password` takes effect without a restart.
    pub password_hash: Arc<Mutex<Option<String>>>,
    /// Filesystem root of the built web UI (`web-app/dist`).
    pub ui_path: PathBuf,
}

const JSON: &str = "application/json";

#[derive(serde::Deserialize)]
struct InvokeRequest {
    route: String,
    #[serde(default)]
    args: serde_json::Value,
}

/// Start the web server. Returns the bound port.
pub async fn start_web_server(
    server_handle: Arc<Mutex<Option<WebServerHandle>>>,
    ctx: WebCtx,
    host: String,
    port: u16,
) -> Result<u16, Box<dyn std::error::Error + Send + Sync>> {
    let mut guard = server_handle.lock().await;
    if guard.is_some() {
        return Err("Web server is already running".into());
    }

    let addr: std::net::SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| format!("Invalid web server address: {e}"))?;

    let make_svc = make_service_fn(move |_conn| {
        let ctx = ctx.clone();
        async move {
            Ok::<_, std::convert::Infallible>(service_fn(move |req| {
                let ctx = ctx.clone();
                handle_request(req, ctx)
            }))
        }
    });

    let server = match Server::try_bind(&addr) {
        Ok(b) => b.serve(make_svc),
        Err(e) => {
            log::error!("Failed to bind web server to {addr}: {e}");
            return Err(Box::new(e));
        }
    };
    log::info!("Jan web server started on http://{addr}");

    let task = tokio::spawn(async move {
        if let Err(e) = server.await {
            log::error!("Web server error: {e}");
            return Err(Box::new(e) as Box<dyn std::error::Error + Send + Sync>);
        }
        Ok(())
    });

    *guard = Some(task);
    Ok(addr.port())
}

/// Stop the web server.
pub async fn stop_web_server(
    server_handle: Arc<Mutex<Option<WebServerHandle>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut guard = server_handle.lock().await;
    if let Some(handle) = guard.take() {
        handle.abort();
        log::info!("Jan web server stopped");
    }
    Ok(())
}

fn json_response(status: StatusCode, body: &serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, JSON)
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn err_response(status: StatusCode, message: &str) -> Response<Body> {
    json_response(
        status,
        &serde_json::json!({ "error": message }),
    )
}

/// Is this request authenticated?
async fn is_authed(req: &Request<Body>, password_hash: &Arc<Mutex<Option<String>>>) -> bool {
    let hash_guard = password_hash.lock().await;
    let hash = match hash_guard.as_deref() {
        Some(h) if !h.is_empty() => h,
        _ => return false, // No password configured -> nothing is authed.
    };
    let cookie = req
        .headers()
        .get("cookie")
        .and_then(|v| v.to_str().ok());
    match parse_cookie(cookie, COOKIE_NAME) {
        Some(token) => verify_session_token(&token, hash),
        None => false,
    }
}

async fn handle_request(req: Request<Body>, ctx: WebCtx) -> Result<Response<Body>, std::convert::Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    // --- Auth endpoints (no prior auth required) ---
    if path == "/api/auth/login" && method == Method::POST {
        return Ok(handle_login(req, &ctx).await);
    }
    if path == "/api/auth/logout" && method == Method::POST {
        return Ok(Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(SET_COOKIE, clear_cookie())
            .body(Body::empty())
            .unwrap());
    }
    if path == "/api/auth/check" && method == Method::GET {
        let authed = is_authed(&req, &ctx.password_hash).await;
        let configured = ctx.password_hash.lock().await.is_some();
        return Ok(json_response(
            StatusCode::OK,
            &serde_json::json!({ "authenticated": authed, "passwordConfigured": configured }),
        ));
    }

    // --- API gateway (auth required) ---
    if path.starts_with("/api/") {
        if !is_authed(&req, &ctx.password_hash).await {
            return Ok(err_response(StatusCode::UNAUTHORIZED, "Unauthorized"));
        }
        if path == "/api/invoke" && method == Method::POST {
            return Ok(handle_invoke(req, &ctx).await);
        }
        // Server-side LLM gateway: the web UI forwards provider requests here
        // so API keys never reach the browser and the (possibly non-CORS)
        // llama.cpp / OpenAI-compatible server only needs to be reachable from
        // this process. Both `chat/completions` (streamed) and `/models`
        // (buffered) are handled by a single transparent proxy that reuses the
        // stored provider config.
        if path == "/api/proxy" {
            return Ok(handle_proxy(req, &ctx).await);
        }
        return Ok(err_response(StatusCode::NOT_FOUND, "Unknown API endpoint"));
    }

    // --- Static UI (SPA) ---
    if method == Method::GET {
        return Ok(serve_static(&ctx.ui_path, &path));
    }

    Ok(err_response(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"))
}

async fn handle_login(req: Request<Body>, ctx: &WebCtx) -> Response<Body> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(e) => return err_response(StatusCode::BAD_REQUEST, &e),
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err_response(StatusCode::BAD_REQUEST, "Invalid JSON"),
    };
    let password = parsed.get("password").and_then(|v| v.as_str()).unwrap_or("");

    let hash_guard = ctx.password_hash.lock().await;
    let expected = match hash_guard.as_deref() {
        Some(h) if !h.is_empty() => h,
        _ => {
            drop(hash_guard);
            return err_response(StatusCode::FORBIDDEN, "No password configured");
        }
    };
    if !verify_password(password, expected) {
        // Constant delay would be nicer; for a LAN app this is acceptable.
        return err_response(StatusCode::UNAUTHORIZED, "Invalid password");
    }
    let token = match create_session_token(expected) {
        Some(t) => t,
        None => return err_response(StatusCode::INTERNAL_SERVER_ERROR, "Token error"),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(SET_COOKIE, session_cookie(&token, super::auth::SESSION_TTL_SECS))
        .header(CONTENT_TYPE, JSON)
        .body(Body::from(serde_json::json!({ "ok": true }).to_string()))
        .unwrap()
}

/// The `/api/invoke` dispatcher: `{ route, args }` -> result of the matching
/// command. Mirrors Tauri's `invoke()` so the web `core.api` shim can stay
/// a thin wrapper.
async fn handle_invoke(req: Request<Body>, ctx: &WebCtx) -> Response<Body> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(e) => return err_response(StatusCode::BAD_REQUEST, &e),
    };
    let parsed: InvokeRequest = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err_response(StatusCode::BAD_REQUEST, "Invalid JSON"),
    };

    let app_handle = ctx.app_handle.clone();
    let result = dispatch(&parsed.route, &parsed.args, &app_handle).await;

    match result {
        Ok(value) => json_response(StatusCode::OK, &value),
        Err(msg) => err_response(StatusCode::INTERNAL_SERVER_ERROR, &msg),
    }
}

/// Pull the full request body into a `Vec<u8>`.
async fn read_body(req: Request<Body>) -> Result<Vec<u8>, String> {
    let mut body = req.into_body();
    let mut buf = Vec::new();
    while let Some(chunk) = body.data().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

// --- Argument helpers --------------------------------------------------------

/// Fetch a string field from a JSON object, trying several key spellings
/// (camelCase first, matching the JS extension call-sites).
fn arg_str(args: &serde_json::Value, keys: &[&str]) -> Result<String, String> {
    if let Some(obj) = args.as_object() {
        for k in keys {
            if let Some(v) = obj.get(*k) {
                if let Some(s) = v.as_str() {
                    return Ok(s.to_string());
                }
            }
        }
    }
    Err(format!("Missing string field (tried {keys:?})"))
}

/// Extract the `args: [...]` array used by `@janhq/core`'s fs module
/// (`core.api.readFileSync({ args: [path] })`).
fn fs_args(args: &serde_json::Value) -> Result<Vec<String>, String> {
    let arr = args
        .get("args")
        .and_then(|v| v.as_array())
        .ok_or("Expected { args: [...] }")?;
    arr.iter()
        .map(|v| {
            v.as_str()
                .map(String::from)
                .ok_or_else(|| "fs arg is not a string".to_string())
        })
        .collect()
}

fn arg_value(args: &serde_json::Value, keys: &[&str]) -> Result<serde_json::Value, String> {
    if let Some(obj) = args.as_object() {
        for k in keys {
            if let Some(v) = obj.get(*k) {
                return Ok(v.clone());
            }
        }
    }
    Err(format!("Missing object field (tried {keys:?})"))
}

/// Rewrite specific object keys (e.g. `apiKey` -> `api_key`) for serde structs
/// that expect snake_case. Non-object input is returned unchanged.
fn normalize_keys(args: &serde_json::Value, mappings: &[(&str, &str)]) -> serde_json::Value {
    let Some(obj) = args.as_object() else {
        return args.clone();
    };
    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        let key = mappings
            .iter()
            .find(|(from, _)| *from == k.as_str())
            .map(|(_, to)| *to)
            .unwrap_or_else(|| k.as_str());
        out.insert(key.to_string(), v.clone());
    }
    serde_json::Value::Object(out)
}

fn provider_configs_from(
    app_handle: &AppHandle,
) -> Arc<Mutex<HashMap<String, crate::core::state::ProviderConfig>>> {
    app_handle
        .state::<AppState>()
        .provider_configs
        .clone()
}

// --- Dispatcher --------------------------------------------------------------

async fn dispatch(
    route: &str,
    args: &serde_json::Value,
    app_handle: &AppHandle,
) -> Result<serde_json::Value, String> {
    use serde_json::json;

    match route {
        // -- Threads --
        "listThreads" => Ok(json!(list_threads(app_handle.clone()).await?)),
        "createThread" => {
            let thread = arg_value(args, &["thread"])?;
            Ok(json!(create_thread(app_handle.clone(), thread).await?))
        }
        "modifyThread" => {
            let thread = arg_value(args, &["thread"])?;
            modify_thread(app_handle.clone(), thread).await?;
            Ok(json!({}))
        }
        "deleteThread" => {
            let id = arg_str(args, &["threadId", "thread_id"])?;
            delete_thread(app_handle.clone(), id).await?;
            Ok(json!({}))
        }

        // -- Messages --
        "listMessages" => {
            let id = arg_str(args, &["threadId", "thread_id"])?;
            Ok(json!(list_messages(app_handle.clone(), id).await?))
        }
        "createMessage" => {
            let message = arg_value(args, &["message"])?;
            Ok(json!(create_message(app_handle.clone(), message).await?))
        }
        "modifyMessage" => {
            let message = arg_value(args, &["message"])?;
            Ok(json!(modify_message(app_handle.clone(), message).await?))
        }
        "deleteMessage" => {
            let thread_id = arg_str(args, &["threadId", "thread_id"])?;
            let message_id = arg_str(args, &["messageId", "message_id"])?;
            delete_message(app_handle.clone(), thread_id, message_id).await?;
            Ok(json!({}))
        }

        // -- Thread assistant --
        "getThreadAssistant" => {
            let id = arg_str(args, &["threadId", "thread_id"])?;
            Ok(json!(get_thread_assistant(app_handle.clone(), id).await?))
        }
        "createThreadAssistant" => {
            let thread_id = arg_str(args, &["threadId", "thread_id"])?;
            let assistant = arg_value(args, &["assistant"])?;
            Ok(json!(create_thread_assistant(app_handle.clone(), thread_id, assistant).await?))
        }
        "modifyThreadAssistant" => {
            let thread_id = arg_str(args, &["threadId", "thread_id"])?;
            let assistant = arg_value(args, &["assistant"])?;
            Ok(json!(modify_thread_assistant(app_handle.clone(), thread_id, assistant).await?))
        }

        // -- Provider configs --
        // NOTE: the web UI never needs raw API keys — inference is proxied
        // server-side via `/api/proxy`, which looks the key up from the
        // authoritative in-memory map. Redact on the way out so keys are never
        // shipped to the browser.
        "listProviderConfigs" => {
            let configs = provider_configs_from(app_handle);
            let g = configs.lock().await;
            let redacted: Vec<ProviderConfig> =
                g.values().cloned().map(redact_provider_config).collect();
            Ok(json!(redacted))
        }
        "getProviderConfig" => {
            let provider = arg_str(args, &["provider"])?;
            let configs = provider_configs_from(app_handle);
            let g = configs.lock().await;
            Ok(json!(g.get(&provider).cloned().map(redact_provider_config)))
        }
        "registerProviderConfig" => {
            // Normalize camelCase -> snake_case (the Tauri invoke path does
            // this automatically; the web dispatcher receives raw JSON).
            let normalized = normalize_keys(
                args,
                &[
                    ("apiKey", "api_key"),
                    ("baseUrl", "base_url"),
                    ("customHeaders", "custom_headers"),
                ],
            );
            let request: RegisterProviderRequest =
                serde_json::from_value(normalized)
                    .map_err(|e| format!("Invalid provider config: {e}"))?;
            upsert_provider_config(app_handle, request).await?;
            Ok(json!({}))
        }
        "unregisterProviderConfig" => {
            let provider = arg_str(args, &["provider"])?;
            remove_provider_config(app_handle, &provider).await?;
            Ok(json!({}))
        }
        "setProviderModelCapabilities" => {
            // Targeted update: preserves the provider's API key/base_url, so the
            // web UI (which never holds the key) can persist per-model capability
            // overrides (vision/audio/…).
            let provider = arg_str(args, &["provider"])?;
            let model_id = arg_str(args, &["modelId", "model_id"])?;
            let capabilities = args
                .get("capabilities")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            upsert_provider_model_capabilities(
                app_handle,
                &provider,
                &model_id,
                capabilities,
            )
            .await?;
            Ok(json!({}))
        }

        // -- Filesystem --
        // `@janhq/core`'s fs module calls e.g. `core.api.readFileSync({ args: [path] })`,
        // so each fs route receives `{ args: [...] }` — exactly the shape the
        // underlying Tauri command expects (`args: Vec<String>`).
        "readFileSync" => {
            let a = fs_args(args)?;
            Ok(json!(read_file_sync(app_handle.clone(), a)?))
        }
        "writeFileSync" => {
            let a = fs_args(args)?;
            write_file_sync(app_handle.clone(), a)?;
            Ok(json!({}))
        }
        "existsSync" => {
            let a = fs_args(args)?;
            Ok(json!(exists_sync(app_handle.clone(), a)?))
        }
        "readdirSync" => {
            let a = fs_args(args)?;
            Ok(json!(readdir_sync(app_handle.clone(), a)?))
        }
        "mkdir" => {
            let a = fs_args(args)?;
            mkdir(app_handle.clone(), a)?;
            Ok(json!({}))
        }
        "rm" => {
            let a = fs_args(args)?;
            rm(app_handle.clone(), a)?;
            Ok(json!({}))
        }
        "mv" => {
            let a = fs_args(args)?;
            crate::core::filesystem::commands::mv(app_handle.clone(), a)?;
            Ok(json!({}))
        }
        "fileStat" => {
            // `core.api.fileStat({ args: path })` — single string, not array.
            let p = args
                .get("args")
                .and_then(|v| v.as_str())
                .ok_or("fileStat: missing args")?
                .to_string();
            Ok(json!(file_stat(app_handle.clone(), p)?))
        }
        "joinPath" => {
            let parts = fs_args(args)?;
            Ok(json!(join_path(app_handle.clone(), parts)?))
        }

        // -- Remote-attach picker (`~` in the composer) --
        // Mirrors the Tauri commands of the same name (camelCase here;
        // lib/service.ts rewrites camelCase -> snake_case for the desktop
        // invoke path). The allow-list lives in
        // <jan_data_folder>/allowed_attach_paths.json.
        "listAllowedAttachPaths" => Ok(json!(list_allowed_attach_paths(app_handle.clone())?)),
        "walkAllowedAttachPaths" => {
            Ok(json!(walk_allowed_attach_paths(app_handle.clone())?))
        }
        "readAttachFileBase64" => {
            // `RemoteFilesService.readBytes` passes `{ path }` directly. The
            // `args` fallback accepts a bare-string `args` value (NOT the fs
            // module's `{ args: [path] }` array form, which `arg_str`
            // rejects — that is handled by `fs_args` on the fs routes above).
            // Kept for callers that may still send the legacy `{ args: path }`
            // spelling, as `fileStat` does.
            let p = arg_str(args, &["path", "args"])?;
            Ok(json!(read_attach_file_base64(app_handle.clone(), p)?))
        }

        // -- App config --
        "getAppConfigurations" => Ok(json!(get_app_configurations(app_handle.clone()))),
        "getJanDataFolderPath" => {
            Ok(json!(get_jan_data_folder_path(app_handle.clone())
                .to_string_lossy()
                .to_string()))
        }
        "getUserHomePath" => Ok(json!(get_app_configurations(app_handle.clone()).data_folder)),

        _ => Err(format!("Unknown invoke route: {route}")),
    }
}

/// Strip sensitive material from a [`ProviderConfig`] before it leaves the
/// server over the web `/api/invoke` boundary. The browser has no use for keys
/// because all inference is proxied through `/api/proxy`, which reads keys from
/// the authoritative in-memory map.
fn redact_provider_config(mut c: ProviderConfig) -> ProviderConfig {
    c.api_key = None;
    c.api_keys.clear();
    c
}

// --- Server-side LLM proxy ---------------------------------------------------

/// Header carrying the configured provider name whose `base_url` / keys should
/// be used to reach the upstream.
const H_PROVIDER: &str = "x-jan-provider";
/// Header carrying the absolute upstream URL the client wants to hit. The
/// proxy validates it against the provider's stored `base_url` to prevent SSRF.
const H_TARGET: &str = "x-jan-target-url";

/// Returns `true` for request headers the proxy must NOT relay upstream.
///
/// Three categories are dropped:
///   * **control headers** (`x-jan-*`) — consumed by the proxy itself,
///   * **auth headers** (`authorization`, `x-api-key`) — the proxy owns these,
///     injecting them from the provider's stored key chain,
///   * **hop-by-hop / transport headers** (`host`, `content-length`, ...) —
///     these are per-connection and must not be forwarded; reqwest recomputes
///     them for the outgoing request.
fn is_hop_or_control_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "x-jan-provider"
            | "x-jan-target-url"
            | "authorization"
            | "x-api-key"
            | "host"
            | "content-length"
            | "connection"
            | "transfer-encoding"
            | "keep-alive"
            | "te"
            | "trailer"
            | "upgrade"
            | "proxy-authorization"
            | "proxy-authenticate"
    )
}

/// Resolve and clone the provider config the client asked for.
async fn provider_config_for(
    app_handle: &AppHandle,
    provider: &str,
) -> Option<ProviderConfig> {
    let configs = provider_configs_from(app_handle);
    let g = configs.lock().await;
    g.get(provider).cloned()
}

/// Shared reqwest client reused across `/api/proxy` requests so HTTP keep-alive
/// and TLS sessions are pooled. TCP/TLS defaults are fine for a LAN-hosted
/// gateway; the upstream is always a user-configured provider.
static PROXY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn proxy_client() -> &'static reqwest::Client {
    PROXY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .build()
            .expect("failed to build proxy reqwest client")
    })
}

/// `OPTIONS` preflight + common response headers for the proxy, so the SPA can
/// use the endpoint cross-origin-free from its own origin.
fn proxy_cors(builder: hyper::http::response::Builder) -> hyper::http::response::Builder {
    builder
        .header("access-control-allow-origin", "sameorigin")
        .header("access-control-allow-headers", "*")
        .header("access-control-allow-methods", "GET, POST, OPTIONS")
}

/// Look up the provider, validate the target URL, and forward the request,
/// streaming the response back. Honours the provider's API-key chain (rotating
/// on 401/403/429) and custom headers, all server-side.
async fn handle_proxy(req: Request<Body>, ctx: &WebCtx) -> Response<Body> {
    let method = req.method().clone();

    // CORS preflight.
    if method == Method::OPTIONS {
        return proxy_cors(Response::builder().status(StatusCode::NO_CONTENT))
            .body(Body::empty())
            .unwrap();
    }

    let provider = req
        .headers()
        .get(H_PROVIDER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let target = req
        .headers()
        .get(H_TARGET)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let (provider, target) = match (provider, target) {
        (Some(p), Some(t)) if !p.is_empty() && !t.is_empty() => (p, t),
        _ => {
            return err_response(
                StatusCode::BAD_REQUEST,
                "Missing x-jan-provider or x-jan-target-url header",
            )
        }
    };

    let config = match provider_config_for(&ctx.app_handle, &provider).await {
        Some(c) => c,
        None => {
            return err_response(
                StatusCode::NOT_FOUND,
                &format!("No configured provider named '{provider}'"),
            )
        }
    };

    // Security: only allow proxying to URLs within this provider's configured
    // base_url. Prevents an authenticated web user from abusing the gateway as
    // an open SSRF relay.
    let base = match config.base_url.as_deref() {
        Some(b) if !b.is_empty() => b.trim_end_matches('/'),
        _ => {
            return err_response(
                StatusCode::BAD_REQUEST,
                &format!("Provider '{provider}' has no base_url configured"),
            )
        }
    };
    if !target.starts_with(base) {
        return err_response(
            StatusCode::FORBIDDEN,
            "Target URL is outside the provider's configured base_url",
        );
    }

    // Capture the client-supplied headers once, before the retry loop. We
    // forward them upstream (minus the control/hop-by-hop/auth headers the
    // proxy owns) so provider-specific SDK headers — e.g. `anthropic-version`,
    // `openai-beta`, `accept` — actually reach the upstream instead of being
    // silently dropped. Config `custom_headers` and the injected auth key are
    // applied AFTER, so they take precedence over anything the client sent.
    let client_headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .filter(|(name, _)| !is_hop_or_control_header(name.as_str()))
        .filter_map(|(name, value)| {
            Some((
                name.as_str().to_string(),
                value.to_str().ok()?.to_string(),
            ))
        })
        .collect();
    // Preserve prior default behaviour: if the client didn't send a
    // content-type, assume JSON (the gateway only serves LLM JSON APIs).
    let has_content_type = client_headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"));

    let body_bytes = match read_body(req).await {
        Ok(b) => b,
        Err(e) => return err_response(StatusCode::BAD_REQUEST, &e),
    };

    let client = proxy_client();
    let key_chain = config.bearer_key_chain();
    let attempts: Vec<Option<String>> = if key_chain.is_empty() {
        vec![None]
    } else {
        key_chain.into_iter().map(Some).collect()
    };

    for (idx, key_opt) in attempts.iter().enumerate() {
        let mut rb = client.request(method.clone(), &target);
        // 1) Forward the client-supplied headers (already filtered).
        for (name, value) in &client_headers {
            rb = rb.header(name.as_str(), value.as_str());
        }
        if !has_content_type {
            rb = rb.header("content-type", "application/json");
        }
        // 2) Apply the provider's configured custom headers on top — these
        //    intentionally override anything the browser sent.
        for h in &config.custom_headers {
            rb = rb.header(h.header.as_str(), h.value.as_str());
        }
        // 3) Inject the auth key last so it wins.
        if let Some(k) = key_opt {
            rb = rb.header("authorization", format!("Bearer {k}"));
        }

        let upstream = match rb.body(body_bytes.clone()).send().await {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("Failed to reach provider {provider}: {e}");
                log::error!("{msg}");
                return err_response(StatusCode::BAD_GATEWAY, &msg);
            }
        };

        let status = upstream.status();

        // Key rotation: drain the error body and retry with the next key.
        if http_status_indicates_api_key_retry(status)
            && idx + 1 < attempts.len()
        {
            let _ = upstream.bytes().await;
            log::warn!(
                "Upstream {status} for provider {provider} on key #{idx}; trying next key"
            );
            continue;
        }

        // Build the response, forwarding status + content-type + SSE hints.
        let mut builder = Response::builder().status(status);
        if let Some(ct) = upstream.headers().get("content-type") {
            builder = builder.header("content-type", ct);
        }
        if status.is_success() {
            // Discourage any intermediary from buffering the stream.
            builder = builder
                .header("cache-control", "no-cache")
                .header("x-accel-buffering", "no");
        }
        builder = proxy_cors(builder);

        // Stream the upstream body straight to the client. `bytes_stream()` works
        // for both SSE (`text/event-stream`) and buffered JSON responses.
        let (mut sender, body) = Body::channel();
        let mut stream = upstream.bytes_stream();
        tokio::spawn(async move {
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(c) => {
                        if sender.send_data(c).await.is_err() {
                            log::debug!("Web proxy client disconnected mid-stream");
                            break;
                        }
                    }
                    Err(e) => {
                        log::error!("Web proxy upstream stream error: {e}");
                        break;
                    }
                }
            }
            log::debug!("Web proxy stream complete");
        });

        return builder.body(body).unwrap();
    }

    // Exhausted all keys.
    err_response(
        StatusCode::UNAUTHORIZED,
        &format!(
            "All configured API keys for provider '{provider}' were rejected"
        ),
    )
}

/// `true` for HTTP statuses that typically mean "try the next API key".
fn http_status_indicates_api_key_retry(status: reqwest::StatusCode) -> bool {
    matches!(
        status.as_u16(),
        401 | 403 | 429
    )
}

// --- Static file serving -----------------------------------------------------

fn serve_static(ui_root: &Path, request_path: &str) -> Response<Body> {
    // Canonicalize the UI root once so the containment check is reliable
    // (otherwise an absolute canonicalized target won't `starts_with` a
    // relative root). If the root doesn't exist (UI not built yet), keep the
    // original path so the not-found branch below fires.
    let root_canon = ui_root.canonicalize().unwrap_or_else(|_| ui_root.to_path_buf());

    // Normalise the request path. We only serve files under the UI root.
    let rel = request_path
        .trim_start_matches('/')
        .split('?')
        .next()
        .unwrap_or("");

    // Resolve the candidate file, enforcing that it stays under the UI root.
    // Anything that isn't a real file falls back to index.html (SPA routing).
    let candidate = if rel.is_empty() || rel == "login" {
        root_canon.join("index.html")
    } else {
        let joined = root_canon.join(rel);
        match joined.canonicalize() {
            Ok(abs) if abs.starts_with(&root_canon) => abs,
            _ => root_canon.join("index.html"),
        }
    };

    // If the precise file doesn't exist, fall back to index.html (SPA).
    let path_to_serve = if candidate.is_file() {
        candidate
    } else {
        let idx = root_canon.join("index.html");
        if !idx.is_file() {
            return err_response(
                StatusCode::NOT_FOUND,
                "Web UI build not found. Build it with `yarn build:webui` and set the web UI path.",
            );
        }
        idx
    };

    let mime = mime_for(&path_to_serve);
    match std::fs::read(&path_to_serve) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, mime)
            .body(Body::from(bytes))
            .unwrap(),
        Err(_) => err_response(StatusCode::NOT_FOUND, "File not found"),
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}
