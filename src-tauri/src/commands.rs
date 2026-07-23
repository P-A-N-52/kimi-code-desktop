use crate::acp::{resolve_acp_command_validated, AcpProcessManager};
use crate::acp_desktop::{
    fetch_all_acp_sessions, filter_sessions, find_session_in_list, session_new_params,
    shape_acp_session_to_legacy, AcpDesktopClient,
};
use crate::git_diff;
use crate::global_config;
use crate::runtime_check;
use crate::security::{
    validate_http_external_url, validate_local_absolute_path, validate_mcp_config_json,
};
use crate::session_files;
use crate::session_store;
use crate::wire_events::{RestartWorkersSummary, RuntimeStatus};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const DEFAULT_MCP_JSON: &str = "{\n  \"mcpServers\": {}\n}\n";

fn kimi_config_path(file_name: &str) -> Result<PathBuf, String> {
    Ok(runtime_check::kimi_code_home_dir()?.join(file_name))
}

pub(crate) fn is_hidden_work_dir(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized == "/tmp"
        || normalized.starts_with("/var/folders")
        || normalized.contains("/.cache/")
}

fn read_kimi_config_file(file_name: &str, default_content: &str) -> Result<Value, String> {
    let path = kimi_config_path(file_name)?;
    let content = if path.exists() {
        fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?
    } else {
        default_content.to_string()
    };

    Ok(json!({
        "content": content,
        "path": path.to_string_lossy(),
    }))
}

