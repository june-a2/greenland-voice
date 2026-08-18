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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_the_isle_pid])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}