pub mod commands;
pub mod git_diff;
pub mod global_config;
pub mod goal_queue;
pub mod goal_store;
pub mod mcp_config;
pub mod native_menu;
pub mod notify;
pub mod provider_config;
pub mod runtime;
pub mod runtime_check;
pub mod security;
pub mod session_compat;
pub mod session_config;
pub mod session_files;
pub mod session_influence;
pub mod session_store;
pub mod skills;
#[cfg(test)]
pub mod test_env;
pub mod tray;
pub mod usage_stats;
pub mod wire_events;

use tauri::Manager;

pub fn run() {
    #[cfg(target_os = "macos")]
    runtime_check::configure_macos_cli_path();

    // `builder` is only reassigned on Windows, where single-instance applies.
    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut builder = tauri::Builder::default();
    // Register this first so a second launch is intercepted before any
    // other plugin or application state is initialized.
    // single-instance is Windows-only; other platforms build without it.
    #[cfg(target_os = "windows")]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_notification::init())
        .manage(runtime::host::RuntimeHost::new())
        .invoke_handler(tauri::generate_handler![
            commands::wire_connect,
            commands::wire_disconnect,
            commands::wire_send,
            commands::wire_status,
            commands::wire_list_workers,
            commands::list_sessions,
            commands::get_session,
            commands::replay_session_history,
            commands::get_session_swarm_mode,
            commands::get_session_goal_snapshot,
            commands::get_session_goal_queue,
            commands::append_session_goal_queue,
            commands::update_session_goal_queue,
            commands::remove_session_goal_queue,
            commands::move_session_goal_queue,

            commands::control_session_goal,
            commands::get_session_goal_mode,
            commands::get_session_runtime_modes,
            commands::migrate_session_swarm_mode,
            commands::migrate_session_goal_mode,
            commands::create_session,
            commands::delete_session,
            commands::update_session,
            commands::fork_session,
            commands::generate_title,
            commands::upload_session_file,
            commands::delete_uploaded_file,
            commands::list_session_directory,
            commands::list_work_dir_directory,
            commands::get_session_file,
            commands::get_session_upload_file,
            commands::list_work_dirs,
            commands::get_startup_dir,
            commands::list_available_skills,
            commands::get_session_influence_snapshot,
            commands::pick_files,
            commands::pick_folder,
            commands::save_text_file_dialog,
            commands::get_global_config,
            commands::get_config_toml,
            commands::get_providers_overview,
            commands::list_provider_catalog,
            commands::get_provider_catalog_entry,
            commands::import_provider_from_catalog,
            commands::import_provider_registry,
            commands::update_config_toml,
            commands::get_mcp_config,
            commands::update_mcp_config,
            commands::update_global_config,
            commands::get_git_diff_stats,
            commands::show_window,
            commands::hide_window,
            commands::get_app_version,
            commands::get_kimi_cli_version,
            commands::get_agent_runtime_capabilities,
            commands::get_session_config_state,
            commands::check_runtime_readiness,
            commands::open_kimi_login,
            commands::start_kimi_login,
            commands::poll_kimi_login,
            commands::cancel_kimi_login,
            commands::kimi_credentials_status,
            commands::logout_kimi,
            commands::open_external,
            commands::open_in_explorer,
            commands::open_in_editor,
            commands::fetch_managed_usage,
            commands::fetch_usage_stats,
            native_menu::set_native_ui_language,
        ])
        .on_menu_event(|app, event| {
            native_menu::handle_menu_event(app, event.id().as_ref());
        })
        .setup(|app| {
            let handle = app.handle().clone();
            tray::setup_tray(&handle)?;
            #[cfg(target_os = "macos")]
            native_menu::setup_macos_menu(&handle, "en-US")?;
            // Keep the main window hidden until React has mounted and invokes
            // show_window. This avoids exposing a blank webview during startup.

            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
                #[cfg(target_os = "macos")]
                let shortcut_text = "super+shift+k";
                #[cfg(not(target_os = "macos"))]
                let shortcut_text = "ctrl+shift+k";

                let shortcut_result = tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts([shortcut_text])
                    .map(|builder| {
                        builder
                            .with_handler(|app, shortcut, event| {
                                #[cfg(target_os = "macos")]
                                let modifiers = Modifiers::SUPER | Modifiers::SHIFT;
                                #[cfg(not(target_os = "macos"))]
                                let modifiers = Modifiers::CONTROL | Modifiers::SHIFT;

                                if event.state == ShortcutState::Pressed
                                    && shortcut.matches(modifiers, Code::KeyK)
                                {
                                    if let Some(window) = app.get_webview_window("main") {
                                        if window.is_visible().unwrap_or(false) {
                                            let _ = window.hide();
                                        } else {
                                            let _ = window.show();
                                            let _ = window.set_focus();
                                        }
                                    }
                                }
                            })
                            .build()
                    });
                match shortcut_result {
                    Ok(plugin) => {
                        if let Err(e) = app.handle().plugin(plugin) {
                            eprintln!("[WARN] Failed to register global shortcut plugin: {}", e);
                        }
                    }
                    Err(e) => {
                        eprintln!("[WARN] Global shortcut {shortcut_text} is already taken by another application: {e}");
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
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = &event {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }

        if let tauri::RunEvent::ExitRequested { .. } = event {
            app_handle.state::<runtime::host::RuntimeHost>().shutdown();
        }
    });
}
