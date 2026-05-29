use crate::sidecar::{call_desktop_api, WireProcessManager};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const KIMI_CLI_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_MCP_JSON: &str = "{\n  \"mcpServers\": {}\n}\n";

#[derive(Deserialize)]
struct KimiMetadata {
    #[serde(default)]
    work_dirs: Vec<KimiWorkDir>,
}

#[derive(Deserialize)]
struct KimiWorkDir {
    path: String,
}

fn user_home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve user home directory".to_string())
}

fn kimi_config_path(file_name: &str) -> Result<PathBuf, String> {
    Ok(user_home_dir()?.join(".kimi").join(file_name))
}

fn kimi_metadata_path() -> Result<PathBuf, String> {
    kimi_config_path("kimi.json")
}

fn is_hidden_work_dir(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized == "/tmp" || normalized.starts_with("/var/folders") || normalized.contains("/.cache/")
}

fn list_work_dirs_fast() -> Result<Value, String> {
    let path = kimi_metadata_path()?;
    if !path.exists() {
        return Ok(json!([]));
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let metadata: KimiMetadata =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;
    let work_dirs: Vec<String> = metadata
        .work_dirs
        .into_iter()
        .filter_map(|wd| {
            let work_dir = wd.path;
            if is_hidden_work_dir(&work_dir) || !Path::new(&work_dir).exists() {
                return None;
            }
            Some(work_dir)
        })
        .take(20)
        .collect();
    Ok(json!(work_dirs))
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

    fs::write(&path, content)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

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

fn validate_json(content: &str) -> Result<(), String> {
    serde_json::from_str::<Value>(content)
        .map(|_| ())
        .map_err(|e| format!("Invalid JSON: {}", e))
}

#[tauri::command]
pub async fn wire_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
) -> Result<(), String> {
    state.connect(&app, session_id).await
}

#[tauri::command]
pub async fn wire_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
) -> Result<(), String> {
    state.disconnect(&app, session_id).await
}

#[tauri::command]
pub async fn wire_send(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    state.send(&app, session_id, message).await
}

#[tauri::command]
pub fn wire_status(
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
) -> Result<Option<crate::sidecar::RuntimeStatus>, String> {
    Ok(state.get_status(&session_id))
}

#[tauri::command]
pub async fn list_sessions(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    limit: Option<u64>,
    offset: Option<u64>,
    q: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    let mut result = call_desktop_api(
        &app,
        "list_sessions",
        json!({
            "limit": limit.unwrap_or(100),
            "offset": offset.unwrap_or(0),
            "q": q,
            "archived": archived,
        }),
    )
    .await?;
    attach_runtime_status_to_sessions(&mut result, &state);
    Ok(result)
}

#[tauri::command]
pub async fn get_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
) -> Result<Value, String> {
    let mut result = call_desktop_api(&app, "get_session", json!({"session_id": session_id})).await?;
    attach_runtime_status_to_session(&mut result, &state);
    Ok(result)
}

#[tauri::command]
pub async fn replay_session_history(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Value, String> {
    call_desktop_api(&app, "replay_session_history", json!({"session_id": session_id})).await
}

#[tauri::command]
pub async fn create_session(
    app: tauri::AppHandle,
    work_dir: Option<String>,
    create_dir: Option<bool>,
) -> Result<Value, String> {
    call_desktop_api(
        &app,
        "create_session",
        json!({"work_dir": work_dir, "create_dir": create_dir.unwrap_or(false)}),
    )
    .await
}

#[tauri::command]
pub async fn delete_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
) -> Result<(), String> {
    state.ensure_editable(&session_id)?;
    state.stop_session(&app, &session_id, "delete").await?;
    call_desktop_api(&app, "delete_session", json!({"session_id": session_id})).await?;
    Ok(())
}

#[tauri::command]
pub async fn update_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
    title: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    state.ensure_editable(&session_id)?;
    let mut result = call_desktop_api(
        &app,
        "update_session",
        json!({"session_id": session_id, "title": title, "archived": archived}),
    )
    .await?;
    attach_runtime_status_to_session(&mut result, &state);
    Ok(result)
}

