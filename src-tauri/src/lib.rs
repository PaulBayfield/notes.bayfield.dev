//! Desktop side of Notes.
//!
//! - **Sign-in** reuses Outline's own desktop flow: the server's login page is opened with
//!   `?client=desktop`, and once signed in Outline hands back a one-time transfer token, which we
//!   swap for a session token (valid 3 months) kept in the OS credential store. By default the login
//!   page opens in a window of the app and the token is read from its navigation; signing in through
//!   the system browser instead needs the `outline://` link type, registered only in that case so
//!   the official Outline app keeps it otherwise.
//! - **Live updates** (sidebar, comments) come from Outline's socket, see `realtime.rs`.
//! - **API calls** never see that token in the webview. They go through the `notes://` protocol,
//!   which forwards them to the server with the token attached. This also avoids CORS (Outline's
//!   API doesn't send CORS headers) and lets `<img>` load attachments that need authentication.

mod realtime;
mod shell;

use shell::show_main_window;

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, http};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

const KEYRING_SERVICE: &str = "dev.bayfield.notes";
const KEYRING_USER: &str = "outline-session";
/// Response headers passed back to the webview.
const FORWARDED_RESPONSE_HEADERS: [&str; 7] = [
    "content-type",
    "content-disposition",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
];
/// Request headers passed on to the server.
const FORWARDED_REQUEST_HEADERS: [&str; 4] = ["content-type", "accept", "range", "x-editor-version"];

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    /// e.g. `https://notes.bayfield.dev`, no trailing slash.
    server: String,
    token: String,
}

#[derive(Serialize)]
struct SessionInfo {
    server: String,
}

struct AppState {
    session: RwLock<Option<Session>>,
    /// The server a sign-in is in progress for, until its `outline://` link comes back.
    pending: Mutex<Option<String>>,
    /// Shared so API calls reuse connections.
    client: reqwest::Client,
    /// The live-updates connection, while signed in.
    realtime: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

const LOGIN_WINDOW: &str = "login";

/// (Re)starts the live-updates connection for the current session, or stops it when signed out.
fn restart_realtime(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(mut task) = state.realtime.lock() else { return };
    if let Some(old) = task.take() {
        old.abort();
    }
    if let Some(session) = state.session.read().ok().and_then(|s| s.clone()) {
        *task = Some(tauri::async_runtime::spawn(realtime::run(app.clone(), session.server, session.token)));
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(err)
}

fn load_session() -> Option<Session> {
    let raw = keyring_entry().ok()?.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}

/// `notes.bayfield.dev/` → `https://notes.bayfield.dev`
fn normalize_server(input: &str) -> Result<String, String> {
    let input = input.trim();
    let with_scheme = if input.starts_with("http://") || input.starts_with("https://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| "That doesn't look like a server address".to_string())?;
    if url.host_str().is_none() {
        return Err("That doesn't look like a server address".into());
    }
    Ok(url.origin().ascii_serialization())
}

// ---------- Sign-in ----------

#[tauri::command]
fn session_info(state: tauri::State<AppState>) -> Option<SessionInfo> {
    state
        .session
        .read()
        .ok()?
        .as_ref()
        .map(|s| SessionInfo { server: s.server.clone() })
}

#[derive(Serialize)]
struct ServerConfig {
    server: String,
    /// Outline's public `auth.config`: workspace name, logo and sign-in providers.
    config: serde_json::Value,
}

/// Looks up a server's sign-in options. Runs here because the proxy needs a session first.
#[tauri::command]
async fn auth_config(state: tauri::State<'_, AppState>, server: String) -> Result<ServerConfig, String> {
    let server = normalize_server(&server)?;
    let res = state
        .client
        .post(format!("{server}/api/auth.config"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {server}: {e}"))?;
    let not_outline = || format!("{server} doesn't look like an Outline server");
    if !res.status().is_success() {
        return Err(not_outline());
    }
    let body: serde_json::Value = res.json().await.map_err(|_| not_outline())?;
    Ok(ServerConfig { server, config: body["data"].clone() })
}

fn login_url(server: &str, auth_path: &str) -> Result<url::Url, String> {
    if !auth_path.starts_with("/auth/") {
        return Err("Unexpected sign-in path".into());
    }
    let mut url = url::Url::parse(server).map_err(err)?.join(auth_path).map_err(err)?;
    url.query_pairs_mut().append_pair("client", "desktop");
    Ok(url)
}

/// The transfer token, if this URL is where Outline sends a desktop sign-in once it's done:
/// `https://<server>/desktop-redirect?token=…` or the `outline://<host>/auth/redirect?token=…`
/// link that page opens.
fn transfer_token(url: &url::Url) -> Option<String> {
    let done = (url.scheme().starts_with("http") && url.path() == "/desktop-redirect")
        || (url.scheme() == "outline" && url.path() == "/auth/redirect");
    if !done {
        return None;
    }
    url.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.into_owned())
}

/// Opens the provider's sign-in page in a window of the app. Completion arrives as a
/// `signed-in` or `sign-in-failed` event (with an empty message if the window was closed).
///
/// Async on purpose: creating a window from a synchronous command deadlocks on Windows,
/// leaving a blank window that can't even be closed.
#[tauri::command]
async fn sign_in(app: AppHandle, state: tauri::State<'_, AppState>, server: String, auth_path: String) -> Result<(), String> {
    let server = normalize_server(&server)?;
    let url = login_url(&server, &auth_path)?;
    *state.pending.lock().map_err(err)? = Some(server);
    if let Some(old) = app.get_webview_window(LOGIN_WINDOW) {
        let _ = old.destroy();
    }
    // Set once the token is in hand, so closing the window afterwards isn't a cancellation.
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handle = app.clone();
    let done_nav = done.clone();
    let window = WebviewWindowBuilder::new(&app, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("Sign in")
        .inner_size(480.0, 720.0)
        .center()
        .on_navigation(move |target| {
            let Some(token) = transfer_token(target) else { return true };
            done_nav.store(true, std::sync::atomic::Ordering::SeqCst);
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(window) = handle.get_webview_window(LOGIN_WINDOW) {
                    let _ = window.destroy();
                }
                finish_sign_in(handle, token).await;
            });
            false
        })
        .build()
        .map_err(err)?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) && !done.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = handle.emit("sign-in-failed", "");
        }
    });
    Ok(())
}

