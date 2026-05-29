pub mod commands;
pub mod notify;
pub mod sidecar;
pub mod tray;

use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(sidecar::WireProcessManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::wire_connect,
            commands::wire_disconnect,
            commands::wire_send,
            commands::wire_status,
            commands::list_sessions,
            commands::get_session,
            commands::replay_session_history,
            commands::create_session,
            commands::delete_session,
            commands::update_session,
            commands::fork_session,
            commands::generate_title,
            commands::upload_session_file,
            commands::list_session_directory,
            commands::get_session_file,
            commands::get_session_upload_file,
            commands::list_work_dirs,
            commands::get_startup_dir,
            commands::get_global_config,
            commands::get_config_toml,
            commands::update_config_toml,
            commands::get_mcp_config,
            commands::update_mcp_config,
            commands::update_global_config,
            commands::get_git_diff_stats,
            commands::show_window,
            commands::hide_window,
            commands::get_app_version,
            commands::get_kimi_cli_version,
            commands::open_kimi_login,
            commands::open_external,
            commands::open_in_explorer,
            commands::open_in_editor,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tray::setup_tray(&handle)?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.center();
                let _ = window.set_focus();
            }
            sidecar::prewarm_desktop_api_process(handle.clone());

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
                let shortcut_result = tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["ctrl+shift+k"])
                    .and_then(|builder| {
                        Ok(builder
                            .with_handler(|app, shortcut, event| {
                                if event.state == ShortcutState::Pressed {
                                    if shortcut.matches(Modifiers::CONTROL, Code::KeyK) {
                                        if let Some(window) = app.get_webview_window("main") {
                                            if window.is_visible().unwrap_or(false) {
                                                let _ = window.hide();
                                            } else {
                                                let _ = window.show();
                                                let _ = window.set_focus();
                                            }
                                        }
                                    }
                                }
                            })
                            .build())
                    });
                match shortcut_result {
                    Ok(plugin) => {
                        if let Err(e) = app.handle().plugin(plugin) {
                            eprintln!("[WARN] Failed to register global shortcut plugin: {}", e);
                        }
                    }
                    Err(e) => {
                        eprintln!("[WARN] Global shortcut ctrl+shift+k is already taken by another application: {}", e);
                        eprintln!("[WARN] You can still use the tray icon to show/hide the window.");
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let manager = app_handle.state::<sidecar::WireProcessManager>();
            manager.stop_all();
            sidecar::stop_desktop_api_process();
        }
    });
}