fn write_kimi_config_file(file_name: &str, content: &str) -> Result<Value, String> {
    let path = kimi_config_path(file_name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    Ok(json!({
        "success": true,
        "error": Value::Null,
    }))
}

fn validate_toml(content: &str) -> Result<(), String> {
    toml::from_str::<toml::Value>(content)
        .map(|_| ())
        .map_err(|e| format!("Invalid TOML: {}", e))
}

fn validate_json(content: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(content).map_err(|e| format!("Invalid JSON: {}", e))
}

fn validate_mcp_config(content: &str) -> Result<(), String> {
    let value = validate_json(content)?;
    validate_mcp_config_json(&value)
}

#[tauri::command]
pub async fn wire_connect(
    app: tauri::AppHandle,
    acp: tauri::State<'_, AcpProcessManager>,
    session_id: String,
    connection_id: String,
) -> Result<(), String> {
    acp.connect_leased(&app, session_id, connection_id).await
}

#[tauri::command]
pub async fn wire_disconnect(
    app: tauri::AppHandle,
    acp: tauri::State<'_, AcpProcessManager>,
    session_id: String,
    connection_id: String,
) -> Result<(), String> {
    acp.disconnect_leased(&app, session_id, connection_id).await
}

#[tauri::command]
pub async fn wire_send(
    app: tauri::AppHandle,
    acp: tauri::State<'_, AcpProcessManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    acp.send(&app, session_id, message).await
}

#[tauri::command]
pub fn wire_status(
    acp: tauri::State<'_, AcpProcessManager>,
    session_id: String,
) -> Result<Option<RuntimeStatus>, String> {
    Ok(acp.get_status(&session_id))
}

#[tauri::command]
pub async fn list_sessions(
    app: tauri::AppHandle,
    acp_desktop: tauri::State<'_, AcpDesktopClient>,
    acp_wire: tauri::State<'_, AcpProcessManager>,
    limit: Option<u64>,
    offset: Option<u64>,
    q: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let offset = offset.unwrap_or(0);

    // ACP auth/token races must not blank the sidebar — fall back to on-disk sessions.
    let (raw_sessions, acp_list_error) = match fetch_all_acp_sessions(&acp_desktop, &app).await {
        Ok(sessions) => (sessions, None),
        Err(err) => {
            eprintln!("[list_sessions] ACP session/list failed, using local sessions: {err}");
            (Vec::new(), Some(err))
        }
    };
    let mut shaped: Vec<Value> = raw_sessions
        .iter()
        .map(|session| {
            let mut legacy = shape_acp_session_to_legacy(session);
            let session_id = legacy
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(session_id) = session_id {
                session_store::merge_local_metadata_into_legacy(&mut legacy, &session_id);
            }
            legacy
        })
        .collect();
    let mut known_session_ids = shaped
        .iter()
        .filter_map(|session| session.get("session_id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<HashSet<_>>();
    for session in session_store::list_local_sessions()? {
        let Some(session_id) = session.get("session_id").and_then(Value::as_str) else {
            continue;
        };
        if known_session_ids.insert(session_id.to_string()) {
            shaped.push(session);
        }
    }
    if shaped.is_empty() {
        if let Some(err) = acp_list_error {
            return Err(err);
        }
    }
    let filtered = filter_sessions(shaped, q.as_deref(), archived);

    let page: Vec<Value> = filtered
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();

    let mut result = Value::Array(page);
    attach_acp_runtime_status_to_sessions(&mut result, &acp_wire);
    Ok(result)
}

#[tauri::command]
pub async fn get_session(
    app: tauri::AppHandle,
    acp_desktop: tauri::State<'_, AcpDesktopClient>,
    acp_wire: tauri::State<'_, AcpProcessManager>,
    session_id: String,
) -> Result<Value, String> {
    let mut result = match fetch_all_acp_sessions(&acp_desktop, &app).await {
        Ok(raw_sessions) => {
            if let Some(raw) = find_session_in_list(&raw_sessions, &session_id) {
                let mut shaped = shape_acp_session_to_legacy(&raw);
                session_store::merge_local_metadata_into_legacy(&mut shaped, &session_id);
                shaped
            } else {
                session_store::read_local_session(&session_id)?
            }
        }
        Err(acp_err) => match session_store::read_local_session(&session_id) {
            Ok(local) => local,
            Err(_) => return Err(acp_err),
        },
    };
    attach_acp_runtime_status_to_session(&mut result, &acp_wire);
    Ok(result)
}

#[tauri::command]
pub async fn replay_session_history(
    _app: tauri::AppHandle,
    session_id: String,
) -> Result<Value, String> {
    let messages = session_store::replay_session_history(&session_id)?;
    Ok(Value::Array(
        messages.into_iter().map(Value::String).collect(),
    ))
}

#[tauri::command]
pub fn get_session_swarm_mode(session_id: String) -> Result<bool, String> {
    session_store::session_swarm_mode(&session_id)
}

#[tauri::command]
pub fn migrate_session_swarm_mode(session_id: String, enabled: bool) -> Result<(), String> {
    session_store::update_session_swarm_mode(&session_id, enabled)?;
    Ok(())
}

#[tauri::command]
pub async fn create_session(
    app: tauri::AppHandle,
    acp_desktop: tauri::State<'_, AcpDesktopClient>,
    acp_wire: tauri::State<'_, AcpProcessManager>,
    work_dir: Option<String>,
    create_dir: Option<bool>,
) -> Result<Value, String> {
    let create_dir = create_dir.unwrap_or(false);
    let resolved_work_dir = resolve_create_session_work_dir(work_dir.as_deref(), create_dir)?;

    let response = acp_desktop
        .request(
            &app,
            "session/new",
            session_new_params(&resolved_work_dir, false),
        )
        .await?;

    if response.error.is_some() {
        return Err(format!(
            "ACP session/new failed: {}",
            response
                .error
                .as_ref()
                .and_then(|error| error.message.clone())
                .unwrap_or_else(|| "unknown error".to_string())
        ));
    }

    let result = response.result.unwrap_or(Value::Null);
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "ACP session/new returned no sessionId".to_string())?;

    get_session(app, acp_desktop, acp_wire, session_id).await
}

#[tauri::command]
pub async fn delete_session(
    app: tauri::AppHandle,
    acp_desktop: tauri::State<'_, AcpDesktopClient>,
    acp_wire: tauri::State<'_, AcpProcessManager>,
    session_id: String,
) -> Result<(), String> {
    acp_wire.ensure_editable(&session_id)?;
    acp_wire.disconnect(&app, session_id.clone()).await?;

    let close_response = acp_desktop
        .request(&app, "session/close", json!({ "sessionId": session_id }))
        .await?;

    if close_response.error.is_some() && !session_store::is_method_not_found(&close_response) {
        return Err(format!(
            "ACP session/close failed: {}",
            close_response
                .error
                .as_ref()
                .and_then(|error| error.message.clone())
                .unwrap_or_else(|| "unknown error".to_string())
        ));
    }

    session_store::delete_session_dir(&session_id)?;

    Ok(())
}

#[tauri::command]
pub async fn update_session(
    app: tauri::AppHandle,
    acp_desktop: tauri::State<'_, AcpDesktopClient>,
    acp_wire: tauri::State<'_, AcpProcessManager>,
    session_id: String,
    title: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    acp_wire.ensure_editable(&session_id)?;

    if title.is_none() && archived.is_none() {
        return get_session(app, acp_desktop, acp_wire, session_id).await;
    }

    session_store::update_session_state(&session_id, title.as_deref(), archived)?;

    get_session(app, acp_desktop, acp_wire, session_id).await
}

#[tauri::command]
pub async fn fork_session(_session_id: String, _turn_index: u64) -> Result<Value, String> {
    Err("fork_session requires Kimi Code CLI support; not available via ACP yet".to_string())
}

#[tauri::command]
pub async fn generate_title(session_id: String) -> Result<Value, String> {
    let title = session_store::fallback_title_from_wire(&session_id)?;
    session_store::update_session_state(&session_id, Some(&title), None)?;
    Ok(json!({ "title": title }))
}

#[tauri::command]
pub async fn upload_session_file(
    _app: tauri::AppHandle,
    state: tauri::State<'_, AcpProcessManager>,
    session_id: String,
    filename: String,
    data: Vec<u8>,
) -> Result<Value, String> {
    state.ensure_editable(&session_id)?;
    let session_dir = session_store::find_session_dir_by_id_or_err(&session_id)?;
    session_files::upload_session_file_to_dir(&session_dir, &filename, &data)
}

#[tauri::command]
pub async fn list_session_directory(
    app: tauri::AppHandle,
    acp_desktop: tauri::State<'_, AcpDesktopClient>,
    session_id: String,
    path: Option<String>,
) -> Result<Value, String> {
    let work_dir = session_files::resolve_session_work_dir(&app, &acp_desktop, &session_id).await?;
    let rel_path = path.unwrap_or_else(|| ".".to_string());
    let dir_path = session_files::resolve_session_file(&work_dir, &rel_path)?;
    let entries = session_files::list_directory_entries(&dir_path)?;
    Ok(Value::Array(entries))
}

#[tauri::command]
pub async fn get_session_file(
    app: tauri::AppHandle,
    acp_desktop: tauri::State<'_, AcpDesktopClient>,
    session_id: String,
    path: String,
) -> Result<Value, String> {
    let work_dir = session_files::resolve_session_work_dir(&app, &acp_desktop, &session_id).await?;
    let file_path = session_files::resolve_session_file(&work_dir, &path)?;
    session_files::read_session_file_payload(&file_path)
}

#[tauri::command]
pub async fn get_session_upload_file(
    _app: tauri::AppHandle,
    session_id: String,
    filename: String,
) -> Result<Value, String> {
    let session_dir = session_store::find_session_dir_by_id_or_err(&session_id)?;
    let uploads_dir = session_dir.join("uploads");
    if !uploads_dir.is_dir() {
        return Err("Uploads directory not found".to_string());
    }
    let file_path = session_files::resolve_session_file(&uploads_dir, &filename)?;
    session_files::read_session_file_payload(&file_path)
}

#[tauri::command]
pub async fn list_work_dirs(
    app: tauri::AppHandle,
    acp_desktop: tauri::State<'_, AcpDesktopClient>,
) -> Result<Value, String> {
    let mut work_dirs = Vec::new();
    let mut seen = HashSet::new();

    for dir in session_files::work_dirs_from_metadata()? {
        if is_hidden_work_dir(&dir) || !Path::new(&dir).exists() || !seen.insert(dir.clone()) {
            continue;
        }
        work_dirs.push(dir);
        if work_dirs.len() >= 20 {
            break;
        }
    }

    let raw_sessions = match fetch_all_acp_sessions(&acp_desktop, &app).await {
        Ok(sessions) => sessions,
        Err(err) => {
            eprintln!("[list_work_dirs] ACP session/list failed, using metadata only: {err}");
            Vec::new()
        }
    };

    for session in raw_sessions {
        let Some(cwd) = session.get("cwd").and_then(Value::as_str) else {
            continue;
        };
        if is_hidden_work_dir(cwd) || !Path::new(cwd).exists() || !seen.insert(cwd.to_string()) {
            continue;
        }
        work_dirs.push(cwd.to_string());
        if work_dirs.len() >= 20 {
            break;
        }
    }

    Ok(json!(work_dirs))
}

#[tauri::command]
pub async fn get_startup_dir(_app: tauri::AppHandle) -> Result<Value, String> {
    Ok(json!(resolve_startup_dir()?))
}

fn resolve_startup_dir() -> Result<String, String> {
    for dir in session_files::work_dirs_from_metadata()? {
        if is_hidden_work_dir(&dir) || !Path::new(&dir).exists() {
            continue;
        }
        return Ok(dir);
    }

    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(|path| PathBuf::from(path).to_string_lossy().to_string())
        .ok_or_else(|| "Failed to resolve startup directory".to_string())
}

#[tauri::command]
pub fn get_global_config() -> Result<Value, String> {
    global_config::get_global_config()
}

#[tauri::command]
pub fn get_config_toml() -> Result<Value, String> {
    read_kimi_config_file("config.toml", "")
}

#[tauri::command]
pub fn update_config_toml(content: String) -> Result<Value, String> {
    validate_toml(&content)?;
    write_kimi_config_file("config.toml", &content)
}

#[tauri::command]
pub fn get_mcp_config() -> Result<Value, String> {
    read_kimi_config_file("mcp.json", DEFAULT_MCP_JSON)
}

#[tauri::command]
pub fn update_mcp_config(content: String) -> Result<Value, String> {
    validate_mcp_config(&content)?;
    write_kimi_config_file("mcp.json", &content)
}

#[tauri::command]
pub async fn update_global_config(
    app: tauri::AppHandle,
    acp_wire: tauri::State<'_, AcpProcessManager>,
    default_model: Option<String>,
    default_thinking: Option<bool>,
    thinking_effort: Option<String>,
    default_plan_mode: Option<bool>,
    restart_running_sessions: Option<bool>,
    force_restart_busy_sessions: Option<bool>,
) -> Result<Value, String> {
    let restart_running = restart_running_sessions.unwrap_or(true);
    let force = force_restart_busy_sessions.unwrap_or(false);
    let config = global_config::update_global_config_fields(
        default_model.as_deref(),
        default_thinking,
        thinking_effort.as_deref(),
        default_plan_mode,
    )?;

    let summary = if restart_running {
        acp_wire
            .restart_running_workers(&app, "config_update", force)
            .await
    } else {
        RestartWorkersSummary {
            restarted_session_ids: Vec::new(),
            skipped_busy_session_ids: Vec::new(),
        }
    };

    Ok(json!({
        "config": config,
        "restarted_session_ids": if summary.restarted_session_ids.is_empty() { Value::Null } else { json!(summary.restarted_session_ids) },
        "skipped_busy_session_ids": if summary.skipped_busy_session_ids.is_empty() { Value::Null } else { json!(summary.skipped_busy_session_ids) },
    }))
}

#[tauri::command]
pub async fn get_git_diff_stats(
    app: tauri::AppHandle,
    acp_desktop: tauri::State<'_, AcpDesktopClient>,
    session_id: String,
) -> Result<Value, String> {
    let work_dir = session_files::resolve_session_work_dir(&app, &acp_desktop, &session_id).await?;
    Ok(git_diff::get_git_diff_stats_for_work_dir(&work_dir))
}

#[tauri::command]
pub fn show_window(window: tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.center();
    let _ = window.set_focus();
}

#[tauri::command]
pub fn hide_window(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn get_kimi_cli_version(_app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(runtime_check::resolve_kimi_code_cli_version_blocking)
        .await
        .map_err(|e| format!("Failed to join Kimi Code CLI version lookup: {}", e))?
}

#[tauri::command]
pub async fn fetch_managed_usage() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(crate::managed_usage::fetch_managed_usage)
        .await
        .map_err(|e| format!("Failed to join managed usage fetch: {e}"))
}

#[tauri::command]
pub async fn fetch_usage_stats(range: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || crate::usage_stats::fetch_usage_stats(&range))
        .await
        .map_err(|e| format!("Failed to join usage stats fetch: {e}"))?
}

#[tauri::command]
pub async fn check_runtime_readiness(
    app: tauri::AppHandle,
) -> Result<runtime_check::RuntimeReadiness, String> {
    Ok(runtime_check::check_runtime_readiness(&app).await)
}

#[tauri::command]
pub async fn open_kimi_login() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let program = resolve_acp_command_validated()?;
        launch_kimi_login_terminal(&program)?;
        Ok(json!({
            "success": true,
            "program": program,
        }))
    })
    .await
    .map_err(|e| format!("Failed to join login launcher: {}", e))?
}

