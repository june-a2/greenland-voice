use std::sync::{
    atomic::{AtomicI32, Ordering},
    OnceLock,
};

use sysinfo::System;
use tauri::Emitter;

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(target_os = "windows")]
static PTT_KEY_VK: AtomicI32 = AtomicI32::new(-1);

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

#[cfg(target_os = "windows")]
fn keyboard_label_to_vk(label: &str) -> Option<i32> {
    let upper = label.to_ascii_uppercase();

    if upper.len() == 1 {
        let byte = upper.as_bytes()[0];

        if byte.is_ascii_alphanumeric() {
            return Some(byte as i32);
        }
    }

    if let Some(number) = upper.strip_prefix('F') {
        if let Ok(value) = number.parse::<i32>() {
            if (1..=12).contains(&value) {
                return Some(0x6F + value);
            }
        }
    }

    match upper.as_str() {
        "BACKSPACE" => Some(0x08),
        "TAB" => Some(0x09),
        "ENTER" => Some(0x0D),
        "SHIFT" => Some(0x10),
        "CTRL" | "CONTROL" => Some(0x11),
        "ALT" => Some(0x12),
        "PAUSE" => Some(0x13),
        "CAPSLOCK" => Some(0x14),
        "ESC" | "ESCAPE" => Some(0x1B),
        "SPACE" => Some(0x20),
        "PAGEUP" => Some(0x21),
        "PAGEDOWN" => Some(0x22),
        "END" => Some(0x23),
        "HOME" => Some(0x24),
        "LEFT" => Some(0x25),
        "UP" => Some(0x26),
        "RIGHT" => Some(0x27),
        "DOWN" => Some(0x28),
        "INSERT" => Some(0x2D),
        "DELETE" => Some(0x2E),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_ptt_keyboard_key(key: Option<String>) -> Result<(), String> {
    match key {
        Some(key) => {
            let vk = keyboard_label_to_vk(&key)
                .ok_or_else(|| format!("Unsupported PTT keyboard key: {key}"))?;

            PTT_KEY_VK.store(vk, Ordering::Relaxed);
            Ok(())
        }
        None => {
            PTT_KEY_VK.store(-1, Ordering::Relaxed);
            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn set_ptt_keyboard_key(_key: Option<String>) -> Result<(), String> {
    Err("Global keyboard PTT is only supported on Windows".to_string())
}

#[cfg(target_os = "windows")]
mod input_hook {
    use super::{APP_HANDLE, PTT_KEY_VK};
    use std::mem::zeroed;
    use std::ptr::null;
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    use tauri::Emitter;

    const WH_MOUSE_LL: i32 = 14;
    const WM_XBUTTONDOWN: usize = 0x020B;
    const WM_XBUTTONUP: usize = 0x020C;
    const XBUTTON1: u16 = 0x0001;
    const XBUTTON2: u16 = 0x0002;

    type HHook = isize;
    type HWnd = isize;
    type HInstance = isize;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct Msg {
        hwnd: HWnd,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        pt: Point,
        l_private: u32,
    }

    #[repr(C)]
    struct MsllHookStruct {
        pt: Point,
        mouse_data: u32,
        flags: u32,
        time: u32,
        dw_extra_info: usize,
    }

    type HookProc = unsafe extern "system" fn(i32, usize, isize) -> isize;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowsHookExW(
            id_hook: i32,
            lpfn: Option<HookProc>,
            hmod: HInstance,
            thread_id: u32,
        ) -> HHook;

        fn CallNextHookEx(
            hook: HHook,
            code: i32,
            w_param: usize,
            l_param: isize,
        ) -> isize;

        fn UnhookWindowsHookEx(hook: HHook) -> i32;

        fn GetMessageW(
            msg: *mut Msg,
            hwnd: HWnd,
            filter_min: u32,
            filter_max: u32,
        ) -> i32;

        fn GetAsyncKeyState(v_key: i32) -> i16;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(module_name: *const u16) -> HInstance;
    }

    fn emit_input(event_name: &str, value: &str, state: &str) {
        if let Some(app) = APP_HANDLE.get() {
            let payload = format!("{}:{}", value, state);
            let _ = app.emit(event_name, payload);
        }
    }

    fn vk_label(vk: i32) -> String {
        if (0x41..=0x5A).contains(&vk) || (0x30..=0x39).contains(&vk) {
            return char::from_u32(vk as u32)
                .map(|value| value.to_string())
                .unwrap_or_default();
        }

        if (0x70..=0x7B).contains(&vk) {
            return format!("F{}", vk - 0x6F);
        }

        match vk {
            0x08 => "Backspace",
            0x09 => "Tab",
            0x0D => "Enter",
            0x10 => "Shift",
            0x11 => "Ctrl",
            0x12 => "Alt",
            0x13 => "Pause",
            0x14 => "CapsLock",
            0x1B => "Escape",
            0x20 => "Space",
            0x21 => "PageUp",
            0x22 => "PageDown",
            0x23 => "End",
            0x24 => "Home",
            0x25 => "Left",
            0x26 => "Up",
            0x27 => "Right",
            0x28 => "Down",
            0x2D => "Insert",
            0x2E => "Delete",
            _ => "",
        }
        .to_string()
    }

    unsafe extern "system" fn mouse_proc(
        code: i32,
        w_param: usize,
        l_param: isize,
    ) -> isize {
        if code >= 0 && (w_param == WM_XBUTTONDOWN || w_param == WM_XBUTTONUP) {
            let data = &*(l_param as *const MsllHookStruct);
            let button_code = (data.mouse_data >> 16) as u16;

            let button = match button_code {
                XBUTTON1 => Some("Mouse4"),
                XBUTTON2 => Some("Mouse5"),
                _ => None,
            };

            if let Some(button) = button {
                let state = if w_param == WM_XBUTTONDOWN {
                    "pressed"
                } else {
                    "released"
                };

                emit_input("ptt-mouse", button, state);
            }
        }

        CallNextHookEx(0, code, w_param, l_param)
    }

    fn start_keyboard_poll() {
        std::thread::spawn(|| {
            let mut previous_vk = -1;
            let mut was_pressed = false;

            println!("Global keyboard PTT polling active");

            loop {
                let vk = PTT_KEY_VK.load(Ordering::Relaxed);

                if vk != previous_vk {
                    if previous_vk >= 0 && was_pressed {
                        let old_label = vk_label(previous_vk);

                        if !old_label.is_empty() {
                            emit_input("ptt-keyboard", &old_label, "released");
                        }
                    }

                    previous_vk = vk;
                    was_pressed = false;
                }

                if vk >= 0 {
                    let pressed = unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 };

                    if pressed != was_pressed {
                        let label = vk_label(vk);

                        if !label.is_empty() {
                            emit_input(
                                "ptt-keyboard",
                                &label,
                                if pressed { "pressed" } else { "released" },
                            );
                        }

                        was_pressed = pressed;
                    }
                }

                std::thread::sleep(Duration::from_millis(8));
            }
        });
    }

    fn start_mouse_hook() {
        std::thread::spawn(|| unsafe {
            let module = GetModuleHandleW(null());

            let mouse_hook = SetWindowsHookExW(
                WH_MOUSE_LL,
                Some(mouse_proc),
                module,
                0,
            );

            if mouse_hook == 0 {
                eprintln!("Unable to install global mouse PTT hook");
                return;
            }

            println!("Global mouse PTT hook active");

            let mut message: Msg = zeroed();

            while GetMessageW(&mut message, 0, 0, 0) > 0 {}

            UnhookWindowsHookEx(mouse_hook);
        });
    }

    pub fn start() {
        start_keyboard_poll();
        start_mouse_hook();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());

            #[cfg(target_os = "windows")]
            input_hook::start();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_the_isle_pid,
            get_steam_id,
            set_ptt_keyboard_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}