#[tauri::command]
pub async fn fork_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
    turn_index: u64,
) -> Result<Value, String> {
    state.ensure_editable(&session_id)?;
    call_desktop_api(
        &app,
        "fork_session",
        json!({"session_id": session_id, "turn_index": turn_index}),
    )
    .await
}

#[tauri::command]
pub async fn generate_title(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
) -> Result<Value, String> {
    state.ensure_editable(&session_id)?;
    call_desktop_api(&app, "generate_title", json!({"session_id": session_id})).await
}

#[tauri::command]
pub async fn upload_session_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    session_id: String,
    filename: String,
    data: Vec<u8>,
) -> Result<Value, String> {
    state.ensure_editable(&session_id)?;
    call_desktop_api(
        &app,
        "upload_session_file",
        json!({"session_id": session_id, "filename": filename, "data": data}),
    )
    .await
}

#[tauri::command]
pub async fn list_session_directory(
    app: tauri::AppHandle,
    session_id: String,
    path: Option<String>,
) -> Result<Value, String> {
    call_desktop_api(
        &app,
        "list_session_directory",
        json!({"session_id": session_id, "path": path.unwrap_or_else(|| ".".to_string())}),
    )
    .await
}

#[tauri::command]
pub async fn get_session_file(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
) -> Result<Value, String> {
    call_desktop_api(&app, "get_session_file", json!({"session_id": session_id, "path": path})).await
}

#[tauri::command]
pub async fn get_session_upload_file(
    app: tauri::AppHandle,
    session_id: String,
    filename: String,
) -> Result<Value, String> {
    call_desktop_api(
        &app,
        "get_session_upload_file",
        json!({"session_id": session_id, "filename": filename}),
    )
    .await
}

#[tauri::command]
pub async fn list_work_dirs(app: tauri::AppHandle) -> Result<Value, String> {
    match list_work_dirs_fast() {
        Ok(result) => Ok(result),
        Err(err) => {
            eprintln!("[commands] list_work_dirs fast path failed: {}", err);
            call_desktop_api(&app, "list_work_dirs", json!({})).await
        }
    }
}

#[tauri::command]
pub async fn get_startup_dir(_app: tauri::AppHandle) -> Result<Value, String> {
    std::env::current_dir()
        .map(|path| json!(path.to_string_lossy().to_string()))
        .map_err(|e| format!("Failed to resolve startup directory: {}", e))
}

#[tauri::command]
pub async fn get_global_config(app: tauri::AppHandle) -> Result<Value, String> {
    call_desktop_api(&app, "get_global_config", json!({})).await
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
    validate_json(&content)?;
    write_kimi_config_file("mcp.json", &content)
}