#[tauri::command]
pub async fn start_kimi_login() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(crate::oauth_login::start_kimi_login)
        .await
        .map_err(|e| format!("Failed to join start_kimi_login: {e}"))?
}

#[tauri::command]
pub async fn poll_kimi_login(login_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || crate::oauth_login::poll_kimi_login(&login_id))
        .await
        .map_err(|e| format!("Failed to join poll_kimi_login: {e}"))?
}

#[tauri::command]
pub async fn cancel_kimi_login(login_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || crate::oauth_login::cancel_kimi_login(&login_id))
        .await
        .map_err(|e| format!("Failed to join cancel_kimi_login: {e}"))?
}

#[tauri::command]
pub async fn kimi_credentials_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(crate::managed_usage::kimi_credentials_status)
        .await
        .map_err(|e| format!("Failed to join kimi_credentials_status: {e}"))
}

#[tauri::command]
pub async fn logout_kimi() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(crate::managed_usage::logout_kimi)
        .await
        .map_err(|e| format!("Failed to join logout_kimi: {e}"))
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    validate_http_external_url(&url)?;
    open::that_detached(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let path_obj = validate_local_absolute_path(&path)?;
    let path = path_obj.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        if path_obj.is_file() {
            std::process::Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_in_editor(path: String, editor: String) -> Result<(), String> {
    let path_obj = validate_local_absolute_path(&path)?;
    let path = path_obj.to_string_lossy().to_string();
    let bin = match editor.as_str() {
        "vscode" => "code",
        "cursor" => "cursor",
        _ => return Err(format!("Unsupported editor: {}", editor)),
    };

    open::with_detached(path, bin).map_err(|e| e.to_string())
}

fn attach_acp_runtime_status_to_sessions(value: &mut Value, manager: &AcpProcessManager) {
    if let Value::Array(items) = value {
        for item in items {
            attach_acp_runtime_status_to_session(item, manager);
        }
    }
}

fn attach_acp_runtime_status_to_session(value: &mut Value, manager: &AcpProcessManager) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let Some(session_id) = obj
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    obj.insert(
        "is_running".to_string(),
        Value::Bool(manager.is_running(&session_id)),
    );
    if let Some(status) = manager.get_status(&session_id) {
        obj.insert("status".to_string(), json!(status));
    }
}

fn resolve_create_session_work_dir(
    work_dir: Option<&str>,
    create_dir: bool,
) -> Result<String, String> {
    if let Some(work_dir) = work_dir {
        let path = PathBuf::from(work_dir);
        if !path.exists() {
            if create_dir {
                fs::create_dir_all(&path)
                    .map_err(|e| format!("Failed to create directory {}: {e}", path.display()))?;
            } else {
                return Err(format!("Directory does not exist: {work_dir}"));
            }
        }
        if !path.is_dir() {
            return Err(format!("Path is not a directory: {work_dir}"));
        }
        return Ok(path.to_string_lossy().to_string());
    }

    std::env::current_dir()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to resolve startup directory: {e}"))
}

fn launch_kimi_login_terminal(program: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .arg("/D")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg("cmd")
            .arg("/D")
            .arg("/K")
            .arg(program)
            .arg("login")
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open login terminal: {}", e))
    }

    #[cfg(target_os = "macos")]
    {
        // Pass program via osascript argv — never interpolate into the AppleScript string.
        Command::new("osascript")
            .arg("-e")
            .arg(
                r#"on run argv
tell application "Terminal"
  do script (quoted form of (item 1 of argv) & " login")
  activate
end tell
end run"#,
            )
            .arg(program)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open login terminal: {}", e))
    }

    #[cfg(target_os = "linux")]
    {
        // Argv-only launches — do not build a shell -lc string from the binary path.
        let terminals: &[(&str, &[&str])] = &[
            ("gnome-terminal", &["--"]),
            ("konsole", &["-e"]),
            ("x-terminal-emulator", &["-e"]),
            ("xterm", &["-e"]),
        ];

        let mut errors = Vec::new();
        for (terminal, prefix) in terminals {
            let mut process = Command::new(terminal);
            process.args(*prefix).arg(program).arg("login");
            match process.spawn() {
                Ok(_) => return Ok(()),
                Err(error) => errors.push(format!("{}: {}", terminal, error)),
            }
        }

        Err(format!(
            "Failed to open a terminal for Kimi login ({})",
            errors.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::security::{validate_http_external_url, validate_mcp_config_json};
    use crate::test_env::lock::set_kimi_code_home;

    #[test]
    fn open_external_rejects_non_http_schemes() {
        assert!(validate_http_external_url("file:///etc/passwd").is_err());
        assert!(validate_http_external_url("javascript:alert(1)").is_err());
        validate_http_external_url("https://example.com").unwrap();
    }

    #[test]
    fn update_mcp_config_rejects_temp_command_paths() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let exe = dir.path().join("evil.exe");
        std::fs::write(&exe, b"fake").expect("write fake exe");
        let config = serde_json::json!({
            "mcpServers": {
                "bad": { "command": exe.to_string_lossy() }
            }
        });
        assert!(validate_mcp_config_json(&config).is_err());
    }

    #[test]
    fn runtime_backend_is_acp_only() {
        use crate::runtime_backend::{runtime_backend_from_env_value, RuntimeBackend};

        assert_eq!(runtime_backend_from_env_value(None), RuntimeBackend::Acp);
        assert_eq!(
            runtime_backend_from_env_value(Some("legacy")),
            RuntimeBackend::Acp
        );
    }

    #[test]
    fn resolve_startup_dir_prefers_recent_work_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let work_dir = temp.path().join("project");
        std::fs::create_dir_all(&work_dir).expect("work dir");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::write(
            home.join("kimi.json"),
            format!(
                r#"{{"work_dirs":[{{"path":"{}"}}]}}"#,
                work_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("metadata");

        let _home_guard = set_kimi_code_home(&home);
        let startup = super::resolve_startup_dir().expect("startup dir");
        assert_eq!(startup, work_dir.to_string_lossy().to_string());
    }

    #[test]
    fn resolve_create_session_work_dir_requires_existing_path() {
        let err = super::resolve_create_session_work_dir(Some("/nonexistent/path/xyz"), false)
            .unwrap_err();
        assert!(err.contains("does not exist"));
    }
}