/// Same, through the system browser (for providers that refuse embedded windows, like Google).
/// Needs the `outline://` link type, which is registered now.
#[tauri::command]
fn sign_in_with_browser(app: AppHandle, state: tauri::State<AppState>, server: String, auth_path: String) -> Result<(), String> {
    let server = normalize_server(&server)?;
    let url = login_url(&server, &auth_path)?;
    *state.pending.lock().map_err(err)? = Some(server);
    #[cfg(any(windows, target_os = "linux"))]
    app.deep_link().register("outline").map_err(err)?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(err)
}

/// Forgets the session on this device only. (Outline's `auth.delete` would sign the user out
/// everywhere, browser included, so it isn't called.)
#[tauri::command]
fn sign_out(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    *state.session.write().map_err(err)? = None;
    restart_realtime(&app);
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(err(e)),
    }
}

/// Swaps a transfer token for a session token.
async fn exchange_token(app: &AppHandle, token: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let server = state
        .pending
        .lock()
        .map_err(err)?
        .clone()
        .ok_or("No sign-in in progress. Start again from the app.")?;
    let server_url = url::Url::parse(&server).map_err(err)?;

    let mut exchange = server_url.join("/auth/redirect").map_err(err)?;
    exchange.query_pairs_mut().append_pair("token", token);
    // Outline answers with a redirect that sets the `accessToken` cookie: read it, don't follow.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(err)?;
    let res = client.get(exchange).send().await.map_err(err)?;
    let session_token = res
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|cookie| {
            let pair = cookie.split(';').next()?.trim();
            pair.strip_prefix("accessToken=").map(str::to_owned)
        })
        .filter(|t| !t.is_empty())
        .ok_or("Outline didn't accept the sign-in link (it can only be used once and expires quickly). Try again.")?;

    let session = Session { server, token: session_token };
    keyring_entry()?
        .set_password(&serde_json::to_string(&session).map_err(err)?)
        .map_err(err)?;
    *state.session.write().map_err(err)? = Some(session);
    *state.pending.lock().map_err(err)? = None;
    Ok(())
}

