use sysinfo::System;

#[tauri::command]
fn is_the_isle_running() -> bool {
    let mut system = System::new_all();
    system.refresh_all();

    system.processes().values().any(|process| {
        let name = process.name().to_string_lossy().to_lowercase();

        name.contains("theisle")
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![is_the_isle_running])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}