#[tauri::command]
pub async fn update_global_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, WireProcessManager>,
    default_model: Option<String>,
    default_thinking: Option<bool>,
    restart_running_sessions: Option<bool>,
    force_restart_busy_sessions: Option<bool>,
) -> Result<Value, String> {
    let restart_running = restart_running_sessions.unwrap_or(true);
    let force = force_restart_busy_sessions.unwrap_or(false);
    let config = call_desktop_api(
        &app,
        "update_global_config",
        json!({
            "default_model": default_model,
            "default_thinking": default_thinking,
        }),
    )
    .await?;

    let summary = if restart_running {
        state
            .restart_running_workers(&app, "config_update", force)
            .await
    } else {
        crate::sidecar::RestartWorkersSummary {
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
    session_id: String,
) -> Result<Value, String> {
    call_desktop_api(&app, "get_git_diff_stats", json!({"session_id": session_id})).await
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
pub async fn get_kimi_cli_version() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(resolve_kimi_cli_version)
        .await
        .map_err(|e| format!("Failed to join version probe: {}", e))?
}

#[tauri::command]
pub async fn open_kimi_login() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let program = resolve_kimi_cli_program()?;
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
pub fn open_external(url: String) -> Result<(), String> {
    open::that_detached(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let path_obj = std::path::Path::new(&path);
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
    let bin = match editor.as_str() {
        "vscode" => "code",
        "cursor" => "cursor",
        _ => return Err(format!("Unsupported editor: {}", editor)),
    };

    open::with_detached(path, bin).map_err(|e| e.to_string())
}

fn attach_runtime_status_to_sessions(
    value: &mut Value,
    manager: &tauri::State<'_, WireProcessManager>,
) {
    if let Value::Array(items) = value {
        for item in items {
            attach_runtime_status_to_session(item, manager);
        }
    }
}

fn attach_runtime_status_to_session(
    value: &mut Value,
    manager: &tauri::State<'_, WireProcessManager>,
) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    let Some(session_id) = obj.get("session_id").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    obj.insert("is_running".to_string(), Value::Bool(manager.is_running(&session_id)));
    if let Some(status) = manager.get_status(&session_id) {
        obj.insert("status".to_string(), json!(status));
    }
}

fn resolve_kimi_cli_version() -> Result<String, String> {
    if let Ok(version) = std::env::var("KIMI_CLI_VERSION") {
        let trimmed = version.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let mut errors = Vec::new();
    for program in kimi_cli_version_candidates() {
        match run_kimi_version_command(&program) {
            Ok(output) => {
                if let Some(version) = parse_version_from_output(&output) {
                    return Ok(version);
                }
                errors.push(format!("{} returned unparseable output: {}", program, output.trim()));
            }
            Err(error) => errors.push(format!("{}: {}", program, error)),
        }
    }

    Err(format!("Unable to resolve Kimi CLI version ({})", errors.join("; ")))
}

fn resolve_kimi_cli_program() -> Result<String, String> {
    let mut errors = Vec::new();
    for program in kimi_cli_version_candidates() {
        match run_kimi_version_command(&program) {
            Ok(_) => return Ok(program),
            Err(error) => errors.push(format!("{}: {}", program, error)),
        }
    }

    Err(format!("Unable to find Kimi CLI ({})", errors.join("; ")))
}

fn kimi_cli_version_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Ok(bin) = std::env::var("KIMI_CLI_BIN") {
        let trimmed = bin.trim();
        if !trimmed.is_empty() {
            candidates.push(trimmed.to_string());
        }
    }

    candidates.push("kimi".to_string());

    #[cfg(target_os = "windows")]
    {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let path = std::path::Path::new(&user_profile)
                .join(".local")
                .join("bin")
                .join("kimi.exe");
            candidates.push(path.to_string_lossy().to_string());
        }
    }

    candidates.dedup();
    candidates
}

fn launch_kimi_login_terminal(program: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let command = format!("\"{}\" login", program);
        Command::new("cmd")
            .args(["/C", "start", "Kimi Code Login", "cmd", "/K", &command])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open login terminal: {}", e))
    }

    #[cfg(target_os = "macos")]
    {
        let escaped = program.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "tell application \"Terminal\" to do script \"\\\"{}\\\" login\"\ntell application \"Terminal\" to activate",
            escaped
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open login terminal: {}", e))
    }

    #[cfg(target_os = "linux")]
    {
        let command = format!("\"{}\" login; echo; read -p 'Press Enter to close...'", program);
        let terminals: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["-e", "sh", "-lc"]),
            ("gnome-terminal", &["--", "sh", "-lc"]),
            ("konsole", &["-e", "sh", "-lc"]),
            ("xterm", &["-e", "sh", "-lc"]),
        ];

        let mut errors = Vec::new();
        for (terminal, args) in terminals {
            let mut process = Command::new(terminal);
            process.args(*args).arg(&command);
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

fn run_kimi_version_command(program: &str) -> Result<String, String> {
    let mut child = Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let started_at = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => {
                let output = child.wait_with_output().map_err(|e| e.to_string())?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let combined = format!("{}{}", stdout, stderr);
                if output.status.success() {
                    return Ok(combined);
                }
                return Err(format!(
                    "exited with status {}: {}",
                    output.status,
                    combined.trim()
                ));
            }
            None if started_at.elapsed() >= KIMI_CLI_VERSION_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out while running --version".to_string());
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn parse_version_from_output(output: &str) -> Option<String> {
    output
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '+'))
        .find(|token| {
            token.contains('.')
                && token
                    .chars()
                    .next()
                    .map(|ch| ch.is_ascii_digit())
                    .unwrap_or(false)
        })
        .map(str::to_string)
}
