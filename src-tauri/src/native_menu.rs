use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn set_native_ui_language(_app: AppHandle, language: String) -> Result<(), String> {
    if !is_supported_ui_language(&language) {
        return Err(format!("Unsupported UI language: {language}"));
    }

    #[cfg(target_os = "macos")]
    setup_macos_menu(&_app, &language).map_err(|error| error.to_string())?;

    Ok(())
}

fn is_supported_ui_language(language: &str) -> bool {
    matches!(language, "en-US" | "zh-CN")
}

pub fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "app.new-session" => {
            let _ = app.emit("tauri://new-session", ());
        }
        "app.settings" => {
            let _ = app.emit("tauri://open-settings", ());
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
pub fn setup_macos_menu(app: &AppHandle, language: &str) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let chinese = language == "zh-CN";
    let text = |english: &'static str, chinese_text: &'static str| {
        if chinese {
            chinese_text
        } else {
            english
        }
    };

    let about =
        PredefinedMenuItem::about(app, Some(text("About Kimi Code", "关于 Kimi Code")), None)?;
    let settings = MenuItem::with_id(
        app,
        "app.settings",
        text("Settings…", "设置…"),
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let services = PredefinedMenuItem::services(app, Some(text("Services", "服务")))?;
    let hide = PredefinedMenuItem::hide(app, Some(text("Hide Kimi Code", "隐藏 Kimi Code")))?;
    let hide_others =
        PredefinedMenuItem::hide_others(app, Some(text("Hide Others", "隐藏其他应用")))?;
    let show_all = PredefinedMenuItem::show_all(app, Some(text("Show All", "全部显示")))?;
    let quit = PredefinedMenuItem::quit(app, Some(text("Quit Kimi Code", "退出 Kimi Code")))?;
    let app_menu = Submenu::with_items(
        app,
        "Kimi Code",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &services,
            &PredefinedMenuItem::separator(app)?,
            &hide,
            &hide_others,
            &show_all,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let new_session = MenuItem::with_id(
        app,
        "app.new-session",
        text("New Session", "新建会话"),
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let close_window =
        PredefinedMenuItem::close_window(app, Some(text("Close Window", "关闭窗口")))?;
    let file_menu = Submenu::with_items(
        app,
        text("File", "文件"),
        true,
        &[
            &new_session,
            &PredefinedMenuItem::separator(app)?,
            &close_window,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        text("Edit", "编辑"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(text("Undo", "撤销")))?,
            &PredefinedMenuItem::redo(app, Some(text("Redo", "重做")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(text("Cut", "剪切")))?,
            &PredefinedMenuItem::copy(app, Some(text("Copy", "复制")))?,
            &PredefinedMenuItem::paste(app, Some(text("Paste", "粘贴")))?,
            &PredefinedMenuItem::select_all(app, Some(text("Select All", "全选")))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        text("Window", "窗口"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(text("Minimize", "最小化")))?,
            &PredefinedMenuItem::maximize(app, Some(text("Zoom", "缩放")))?,
            &PredefinedMenuItem::fullscreen(app, Some(text("Enter Full Screen", "进入全屏")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(
                app,
                Some(text("Bring All to Front", "前置全部窗口")),
            )?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_supported_ui_language;

    #[test]
    fn native_menu_accepts_only_supported_ui_languages() {
        assert!(is_supported_ui_language("en-US"));
        assert!(is_supported_ui_language("zh-CN"));
        assert!(!is_supported_ui_language("fr-FR"));
        assert!(!is_supported_ui_language("system"));
    }
}
