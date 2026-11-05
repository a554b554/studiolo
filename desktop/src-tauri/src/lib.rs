// Studiolo desktop client. The window shows a server's own web UI, the same
// front end as the browser; the bundled launcher page only lists and probes servers. Rust adds
// what a browser tab cannot: tray, autostart, one instance, notifications, native recording
// for voice input and one-click updates.
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

mod recorder;
use recorder::Recorder;

static WINDOWS: AtomicU32 = AtomicU32::new(0);

// WebView2 offers the microphone (voice input, public/dictation.js) only to secure origins, and a
// server reached over the tailnet is plain http. Its flags are fixed when the client starts and name
// exact origins only (wildcards are ignored), so the launcher hands over its server list
// (trust_origins) and the client restarts once when a server is new. macOS ignores these flags.
struct Trusted(BTreeSet<String>);

fn trusted_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("trusted-origins.txt"))
}

// The origin of a plain-http server other than this computer (127.0.0.1 is secure already).
fn insecure_origin(url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    (url.scheme() == "http" && !local).then(|| url.origin().ascii_serialization())
}

fn read_trusted(app: &AppHandle) -> BTreeSet<String> {
    let text = trusted_file(app).and_then(|file| std::fs::read_to_string(file).ok()).unwrap_or_default();
    text.lines().filter_map(insecure_origin).collect()
}

fn browser_args(trusted: &BTreeSet<String>) -> String {
    // wry's defaults, which a custom value replaces.
    let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    if !trusted.is_empty() {
        args.push_str(" --unsafely-treat-insecure-origin-as-secure=");
        args.push_str(&trusted.iter().cloned().collect::<Vec<_>>().join(","));
    }
    args
}

// Links open in the default browser. Settings → 版本 can keep Studiolo pages (an Artifact window, a
// page of another server) in windows of this client instead (set_link_mode): those of the server the
// main window shows and of every server the launcher or a page names (known_servers). The opener
// plugin's own link script is off: it would hand every target=_blank click to open_url, which server
// pages may not call, and nothing opened.
#[derive(Default)]
struct Links {
    servers: Mutex<BTreeSet<String>>,
    client: AtomicBool,
}

fn links_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("open-in-client"))
}

fn studiolo_page(app: &AppHandle, url: &Url) -> bool {
    let origin = url.origin().ascii_serialization();
    let shown = main_window(app).and_then(|w| w.url().ok()).map(|u| u.origin().ascii_serialization());
    shown.as_deref() == Some(origin.as_str()) || app.state::<Links>().servers.lock().unwrap().contains(&origin)
}

fn remember(links: &Links, origins: &[String]) {
    let mut servers = links.servers.lock().unwrap();
    for origin in origins.iter().filter_map(|o| Url::parse(o).ok()) {
        if matches!(origin.scheme(), "http" | "https") {
            servers.insert(origin.origin().ascii_serialization());
        }
    }
}

#[tauri::command]
fn known_servers(links: State<Links>, origins: Vec<String>) {
    remember(&links, &origins);
}

// True: Studiolo pages open in the default browser (the default).
#[tauri::command]
fn link_mode(links: State<Links>) -> bool {
    !links.client.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_link_mode(app: AppHandle, links: State<Links>, browser: bool) -> Result<(), String> {
    let file = links_file(&app).ok_or("no config folder")?;
    if !browser {
        file.parent().map(std::fs::create_dir_all).transpose().map_err(|e| e.to_string())?;
        std::fs::write(&file, "").map_err(|e| e.to_string())?;
    } else if file.exists() {
        std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    links.client.store(!browser, Ordering::Relaxed);
    Ok(())
}

// A link the page opens after an await (an Artifact window with a sign-in ticket, which the page
// fetches first): window.open would have lost the click by then. Async: Windows deadlocks when a
// synchronous command builds a window.
#[tauri::command]
async fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("not a web address".into());
    }
    if studiolo_page(&app, &url) && app.state::<Links>().client.load(Ordering::Relaxed) {
        let handle = app.clone();
        let label = format!("view-{}", WINDOWS.fetch_add(1, Ordering::Relaxed));
        WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
            .title("Studiolo")
            .inner_size(1200.0, 800.0)
            .disable_drag_drop_handler()
            .on_document_title_changed(|window, title| {
                let _ = window.set_title(&title);
            })
            .on_new_window(move |url, features| new_window(&handle, url, features))
            .build()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())
}

// Returns false when every origin is trusted already; otherwise saves them and restarts the client.
#[tauri::command]
fn trust_origins(app: AppHandle, trusted: State<Trusted>, links: State<Links>, origins: Vec<String>) -> bool {
    remember(&links, &origins);
    let wanted: BTreeSet<String> = origins.iter().filter_map(|o| insecure_origin(o)).collect();
    if !cfg!(windows) || wanted.is_subset(&trusted.0) {
        return false;
    }
    let all: Vec<String> = trusted.0.union(&wanted).cloned().collect();
    let Some(file) = trusted_file(&app) else { return false };
    let saved = file.parent().map_or(false, |dir| std::fs::create_dir_all(dir).is_ok())
        && std::fs::write(&file, all.join("\n")).is_ok();
    if !saved {
        return false;
    }
    app.restart()
}

// Voice input where the page has no getUserMedia (recorder.rs). Async, so a microphone permission
// prompt never blocks the main thread.
#[tauri::command]
async fn start_recording(recorder: State<'_, Recorder>) -> Result<(), String> {
    recorder.start()
}

