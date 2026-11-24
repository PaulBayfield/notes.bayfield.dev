//! Launching at login.
//!
//! On Windows this is the current user's `Run` entry only. The autostart plugin also writes the
//! machine-wide one when the app happens to run elevated (say, straight after the installer), and
//! then counts startup as off unless both are on: a machine entry left disabled meant the switch
//! never stayed on. Elsewhere the plugin does the work.

use tauri::AppHandle;

#[cfg(windows)]
mod imp {
    use crate::shell::AUTOSTART_ARG;
    use tauri::AppHandle;
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE, Type};
    use windows_result::HRESULT;

    const RUN: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
    /// Task Manager's startup switches: the entry runs unless this marks it disabled.
    const APPROVED: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const APPROVED_ON: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const NOT_FOUND: HRESULT = HRESULT::from_win32(2);

    fn name(app: &AppHandle) -> String {
        app.package_info().name.clone()
    }

    pub fn enabled(app: &AppHandle) -> Result<bool, String> {
        let name = name(app);
        let registered = match CURRENT_USER.open(RUN).and_then(|k| k.get_string(&name)) {
            Ok(_) => true,
            Err(e) if e.code() == NOT_FOUND => false,
            Err(e) => return Err(e.to_string()),
        };
        if !registered {
            return Ok(false);
        }
        // Turned off in Task Manager: a timestamp in the last 8 bytes.
        Ok(match CURRENT_USER.open(APPROVED).and_then(|k| k.get_value(&name)) {
            Ok(value) => value.len() < 8 || value.iter().rev().take(8).all(|b| *b == 0),
            Err(_) => true,
        })
    }

    pub fn set(app: &AppHandle, on: bool) -> Result<(), String> {
        let name = name(app);
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let command = format!("\"{}\" {AUTOSTART_ARG}", exe.display());
            CURRENT_USER.create(RUN).and_then(|k| k.set_string(&name, &command)).map_err(|e| e.to_string())?;
            // Also undoes an earlier "Disable" in Task Manager, or it would stay off.
            CURRENT_USER
                .create(APPROVED)
                .and_then(|k| k.set_bytes(&name, Type::Bytes, &APPROVED_ON))
                .map_err(|e| e.to_string())?;
        } else {
            match CURRENT_USER.options().write().open(RUN).and_then(|k| k.remove_value(&name)) {
                Ok(()) => {}
                Err(e) if e.code() == NOT_FOUND => {}
                Err(e) => return Err(e.to_string()),
            }
            // A machine-wide entry from an elevated run: only removable when elevated again.
            let _ = LOCAL_MACHINE.options().write().open(RUN).and_then(|k| k.remove_value(&name));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;
    use tauri_plugin_autostart::ManagerExt;

    pub fn enabled(app: &AppHandle) -> Result<bool, String> {
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    }

    pub fn set(app: &AppHandle, on: bool) -> Result<(), String> {
        let launcher = app.autolaunch();
        if on { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    imp::enabled(&app)
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, on: bool) -> Result<(), String> {
    imp::set(&app, on)
}
