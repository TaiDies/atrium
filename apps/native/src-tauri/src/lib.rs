//! The Windows and Android apps.
//!
//! The web app is built into the app and served from the `app` scheme (`http://app.localhost/`), so
//! it opens without a connection. Requests to `/api/...` are passed on to the server the person chose,
//! with their session attached, so the web app works exactly as it does in a browser. When the server
//! can't be reached, the reply carries `x-offline: 1` and the web app keeps working from what it has
//! saved on the device, sending changes once the server is back.
//!
//! `/__app/info` and `/__app/server` let the web app see and change the chosen server.
//!
//! Android's WebView doesn't hand request bodies to the scheme, so the web app sends any request that
//! has a body through the `api` command instead (see web/src/lib/native.ts); it ends up in the same
//! place.

use std::{fs, path::PathBuf, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{
    http::{header, HeaderValue, Method, Request, Response, StatusCode},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};

const SESSION_COOKIE: &str = "af_session";

/// What the app remembers between launches.
#[derive(Default, Clone, Serialize, Deserialize)]
struct Settings {
    /// The chosen server, e.g. "http://192.168.1.20:3000".
    server: Option<String>,
    /// The session the server gave when signing in.
    token: Option<String>,
}

struct AppState {
    settings: Mutex<Settings>,
    file: PathBuf,
    client: reqwest::Client,
}

impl AppState {
    fn get(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    fn update(&self, change: impl FnOnce(&mut Settings)) {
        let mut s = self.settings.lock().unwrap();
        change(&mut s);
        if let Ok(json) = serde_json::to_vec_pretty(&*s) {
            let _ = fs::write(&self.file, json);
        }
    }
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap()
}

fn json(value: serde_json::Value) -> Response<Vec<u8>> {
    respond(StatusCode::OK, "application/json", value.to_string().into_bytes())
}

/// The reply for "the server can't be reached"; the web app switches to working offline.
fn offline() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-offline", "1")
        .body(br#"{"error":"You're offline"}"#.to_vec())
        .unwrap()
}

fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        std::env::consts::OS
    }
}

/// Makes "192.168.1.20:3000/" into "http://192.168.1.20:3000".
fn normalise(server: &str) -> Option<String> {
    let s = server.trim().trim_end_matches('/');
    let with_scheme = if s.starts_with("http://") || s.starts_with("https://") { s.to_string() } else { format!("http://{s}") };
    let url = Url::parse(&with_scheme).ok()?;
    url.host_str()?;
    Some(with_scheme)
}

/// Checks that an address is one of our servers before using it.
async fn check_server(client: &reqwest::Client, server: &str) -> Result<String, String> {
    let res = client
        .get(format!("{server}/api/server/info"))
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| "Couldn't reach that address. Check it and that the server is running.".to_string())?;
    let info: serde_json::Value = res.json().await.map_err(|_| "That address isn't a workspace server.".to_string())?;
    if info.get("app").and_then(|v| v.as_str()) != Some("atrium") {
        return Err("That address isn't a workspace server.".into());
    }
    Ok(info.get("name").and_then(|v| v.as_str()).unwrap_or("Atrium").to_string())
}

/// The session in a Set-Cookie header: Some(token), Some("") when signing out, None if unrelated.
fn session_from_cookie(value: &str) -> Option<String> {
    let first = value.split(';').next()?.trim();
    let (name, token) = first.split_once('=')?;
    if name.trim() != SESSION_COOKIE {
        return None;
    }
    let expired = value.to_ascii_lowercase().contains("max-age=0") || value.contains("1970");
    Some(if expired { String::new() } else { token.trim().to_string() })
}

/// Request headers passed on to the server.
const FORWARDED: [&str; 6] = ["content-type", "accept", "range", "if-none-match", "if-modified-since", "accept-language"];

/// Passes a request on to the chosen server.
async fn proxy(state: &AppState, method: &str, path_and_query: &str, headers: &[(String, String)], body: Vec<u8>) -> Response<Vec<u8>> {
    let settings = state.get();
    let Some(server) = settings.server else { return offline() };
    let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut outgoing = state.client.request(method, format!("{server}{path_and_query}"));
    for (name, value) in headers {
        if FORWARDED.contains(&name.to_ascii_lowercase().as_str()) {
            outgoing = outgoing.header(name, value);
        }
    }
    if let Some(token) = settings.token.filter(|t| !t.is_empty()) {
        outgoing = outgoing.header("cookie", format!("{SESSION_COOKIE}={token}"));
    }
    let res = match outgoing.body(body).send().await {
        Ok(r) => r,
        Err(_) => return offline(),
    };

    // Keep (or drop) the session the server hands out when signing in or out.
    for value in res.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()) {
        if let Some(token) = session_from_cookie(value) {
            state.update(|s| s.token = if token.is_empty() { None } else { Some(token) });
        }
    }

    let mut builder = Response::builder().status(res.status().as_u16());
    for (name, value) in res.headers() {
        let n = name.as_str();
        if matches!(n, "set-cookie" | "transfer-encoding" | "connection" | "content-length") {
            continue;
        }
        if let Ok(v) = HeaderValue::from_bytes(value.as_bytes()) {
            builder = builder.header(n, v);
        }
    }
    match res.bytes().await {
        Ok(body) => builder.body(body.to_vec()).unwrap(),
        Err(_) => offline(),
    }
}