async fn finish_sign_in(app: AppHandle, token: String) {
    match exchange_token(&app, &token).await {
        Ok(()) => {
            restart_realtime(&app);
            let _ = app.emit("signed-in", ());
        }
        Err(e) => {
            let _ = app.emit("sign-in-failed", e);
        }
    }
    show_main_window(&app);
}

/// An `outline://` link from the browser sign-in, given as a launch argument.
fn handle_args(app: &AppHandle, args: &[String]) {
    for arg in args {
        let Ok(link) = url::Url::parse(arg) else { continue };
        let Some(token) = transfer_token(&link) else { continue };
        let app = app.clone();
        tauri::async_runtime::spawn(async move { finish_sign_in(app, token).await });
    }
}

// ---------- Files ----------

/// Runs `f` on the UI thread and waits for its result.
#[cfg(windows)]
fn on_main_thread<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv().ok()
}

/// Shows a system dialog with the mouse pointer visible.
///
/// Windows hides the pointer while you type in the webview, and the dialog runs on the same UI
/// thread, so one opened from the keyboard (the editor's /image command) kept it hidden: the
/// pointer was invisible over the dialog. It's shown for the dialog, then put back as it was.
fn with_visible_cursor<T>(app: &AppHandle, show: impl FnOnce() -> T) -> T {
    #[cfg(windows)]
    let shown = on_main_thread(app, || {
        use windows_sys::Win32::UI::WindowsAndMessaging::{LoadCursorW, SetCursor, ShowCursor, IDC_ARROW};
        let mut shown = 0;
        // ShowCursor counts: the pointer shows once the count is back at zero or more.
        while shown < 32 {
            shown += 1;
            if unsafe { ShowCursor(1) } >= 0 {
                break;
            }
        }
        unsafe { SetCursor(LoadCursorW(std::ptr::null_mut(), IDC_ARROW)) };
        shown
    })
    .unwrap_or(0);
    #[cfg(not(windows))]
    let _ = app;
    let out = show();
    #[cfg(windows)]
    on_main_thread(app, move || {
        for _ in 0..shown {
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::ShowCursor(0) };
        }
    });
    out
}

/// Asks where to save a file, then writes it. Returns false if the user cancelled.
#[tauri::command]
async fn save_file(app: AppHandle, name: String, contents: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app.dialog().file().set_file_name(&name);
    let Some(path) = with_visible_cursor(&app, || dialog.blocking_save_file()) else {
        return Ok(false);
    };
    let path = path.into_path().map_err(err)?;
    std::fs::write(path, contents).map_err(err)?;
    Ok(true)
}

/// Calls an API method and saves its answer as a file (exports): the request first, so a zip
/// answer can be named `.zip`, then the save dialog. `accept` picks the format where the method
/// offers several. Redirects are followed, so `fileOperations.redirect` lands on the file itself.
/// Returns false if the user cancelled.
#[tauri::command]
async fn download(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    method: String,
    body: serde_json::Value,
    name: String,
    accept: Option<String>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    if !method.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') {
        return Err("Unexpected API method".into());
    }
    let session = state.session.read().map_err(err)?.clone().ok_or("Signed out")?;
    let mut req = state
        .client
        .post(format!("{}/api/{method}", session.server))
        .bearer_auth(&session.token)
        .json(&body);
    if let Some(accept) = accept {
        req = req.header("accept", accept);
    }
    let res = req.send().await.map_err(|e| format!("Couldn't reach the server: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body: serde_json::Value = res.json().await.unwrap_or_default();
        return Err(body["message"].as_str().map(str::to_owned).unwrap_or_else(|| format!("Download failed ({status})")));
    }
    let zip = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.contains("zip"));
    let bytes = res.bytes().await.map_err(|e| format!("Download failed: {e}"))?;
    // A TextBundle (.textpack) is a zip already.
    let name = if zip && !name.ends_with(".zip") && !name.ends_with(".textpack") {
        let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&name);
        format!("{stem}.zip")
    } else {
        name
    };
    let mut dialog = app.dialog().file().set_file_name(&name);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(path) = with_visible_cursor(&app, || dialog.blocking_save_file()) else {
        return Ok(false);
    };
    let path = path.into_path().map_err(err)?;
    tokio::fs::write(path, &bytes).await.map_err(err)?;
    Ok(true)
}

