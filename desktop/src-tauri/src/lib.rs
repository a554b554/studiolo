// Studiolo desktop client. The window shows a server's own web UI, the same
// front end as the browser; the bundled launcher page only lists and probes servers. Rust adds
// what a browser tab cannot: tray, autostart, one instance, notifications.
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

static WINDOWS: AtomicU32 = AtomicU32::new(0);

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

// Links that open a new window: pages of the same server (an Artifact) get their own client
// window; anything else goes to the system browser.
fn new_window(app: &AppHandle, url: Url) -> NewWindowResponse<tauri::Wry> {
    let same_server = main_window(app)
        .and_then(|w| w.url().ok())
        .map(|current| current.origin() == url.origin())
        .unwrap_or(false);
    if same_server {
        let label = format!("view-{}", WINDOWS.fetch_add(1, Ordering::Relaxed));
        if let Ok(window) = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url.clone()))
            .title("Studiolo")
            .inner_size(1200.0, 800.0)
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .setup(|app| {
            let handle = app.handle().clone();
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
                .on_new_window(move |url, _features| new_window(&handle, url))
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