// Live dictation: audio frames stream to the page while it records; cancel_recording stops them.
#[tauri::command]
async fn start_streaming(recorder: State<'_, Recorder>, on_audio: tauri::ipc::Channel<serde_json::Value>) -> Result<(), String> {
    recorder.stream(move |pcm, levels| {
        let _ = on_audio.send(serde_json::json!({ "pcm": pcm, "levels": levels }));
    })
}

#[tauri::command]
async fn stop_recording(recorder: State<'_, Recorder>) -> Result<tauri::ipc::Response, String> {
    recorder.stop().map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn cancel_recording(recorder: State<'_, Recorder>) -> Result<(), String> {
    recorder.cancel();
    Ok(())
}

// The build number within the client's version (build.rs): a version stays open while it gains
// features, so Settings → 版本 compares builds too.
const BUILD: u32 = match u32::from_str_radix(env!("STUDIOLO_BUILD"), 10) { Ok(n) => n, Err(_) => 0 };

#[tauri::command]
fn client_build() -> u32 {
    BUILD
}

// One-click update (Settings → 版本). The server this window shows offers the signed installer of
// its client release (GET /api/client/update/…, src/client-update.mjs); the updater checks it
// against the public key in tauri.conf.json, installs it and restarts. False: already current.
// The server decides what is newer (a later build of the same version counts), so any offer is taken.
#[tauri::command]
async fn update_client(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    let origin = window.url().map_err(|e| e.to_string())?.origin().ascii_serialization();
    let endpoint = Url::parse(&format!("{origin}/api/client/update/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}?build={BUILD}")).map_err(|e| e.to_string())?;
    let updater = app.updater_builder().version_comparator(|_, _| true).endpoints(vec![endpoint]).and_then(|b| b.build()).map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(false) };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart()
}

fn launcher_url() -> Url {
    // Tauri serves bundled files from these origins (WebView2 needs http).
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(base).unwrap().join("index.html?choose=1").unwrap()
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Back to the server list, e.g. to pick another server or add one.
fn switch_server(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.navigate(launcher_url());
    }
    show(app);
}

// Links that open a new window (Links above). A client window must be built from the request's
// features: they carry the opener's webview environment (Windows) or configuration (macOS, where
// WebKit refuses any other), and the request then loads the page into it.
fn new_window(app: &AppHandle, url: Url, features: NewWindowFeatures) -> NewWindowResponse<tauri::Wry> {
    if studiolo_page(app, &url) && app.state::<Links>().client.load(Ordering::Relaxed) {
        let label = format!("view-{}", WINDOWS.fetch_add(1, Ordering::Relaxed));
        let handle = app.clone();
        if let Ok(window) = WebviewWindowBuilder::new(app, label, WebviewUrl::External("about:blank".parse().unwrap()))
            .window_features(features)
            .title("Studiolo")
            .inner_size(1200.0, 800.0)
            .disable_drag_drop_handler()
            .on_document_title_changed(|window, title| {
                let _ = window.set_title(&title);
            })
            .on_new_window(move |url, features| new_window(&handle, url, features))
            .build()
        {
            return NewWindowResponse::Create { window };
        }
    }
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
    NewWindowResponse::Deny
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .invoke_handler(tauri::generate_handler![trust_origins, known_servers, link_mode, set_link_mode, open_link, start_recording, start_streaming, stop_recording, cancel_recording, client_build, update_client])
        .setup(|app| {
            let handle = app.handle().clone();
            let trusted = read_trusted(&handle);
            let args = browser_args(&trusted);
            app.manage(Trusted(trusted));
            app.manage(Recorder::default());
            let links = Links::default();
            links.client.store(links_file(&handle).is_some_and(|file| file.exists()), Ordering::Relaxed);
            app.manage(links);
            let hidden = std::env::args().any(|a| a == "--hidden");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Studiolo")
                .inner_size(1280.0, 820.0)
                .min_inner_size(420.0, 480.0)
                .center()
                .visible(!hidden)
                // macOS suspends a hidden WKWebView by default; the page must keep running in the
                // tray so its event stream and notifications (public/notify.js) still work.
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .additional_browser_args(&args)
                // Tauri's file-drop handler swallows HTML5 drag and drop on Windows: every drag shows the
                // no-drop cursor. The pages handle drops themselves (chats and tabs, files onto the
                // composer or the file tree), so it is off here and in the view-* windows.
                .disable_drag_drop_handler()
                .on_new_window(move |url, features| new_window(&handle, url, features))
                .build()?;

            let autostart = app.autolaunch().is_enabled().unwrap_or(false);
            let show_item = MenuItem::with_id(app, "show", "Show Studiolo", true, None::<&str>)?;
            let switch_item = MenuItem::with_id(app, "switch", "Switch server…", true, None::<&str>)?;
            let autostart_item = CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Studiolo", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show_item, &switch_item, &separator, &autostart_item, &quit_item])?;
            let toggle_autostart = autostart_item.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("bundle icon"))
                .tooltip("Studiolo")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show(app),
                    "switch" => switch_server(app),
                    "autostart" => {
                        let launcher = app.autolaunch();
                        let enable = !launcher.is_enabled().unwrap_or(false);
                        let _ = if enable { launcher.enable() } else { launcher.disable() };
                        let _ = toggle_autostart.set_checked(launcher.is_enabled().unwrap_or(false));
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // Closing the main window keeps the client in the tray, so notifications still arrive.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Studiolo");
}
