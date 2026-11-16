//! Spelling suggestions in the app's own right-click menu (Windows).
//!
//! The app shows its own menu instead of WebView2's, but only WebView2 knows the spelling
//! suggestions for the word under the pointer. So for right-clicks in the editor the page lets
//! the native menu through; here it's caught before it opens: its spelling items are sent to the
//! page (`spelling-menu` event), which adds them to its own menu, and the native one is never
//! shown. The page then reports what was picked (`context_menu_pick`), and WebView2 applies it as
//! if it had been picked from its own menu.

#[cfg(windows)]
mod imp {
    use serde::Serialize;
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, Manager};
    use webview2_com::ContextMenuRequestedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_11, ICoreWebView2ContextMenuItemCollection, ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Deferral,
    };
    use windows_core::{Interface, PWSTR};

    #[derive(Serialize, Clone)]
    struct Suggestion {
        id: i32,
        label: String,
    }

    /// The native menu waiting for the page's answer. COM objects of the UI thread: only touched
    /// there (the handler runs on it, and the answer is run on it).
    struct Pending {
        args: ICoreWebView2ContextMenuRequestedEventArgs,
        deferral: ICoreWebView2Deferral,
    }
    unsafe impl Send for Pending {}

    static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

    fn take_string(get: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>) -> String {
        let mut value = PWSTR::null();
        if get(&mut value).is_err() || value.is_null() {
            return String::new();
        }
        webview2_com::take_pwstr(value)
    }

    /// The spelling items of the menu: suggestions, and "Add to dictionary" and the like.
    unsafe fn spelling_items(items: &ICoreWebView2ContextMenuItemCollection) -> Vec<Suggestion> {
        let mut out = Vec::new();
        let mut count = 0u32;
        if unsafe { items.Count(&mut count) }.is_err() {
            return out;
        }
        for i in 0..count {
            let Ok(item) = (unsafe { items.GetValueAtIndex(i) }) else { continue };
            if take_string(|v| unsafe { item.Name(v) }) != "spellCheck" {
                continue;
            }
            let mut id = 0;
            if unsafe { item.CommandId(&mut id) }.is_err() {
                continue;
            }
            // "&" marks the keyboard accelerator ("&&" is a literal ampersand).
            let label = take_string(|v| unsafe { item.Label(v) }).replace("&&", "\u{0}").replace('&', "").replace('\u{0}', "&");
            if !label.is_empty() {
                out.push(Suggestion { id, label });
            }
        }
        out
    }

    /// Catches WebView2's menus on the main window from now on.
    pub fn install(app: &AppHandle) {
        let Some(window) = app.get_webview_window("main") else { return };
        let handle = app.clone();
        let _ = window.with_webview(move |webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(core) = core.cast::<ICoreWebView2_11>() else { return };
            let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                // Only the editor lets the native menu through to us; Shift + right-click
                // asks for the native menu itself.
                let mut editable = windows_core::BOOL::default();
                args.ContextMenuTarget()?.IsEditable(&mut editable)?;
                let shift = windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState(windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_SHIFT as i32) < 0;
                if !editable.as_bool() || shift {
                    return Ok(());
                }
                let items = args.MenuItems()?;
                let suggestions = spelling_items(&items);
                // Ours instead: the native menu never opens.
                args.SetHandled(true)?;
                let deferral = args.GetDeferral()?;
                // An unanswered menu from before (it was closed some other way) is let go.
                if let Ok(mut slot) = PENDING.lock() {
                    if let Some(old) = slot.replace(Pending { args, deferral }) {
                        let _ = old.deferral.Complete();
                    }
                }
                let _ = handle.emit("spelling-menu", suggestions);
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_ContextMenuRequested(&handler, &mut token);
        });
    }

    pub fn pick(app: AppHandle, id: Option<i32>) {
        let _ = app.run_on_main_thread(move || {
            let Some(pending) = PENDING.lock().ok().and_then(|mut p| p.take()) else { return };
            unsafe {
                if let Some(id) = id {
                    let _ = pending.args.SetSelectedCommandId(id);
                }
                let _ = pending.deferral.Complete();
            }
        });
    }
}

#[cfg(windows)]
pub use imp::install;

/// Elsewhere the native menu isn't caught (the page shows its own menu straight away).
#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle) {}

/// The page's answer: the spelling item picked, or none when its menu closed without one.
#[tauri::command]
pub fn context_menu_pick(app: tauri::AppHandle, id: Option<i32>) {
    #[cfg(windows)]
    imp::pick(app, id);
    #[cfg(not(windows))]
    let _ = (app, id);
}
