use std::{env, fs, path::PathBuf};
use sysinfo::System;

#[tauri::command]
fn get_the_isle_pid() -> Option<u32> {
    let mut system = System::new_all();
    system.refresh_all();

    for (pid, process) in system.processes() {
        let name = process.name().to_string_lossy().to_lowercase();

        if name.contains("theisle") {
            return Some(pid.as_u32());
        }
    }

    None
}

#[tauri::command]
fn get_steam_id() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const STEAM_ID64_BASE: u64 = 76561197960265728;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let key = hkcu
        .open_subkey("Software\\Valve\\Steam\\ActiveProcess")
        .ok()?;

    let active_user: u32 = key.get_value("ActiveUser").ok()?;

    if active_user == 0 {
        return None;
    }

    let steam_id64 = STEAM_ID64_BASE + active_user as u64;

    Some(steam_id64.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_the_isle_pid,
            get_steam_id
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}