/// Asks for files to attach. Returns their paths (empty if cancelled).
///
/// The webview's own file picker isn't used: in this frameless window it can open out of sight
/// and leave the app waiting on it.
#[tauri::command]
async fn pick_files(app: AppHandle, images: bool) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    if images {
        dialog = dialog.add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);
    }
    with_visible_cursor(&app, || dialog.blocking_pick_files())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    id: String,
    url: String,
    name: String,
    size: u64,
    content_type: String,
}

fn content_type_of(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Creates an attachment and uploads its contents, the way Outline's editor does. `preset` is
/// Outline's attachment kind ("documentAttachment", "avatar", "emoji"); only document
/// attachments belong to a document.
///
/// Done here rather than with `fetch` through the `notes://` protocol because WebView2 doesn't
/// pass file bodies (multipart forms) on to custom protocols, so uploads arrived empty.
async fn upload(state: &AppState, document_id: &str, preset: &str, name: &str, content_type: &str, bytes: Vec<u8>) -> Result<Attachment, String> {
    let session = state.session.read().map_err(err)?.clone().ok_or("Signed out")?;
    let size = bytes.len() as u64;
    let mut body = serde_json::json!({
        "name": name,
        "contentType": content_type,
        "size": size,
        "preset": if preset.is_empty() { "documentAttachment" } else { preset },
    });
    if !document_id.is_empty() {
        body["documentId"] = document_id.into();
    }
    let res = state
        .client
        .post(format!("{}/api/attachments.create", session.server))
        .bearer_auth(&session.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the server: {e}"))?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(body["message"].as_str().map(str::to_owned).unwrap_or_else(|| format!("Upload failed ({status})")));
    }
    let data = &body["data"];
    let upload_url = data["uploadUrl"].as_str().ok_or("The server didn't say where to upload the file")?;
    // Local storage: an API path on the server, which needs the session. S3 and the like: a signed URL.
    let (target, ours) = if upload_url.starts_with('/') {
        (format!("{}{upload_url}", session.server), true)
    } else {
        (upload_url.to_owned(), upload_url.starts_with(&format!("{}/", session.server)))
    };

    let mut form = reqwest::multipart::Form::new();
    if let Some(fields) = data["form"].as_object() {
        for (key, value) in fields {
            let value = value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string());
            form = form.text(key.clone(), value);
        }
    }
    let part = reqwest::multipart::Part::bytes(bytes).file_name(name.to_owned());
    let part = match part.mime_str(content_type) {
        Ok(p) => p,
        Err(_) => return Err("Unsupported file type".into()),
    };
    // The file goes last: S3 ignores fields after it.
    form = form.part("file", part);
    let mut req = state.client.post(target).multipart(form);
    if ours {
        req = req.bearer_auth(&session.token);
    }
    let res = req.send().await.map_err(|e| format!("Upload failed: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body: serde_json::Value = res.json().await.unwrap_or_default();
        return Err(body["message"].as_str().map(str::to_owned).unwrap_or_else(|| format!("Upload failed ({status})")));
    }

    let a = &data["attachment"];
    let text = |v: &serde_json::Value| v.as_str().unwrap_or_default().to_owned();
    Ok(Attachment {
        id: text(&a["id"]),
        url: text(&a["url"]),
        name: a["name"].as_str().unwrap_or(name).to_owned(),
        size: a["size"].as_u64().unwrap_or(size),
        content_type: content_type.to_owned(),
    })
}

/// Uploads a file picked with `pick_files`.
#[tauri::command]
async fn upload_file(state: tauri::State<'_, AppState>, document_id: Option<String>, path: String, preset: Option<String>) -> Result<Attachment, String> {
    let path = std::path::PathBuf::from(path);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("Couldn't read {name}: {e}"))?;
    let document_id = document_id.unwrap_or_default();
    upload(&state, &document_id, preset.as_deref().unwrap_or_default(), &name, content_type_of(&name), bytes).await
}

