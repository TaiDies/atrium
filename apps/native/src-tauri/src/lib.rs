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

const SESSION_COOKIE: &str = "atrium_session";

/// The app's identifier before 1.9.0. Its saved data is copied over on the first launch after the rename.
#[cfg(desktop)]
const OLD_IDENTIFIER: &str = "com.selfhosted.workspace";

/// Copies a folder and everything in it (best effort: files that can't be read are skipped).
#[cfg(desktop)]
fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    let Ok(entries) = fs::read_dir(from) else { return };
    let _ = fs::create_dir_all(to);
    for entry in entries.flatten() {
        let target = to.join(entry.file_name());
        match entry.file_type() {
            Ok(t) if t.is_dir() => copy_dir(&entry.path(), &target),
            Ok(_) => {
                let _ = fs::copy(entry.path(), target);
            }
            Err(_) => {}
        }
    }
}

/// On the first launch after the identifier changed, brings over the chosen server, the session and
/// everything the page kept on the device (settings, offline copies, changes waiting to be sent).
#[cfg(desktop)]
fn move_old_data(app: &AppHandle) {
    let dirs = [app.path().app_data_dir(), app.path().app_local_data_dir()];
    for dir in dirs.into_iter().flatten() {
        let Some(old) = dir.parent().map(|p| p.join(OLD_IDENTIFIER)) else { continue };
        if old.is_dir() && !dir.exists() {
            copy_dir(&old, &dir);
        }
    }
}

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
    /// Whether the keychain holds the session; when writing it there failed, it stays in the file.
    in_keychain: Mutex<bool>,
}

impl AppState {
    fn get(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    fn update(&self, change: impl FnOnce(&mut Settings)) {
        let mut s = self.settings.lock().unwrap();
        let before = s.token.clone();
        change(&mut s);
        let mut in_keychain = self.in_keychain.lock().unwrap();
        if s.token != before {
            *in_keychain = secret::save(s.token.as_deref());
        }
        save_settings(&self.file, &s, *in_keychain);
    }
}

/// What the settings file keeps of the session: nothing when the keychain holds it, the token otherwise.
fn token_on_disk(token: Option<String>, in_keychain: bool) -> Option<String> {
    if in_keychain {
        None
    } else {
        token
    }
}

/// Writes the settings file, leaving the session out when the OS keychain holds it.
fn save_settings(file: &PathBuf, s: &Settings, in_keychain: bool) {
    let mut on_disk = s.clone();
    on_disk.token = token_on_disk(on_disk.token, in_keychain);
    if let Ok(json) = serde_json::to_vec_pretty(&on_disk) {
        let _ = fs::write(file, json);
    }
}

#[cfg(test)]
mod tests {
    use super::token_on_disk;

    #[test]
    fn keeps_the_token_in_the_file_when_the_keychain_failed() {
        assert_eq!(token_on_disk(Some("t".into()), false), Some("t".into()));
        assert_eq!(token_on_disk(Some("t".into()), true), None);
        assert_eq!(token_on_disk(None, false), None);
    }
}

/// The session token in the OS keychain where there is one (Windows, macOS). Elsewhere (Android, Linux)
/// it stays in the app's private settings file, which only the app can read.
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod secret {
    pub const AVAILABLE: bool = true;
    fn entry() -> Option<keyring::Entry> {
        keyring::Entry::new("io.github.taidies.atrium", "session").ok()
    }
    pub fn load() -> Option<String> {
        entry()?.get_password().ok().filter(|t| !t.is_empty())
    }
    /// Stores (or, with None, removes) the session; false when the keychain couldn't be written.
    pub fn save(token: Option<&str>) -> bool {
        let Some(e) = entry() else { return false };
        match token {
            Some(t) if !t.is_empty() => e.set_password(t).is_ok(),
            _ => !matches!(e.delete_credential(), Err(err) if !matches!(err, keyring::Error::NoEntry)),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod secret {
    pub const AVAILABLE: bool = false;
    pub fn load() -> Option<String> {
        None
    }
    pub fn save(_token: Option<&str>) -> bool {
        false
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

/// Adds the content security policy from tauri.conf.json (with the hashes of the page's own inline
/// script) to the app's pages, so the page can't run scripts from anywhere else.
fn with_csp(mut res: Response<Vec<u8>>, csp: Option<String>) -> Response<Vec<u8>> {
    if let Some(value) = csp.and_then(|c| HeaderValue::from_str(&c).ok()) {
        res.headers_mut().insert(header::CONTENT_SECURITY_POLICY, value);
    }
    res
}

/// The built-in web app (any other path is a page of the app, so it gets index.html).
fn asset(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let resolver = app.asset_resolver();
    let wanted = path.trim_start_matches('/');
    let wanted = if wanted.is_empty() { "index.html" } else { wanted };
    if let Some(a) = resolver.get(wanted.to_string()) {
        return with_csp(respond(StatusCode::OK, &a.mime_type, a.bytes), a.csp_header);
    }
    let last = wanted.rsplit('/').next().unwrap_or("");
    if !last.contains('.') {
        if let Some(a) = resolver.get("index.html".to_string()) {
            return with_csp(respond(StatusCode::OK, &a.mime_type, a.bytes), a.csp_header);
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
            // The session token stays here: the page only gets a live-editing ticket from the server.
            json(serde_json::json!({
                "server": s.server,
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

/// A newer version of the Windows app, if the latest GitHub release has one.
#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[cfg(desktop)]
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

/// Downloads the update, checks its signature and installs it; the app closes and opens again.
#[cfg(desktop)]
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Ok(()) };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

// Android's app updates come from wherever it was installed from.
#[cfg(mobile)]
#[tauri::command]
async fn check_update() -> Result<Option<UpdateInfo>, String> {
    Ok(None)
}
#[cfg(mobile)]
#[tauri::command]
async fn install_update() -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        // Notifications from the system (new messages, meeting invitations…), shown by the page.
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![api, check_update, install_update])
        .register_asynchronous_uri_scheme_protocol("app", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(handle(app, request).await);
            });
        })
        .setup(|app| {
            #[cfg(desktop)]
            move_old_data(app.handle());
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let file = dir.join("settings.json");
            let mut settings: Settings = fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            // Older versions kept the session in the settings file: move it into the keychain. If that
            // fails it stays in the file, and moving it is tried again next launch.
            let mut in_keychain = false;
            if secret::AVAILABLE {
                if let Some(token) = settings.token.clone().filter(|t| !t.is_empty()) {
                    in_keychain = secret::save(Some(&token));
                    if in_keychain {
                        save_settings(&file, &settings, true);
                    }
                } else {
                    settings.token = secret::load();
                    in_keychain = true;
                }
            }
            let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(6)).build()?;
            app.manage(AppState { settings: Mutex::new(settings), file, client, in_keychain: Mutex::new(in_keychain) });

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
