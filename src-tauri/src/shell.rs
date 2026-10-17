//! Desktop integration: system tray (with recently viewed pages), close-to-tray, and launching
//! at startup, shown or minimized to the tray.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};

/// Launch argument added by the startup entry.
pub const AUTOSTART_ARG: &str = "--autostart";
const TRAY_ID: &str = "main";
const DOC_PREFIX: &str = "doc:";
const STARTUP_FILE: &str = "startup.json";

struct CloseToTray(AtomicBool);

#[derive(Deserialize, Clone)]
pub struct TrayDoc {
    id: String,
    title: String,
}

/// What the tray menu shows; the webview fills it in (language, recent pages).
struct TrayState {
    open: String,
    quit: String,
    heading: String,
    docs: Vec<TrayDoc>,
}

/// Read before the webview exists, so it lives in a small file rather than the app's settings.
#[derive(Serialize, Deserialize, Default)]
struct Startup {
    minimized: bool,
}

fn startup_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(STARTUP_FILE))
}

fn read_startup<R: Runtime>(app: &AppHandle<R>) -> Startup {
    startup_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, state: &TrayState) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    if !state.docs.is_empty() {
        menu.append(&MenuItem::with_id(app, "heading", &state.heading, false, None::<&str>)?)?;
        for doc in &state.docs {
            // Long titles make a very wide menu.
            let mut title: String = doc.title.chars().take(48).collect();
            if doc.title.chars().count() > 48 {
                title.push('…');
            }
            menu.append(&MenuItem::with_id(app, format!("{DOC_PREFIX}{}", doc.id), title, true, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, "open", &state.open, true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", &state.quit, true, None::<&str>)?)?;
    Ok(menu)
}

fn refresh_menu(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<TrayState>>();
    let state = state.lock().map_err(|e| e.to_string())?;
    let menu = build_menu(app, &state).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    app.manage(CloseToTray(AtomicBool::new(true)));

    let state = TrayState {
        open: "Open Notes".into(),
        quit: "Quit".into(),
        heading: "Recently viewed".into(),
        docs: Vec::new(),
    };
    let menu = build_menu(app.handle(), &state)?;
    app.manage(Mutex::new(state));

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Notes")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            id => {
                if let Some(doc) = id.strip_prefix(DOC_PREFIX) {
                    show_main_window(app);
                    let _ = app.emit("tray-open-doc", doc);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    // The window starts hidden so a minimized startup doesn't flash it on screen.
    let autostarted = std::env::args().any(|a| a == AUTOSTART_ARG);
    if !(autostarted && read_startup(app.handle()).minimized) {
        show_main_window(app.handle());
    }
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.state::<CloseToTray>().0.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, enabled: bool) {
    app.state::<CloseToTray>().0.store(enabled, Ordering::Relaxed);
}

/// Whether a launch at startup stays in the tray.
#[tauri::command]
pub fn set_start_minimized(app: AppHandle, minimized: bool) -> Result<(), String> {
    let path = startup_path(&app).ok_or("No config folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_string(&Startup { minimized }).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The tray menu is built before the webview knows the UI language, so it relabels it.
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, open: String, quit: String, heading: String) -> Result<(), String> {
    {
        let state = app.state::<Mutex<TrayState>>();
        let mut state = state.lock().map_err(|e| e.to_string())?;
        (state.open, state.quit, state.heading) = (open, quit, heading);
    }
    refresh_menu(&app)
}

/// The recently viewed pages listed in the tray (empty when signed out).
#[tauri::command]
pub fn set_tray_docs(app: AppHandle, docs: Vec<TrayDoc>) -> Result<(), String> {
    {
        let state = app.state::<Mutex<TrayState>>();
        state.lock().map_err(|e| e.to_string())?.docs = docs;
    }
    refresh_menu(&app)
}