/// Uploads a pasted, dropped or chosen file. The body is its raw bytes; `x-document-id`,
/// `x-preset`, `x-file-name` (URI-encoded) and `x-content-type` describe it.
#[tauri::command]
async fn upload_bytes(state: tauri::State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<Attachment, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's contents".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let document_id = header("x-document-id");
    let name = url::form_urlencoded::parse(format!("n={}", header("x-file-name")).as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "file".into());
    let given = header("x-content-type");
    let content_type = if given.is_empty() { content_type_of(&name).to_owned() } else { given };
    let bytes = bytes.clone();
    upload(&state, &document_id, &header("x-preset"), &name, &content_type, bytes).await
}

// ---------- API proxy (notes:// protocol) ----------

fn with_cors(builder: http::response::Builder) -> http::response::Builder {
    builder
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", FORWARDED_REQUEST_HEADERS.join(", "))
        .header("Access-Control-Expose-Headers", "content-disposition, content-range")
}

fn text_response(status: u16, message: &str) -> http::Response<Vec<u8>> {
    with_cors(http::Response::builder().status(status))
        .header("content-type", "application/json")
        .body(serde_json::json!({ "ok": false, "status": status, "message": message }).to_string().into_bytes())
        .unwrap_or_default()
}

async fn proxy(app: AppHandle, request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    if request.method() == http::Method::OPTIONS {
        return with_cors(http::Response::builder().status(204)).body(Vec::new()).unwrap_or_default();
    }
    let state = app.state::<AppState>();
    let Some(session) = state.session.read().ok().and_then(|s| s.clone()) else {
        return text_response(401, "Signed out");
    };
    let path = request.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    // Only the API (which includes file downloads) gets the token.
    if !path.starts_with("/api/") {
        return text_response(404, "Not found");
    }
    let Ok(method) = reqwest::Method::from_bytes(request.method().as_str().as_bytes()) else {
        return text_response(405, "Method not allowed");
    };

    let mut req = state
        .client
        .request(method, format!("{}{}", session.server, path))
        .bearer_auth(&session.token);
    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(value) = request.headers().get(name) {
            req = req.header(name, value.as_bytes());
        }
    }
    let body = request.into_body();
    if !body.is_empty() {
        req = req.body(body);
    }

    match req.send().await {
        Ok(res) => {
            let mut builder = http::Response::builder().status(res.status().as_u16());
            for name in FORWARDED_RESPONSE_HEADERS {
                if let Some(value) = res.headers().get(name) {
                    builder = builder.header(name, value.as_bytes());
                }
            }
            match res.bytes().await {
                Ok(bytes) => with_cors(builder).body(bytes.to_vec()).unwrap_or_default(),
                Err(e) => text_response(502, &e.to_string()),
            }
        }
        Err(e) => text_response(502, &format!("Couldn't reach the server: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must come first. A second launch (or an `outline://` link) goes to the running app.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main_window(app);
            handle_args(app, &args);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Size and position are restored, visibility isn't: the shell decides whether to show it.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![shell::AUTOSTART_ARG]),
        ))
        .manage(AppState {
            session: RwLock::new(load_session()),
            pending: Mutex::new(None),
            client: reqwest::Client::new(),
            realtime: Mutex::new(None),
        })
        .register_asynchronous_uri_scheme_protocol("notes", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(proxy(app, request).await);
            });
        })
        .setup(|app| {
            shell::setup(app)?;
            let handle = app.handle().clone();
            restart_realtime(&handle);
            // Launched by an `outline://` link while not running.
            handle_args(&handle, &std::env::args().collect::<Vec<_>>());
            Ok(())
        })
        .on_window_event(shell::on_window_event)
        .invoke_handler(tauri::generate_handler![
            session_info,
            auth_config,
            sign_in,
            sign_in_with_browser,
            sign_out,
            save_file,
            download,
            pick_files,
            upload_file,
            upload_bytes,
            shell::set_close_to_tray,
            shell::set_start_minimized,
            shell::set_tray_labels,
            shell::set_tray_docs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