/// The built-in web app (any other path is a page of the app, so it gets index.html).
fn asset(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let resolver = app.asset_resolver();
    let wanted = path.trim_start_matches('/');
    let wanted = if wanted.is_empty() { "index.html" } else { wanted };
    if let Some(a) = resolver.get(wanted.to_string()) {
        return respond(StatusCode::OK, &a.mime_type, a.bytes);
    }
    let last = wanted.rsplit('/').next().unwrap_or("");
    if !last.contains('.') {
        if let Some(a) = resolver.get("index.html".to_string()) {
            return respond(StatusCode::OK, &a.mime_type, a.bytes);
        }
    }
    respond(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec())
}

/// Answers a request from the web app, whichever way it arrived.
async fn handle(app: AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let state = app.state::<AppState>();
    let path = req.uri().path().to_string();
    match (req.method().clone(), path.as_str()) {
        (_, "/__app/info") => {
            let s = state.get();
            json(serde_json::json!({
                "server": s.server,
                "token": s.token,
                "platform": platform(),
                "version": app.package_info().version.to_string(),
            }))
        }
        (Method::POST, "/__app/server") => {
            let body: serde_json::Value = serde_json::from_slice(req.body()).unwrap_or_default();
            let Some(server) = body.get("server").and_then(|v| v.as_str()).and_then(normalise) else {
                return json(serde_json::json!({ "ok": false, "error": "Enter the server's address, e.g. 192.168.1.20:3000" }));
            };
            match check_server(&state.client, &server).await {
                Ok(name) => {
                    state.update(|s| {
                        s.server = Some(server.clone());
                        s.token = None;
                    });
                    json(serde_json::json!({ "ok": true, "name": name }))
                }
                Err(error) => json(serde_json::json!({ "ok": false, "error": error })),
            }
        }
        (Method::DELETE, "/__app/server") => {
            state.update(|s| *s = Settings::default());
            json(serde_json::json!({ "ok": true }))
        }
        (_, p) if p == "/api" || p.starts_with("/api/") => {
            let path_and_query = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/").to_string();
            let headers: Vec<(String, String)> = req
                .headers()
                .iter()
                .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
                .collect();
            let method = req.method().as_str().to_string();
            proxy(&state, &method, &path_and_query, &headers, req.into_body()).await
        }
        _ => asset(&app, &path),
    }
}

/// A request with a body, sent by the web app over IPC. The method, path and content type come as
/// `x-method`, `x-path` and `x-content-type` headers and the body as raw bytes. The reply is raw
/// bytes too: a 4-byte length, then JSON `{status, headers}`, then the body.
#[tauri::command]
async fn api(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let method = header("x-method").unwrap_or_else(|| "POST".into());
    let path = header("x-path").ok_or("missing x-path")?;
    let mut builder = Request::builder().method(method.as_str()).uri(path.as_str());
    if let Some(ct) = header("x-content-type") {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        // Android's IPC sends bytes as a JSON array of numbers.
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(items)) => items.iter().map(|n| n.as_u64().unwrap_or(0) as u8).collect(),
        tauri::ipc::InvokeBody::Json(v) => serde_json::to_vec(v).unwrap_or_default(),
    };
    let req = builder.body(body).map_err(|e| e.to_string())?;
    let res = handle(app, req).await;

    let headers: Vec<(String, String)> = res
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect();
    let meta = serde_json::to_vec(&serde_json::json!({ "status": res.status().as_u16(), "headers": headers })).unwrap_or_default();
    let mut out = Vec::with_capacity(4 + meta.len() + res.body().len());
    out.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(res.body());
    Ok(tauri::ipc::Response::new(out))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Notifications from the system (new messages, meeting invitations…), shown by the page.
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![api])
        .register_asynchronous_uri_scheme_protocol("app", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(handle(app, request).await);
            });
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let file = dir.join("settings.json");
            let settings: Settings = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(6)).build()?;
            app.manage(AppState { settings: Mutex::new(settings), file, client });

            let url = WebviewUrl::CustomProtocol(Url::parse("app://localhost/").unwrap());
            let builder = WebviewWindowBuilder::new(app, "main", url);
            #[cfg(desktop)]
            let builder = builder.title("Atrium").inner_size(1280.0, 820.0).min_inner_size(380.0, 520.0);
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
