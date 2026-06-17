//! Web UI HTTP server.
//!
//! A self-contained hyper server that runs inside the Tauri process alongside
//! the desktop GUI. It serves:
//!   * the static web UI build (with SPA fallback to `index.html`),
//!   * `POST /api/invoke` — a JSON dispatch endpoint that mirrors Tauri's
//!     `invoke()` model and reuses the existing command implementations,
//!   * `POST /api/auth/login` | `logout` | `GET /api/auth/check` — the
//!     single-password gate.
//!
//! Inference is not proxied: the web UI calls the user's OpenAI-compatible
//! provider (e.g. a LAN llama.cpp server) directly via the provider's
//! `base_url`, exactly like the desktop app does.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
use crate::core::state::AppState;
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
        "listProviderConfigs" => {
            let configs = provider_configs_from(app_handle);
            let g = configs.lock().await;
            Ok(json!(g.values().cloned().collect::<Vec<_>>()))
        }
        "getProviderConfig" => {
            let provider = arg_str(args, &["provider"])?;
            let configs = provider_configs_from(app_handle);
            let g = configs.lock().await;
            Ok(json!(g.get(&provider).cloned()))
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
            let request: crate::core::server::remote_provider_commands::RegisterProviderRequest =
                serde_json::from_value(normalized)
                    .map_err(|e| format!("Invalid provider config: {e}"))?;
            register_provider_config_inner(app_handle, request).await?;
            Ok(json!({}))
        }
        "unregisterProviderConfig" => {
            let provider = arg_str(args, &["provider"])?;
            let configs = provider_configs_from(app_handle);
            configs.lock().await.remove(&provider);
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

/// Inlined body of `register_provider_config` (lives behind a `State<AppState>`
/// in the Tauri command, which is awkward to reconstruct here).
async fn register_provider_config_inner(
    app_handle: &AppHandle,
    request: crate::core::server::remote_provider_commands::RegisterProviderRequest,
) -> Result<(), String> {
    use crate::core::server::remote_provider_commands::merge_register_api_keys;
    use crate::core::state::{ProviderConfig, ProviderCustomHeader};

    let configs = provider_configs_from(app_handle);
    let mut g = configs.lock().await;

    let key_chain = merge_register_api_keys(request.api_key.clone(), request.api_keys.clone());
    let api_key = key_chain.first().cloned();

    let config = ProviderConfig {
        provider: request.provider.clone(),
        api_key,
        api_keys: key_chain,
        base_url: request.base_url,
        custom_headers: request
            .custom_headers
            .into_iter()
            .map(|h| ProviderCustomHeader {
                header: h.header,
                value: h.value,
            })
            .collect(),
        models: request.models,
    };

    g.insert(request.provider.clone(), config);
    Ok(())
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
