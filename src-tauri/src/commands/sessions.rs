//! Sessions-family Tauri commands over the source runtime (M4 wave 1).
//!
//! The seventeen commands replace the pre-cutover adapters that talked to an
//! external installed-CLI session RPC and its per-session wire manager:
//!
//! - `list_sessions` / `get_session` stay local-first (on-disk metadata seed)
//!   and enrich from the runtime `sessions.*` family through the typed
//!   [`RuntimeClient`]. Session descriptors are shaped onto the legacy JSON
//!   the frontend consumes (`shape_runtime_session_to_legacy`), overlaid with
//!   local title/archive overrides (`session_store::merge_local_metadata_into_legacy`),
//!   then Rust-side filtered/paged, and finally projected with host session
//!   status (`is_running`/`status` replace the ACP `attach_*_runtime_status`).
//! - `create_session` resolves the work dir locally, then `sessions.create`;
//!   the session config snapshot is no longer seeded from the response — the
//!   host pump captures `session.config` events instead.
//! - `delete_session` guards on host in-flight turns, best-effort
//!   `session.close`, `sessions.delete` (tolerating `session_not_found`), and
//!   finally removes the local session dir.
//! - `update_session` (title/archived) is purely local — it never calls the
//!   runtime — and `fork_session` keeps an explicit error because the
//!   frontend always requests turn-granularity copies, which the engine does
//!   not support.
//! - `replay_session_history` stays a Rust-direct read of the persisted
//!   wire.jsonl (unchanged).
//!
//! Threading: every command that can touch the runtime runs its body inside
//! `tauri::async_runtime::spawn_blocking`, taking `app.state::<RuntimeHost>()`
//! inside the closure (`use tauri::Manager`), mirroring `commands/auth.rs`.

use crate::runtime::client::{
    RuntimeClient, SessionDescriptor, SessionsCreateParams, SessionsListParams,
};
use crate::runtime::host::RuntimeHost;
use crate::runtime::supervisor::RuntimeError;
use crate::session_files;
use crate::session_influence;
use crate::session_store;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

/// Bounded runtime call budget for CRUD session calls, matching the host's
/// `CALL_TIMEOUT` for request/response calls.
const SESSIONS_CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Bounded per-page budget for non-critical `sessions.list` enrichment.
/// Listing must not sit behind the full RPC timeout under VPN/cold auth; a
/// timed-out page falls back to the local cache.
const SESSIONS_LIST_PAGE_TIMEOUT: Duration = Duration::from_secs(8);
/// Cap on work-dir entries returned by `list_work_dirs`.
const MAX_WORK_DIRS: usize = 20;
/// Busy-guard message, verbatim from the ACP `ensure_editable` behavior.
const SESSION_BUSY_MESSAGE: &str =
    "Session is busy. Please wait for it to complete before modifying.";

/// Map a runtime `SessionDescriptor` onto the legacy session shape the
/// frontend consumes. Field-for-field mirror of the pre-cutover mapper:
/// `session_id`, `title` (default "Untitled"), `work_dir` (`cwd`),
/// `last_updated` (`updatedAt`), `archived`.
fn shape_runtime_session_to_legacy(descriptor: &SessionDescriptor) -> Value {
    json!({
        "session_id": descriptor.session_id.clone(),
        "title": descriptor.title.clone().unwrap_or_else(|| "Untitled".to_string()),
        "work_dir": descriptor.cwd.clone(),
        "last_updated": descriptor.updated_at.clone().unwrap_or(Value::Null),
        "archived": descriptor.archived.unwrap_or(false),
    })
}

/// Filter legacy-shaped sessions by title query and archive state. Moved
/// verbatim from the pre-cutover session RPC module during the M4 cutover;
/// the wire-era copy was deleted together with that module.
fn filter_sessions(sessions: Vec<Value>, q: Option<&str>, archived: Option<bool>) -> Vec<Value> {
    // Match web API: omitted archived filter means active (non-archived) only.
    let archived_filter = archived.unwrap_or(false);
    sessions
        .into_iter()
        .filter(|session| {
            let session_archived = session
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if session_archived != archived_filter {
                return false;
            }
            if let Some(query) = q {
                let query = query.to_ascii_lowercase();
                let title = session
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !title.contains(&query) {
                    return false;
                }
            }
            true
        })
        .collect()
}

/// Command-level error mapping, mirroring the auth family: a runtime
/// `Rejected` (well-formed `ok: false`) surfaces its code/message verbatim;
/// fatal failures (protocol, io, timeout, unexpected exit, readiness) surface
/// as an operation failure.
fn runtime_error_message(operation: &str, err: RuntimeError) -> String {
    match err {
        RuntimeError::Rejected(body) => {
            format!("{operation} rejected: {}: {}", body.code, body.message)
        }
        other => format!("{operation} failed: {other}"),
    }
}

/// Enumerate every runtime session via cursor pagination. Per-page calls are
/// bounded by [`SESSIONS_LIST_PAGE_TIMEOUT`] so a wedged runtime degrades to
/// the local cache instead of hanging the sidebar.
fn fetch_runtime_sessions_soft(host: &RuntimeHost) -> Result<Vec<SessionDescriptor>, String> {
    const MAX_RUNTIME_SESSION_PAGES: usize = 100;
    const MAX_RUNTIME_SESSIONS: usize = 10_000;

    let supervisor = host.ensure_started()?;
    let client = RuntimeClient::new(&supervisor);
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_RUNTIME_SESSION_PAGES {
        let params = SessionsListParams {
            cursor: cursor.clone(),
            limit: Some(100),
            workspace_id: None,
        };
        let page = client
            .sessions_list(&params, SESSIONS_LIST_PAGE_TIMEOUT)
            .map_err(|err| runtime_error_message("sessions.list", err))?;
        all.extend(page.sessions);
        if all.len() > MAX_RUNTIME_SESSIONS {
            return Err(format!(
                "runtime sessions.list exceeded maximum session count ({MAX_RUNTIME_SESSIONS})"
            ));
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            return Ok(all);
        }
    }
    Err(format!(
        "runtime sessions.list exceeded maximum page count ({MAX_RUNTIME_SESSION_PAGES})"
    ))
}

/// Project host session state onto legacy-shaped session JSON (`is_running`
/// from the open lease, `status` from the last projected `session.status`).
/// Replaces the ACP `attach_acp_runtime_status_to_*` helpers.
fn attach_host_runtime_status_to_sessions(value: &mut Value, host: &RuntimeHost) {
    if let Value::Array(items) = value {
        for item in items {
            attach_host_runtime_status_to_session(item, host);
        }
    }
}

fn attach_host_runtime_status_to_session(value: &mut Value, host: &RuntimeHost) {
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
        Value::Bool(host.is_session_open(&session_id)),
    );
    if let Some(status) = host.session_status(&session_id) {
        if let Ok(status_json) = serde_json::to_value(status) {
            obj.insert("status".to_string(), status_json);
        }
    }
}

/// Whether a session is mid-turn from the host's perspective: any in-flight
/// request id, or a projected `busy` status. Read-only table projection — no
/// runtime call, so cold-runtime local edits stay fast.
fn host_session_busy(host: &RuntimeHost, session_id: &str) -> bool {
    if !host.in_flight_turns(session_id).is_empty() {
        return true;
    }
    host.session_status(session_id)
        .is_some_and(|status| status.state == "busy")
}

#[tauri::command]
pub async fn list_sessions(
    app: tauri::AppHandle,
    limit: Option<u64>,
    offset: Option<u64>,
    q: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let offset = offset.unwrap_or(0);

    // Local-first: seed from disk so the sidebar is not blocked on a cold
    // runtime spawn.
    let mut shaped: Vec<Value> = Vec::new();
    let mut known_session_ids = HashSet::new();
    for session in session_store::list_local_sessions().unwrap_or_default() {
        let Some(session_id) = session.get("session_id").and_then(Value::as_str) else {
            continue;
        };
        if known_session_ids.insert(session_id.to_string()) {
            shaped.push(session);
        }
    }
    let has_local = !shaped.is_empty();

    // Enrich only when we have nothing local yet. With a warm cache, waiting
    // on the runtime (cold spawn / VPN) makes the sidebar feel stuck.
    let runtime_list_error = if has_local {
        None
    } else {
        let app_for_list = app.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            let host = app_for_list.state::<RuntimeHost>();
            host.install_app(&app_for_list);
            fetch_runtime_sessions_soft(&host)
        })
        .await
        .map_err(|e| format!("Failed to join list_sessions enrichment: {e}"))?
        {
            Ok(descriptors) => {
                for descriptor in descriptors {
                    let mut legacy = shape_runtime_session_to_legacy(&descriptor);
                    let Some(session_id) = legacy
                        .get("session_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                    else {
                        continue;
                    };
                    session_store::merge_local_metadata_into_legacy(&mut legacy, &session_id);
                    if known_session_ids.insert(session_id) {
                        shaped.push(legacy);
                    }
                }
                None
            }
            Err(err) => {
                eprintln!(
                    "[list_sessions] runtime sessions.list failed, using local sessions: {err}"
                );
                Some(err)
            }
        }
    };

    if shaped.is_empty() {
        if let Some(err) = runtime_list_error {
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
    let host = app.state::<RuntimeHost>();
    attach_host_runtime_status_to_sessions(&mut result, &host);
    Ok(result)
}

#[tauri::command]
pub async fn get_session(app: tauri::AppHandle, session_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        // Prefer on-disk session — opening a chat must not wait on a cold
        // runtime spawn.
        if let Ok(mut local) = session_store::read_local_session(&session_id) {
            attach_host_runtime_status_to_session(&mut local, &host);
            return Ok(local);
        }

        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let descriptor = match client.sessions_get(&session_id, SESSIONS_CALL_TIMEOUT) {
            Ok(descriptor) => descriptor,
            Err(RuntimeError::Rejected(body)) if body.code == "session_not_found" => {
                return Err(format!("Session not found: {session_id}"));
            }
            Err(err) => return Err(runtime_error_message("sessions.get", err)),
        };
        let mut shaped = shape_runtime_session_to_legacy(&descriptor);
        session_store::merge_local_metadata_into_legacy(&mut shaped, &session_id);
        attach_host_runtime_status_to_session(&mut shaped, &host);
        Ok(shaped)
    })
    .await
    .map_err(|e| format!("Failed to join get_session: {e}"))?
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
pub async fn create_session(
    app: tauri::AppHandle,
    work_dir: Option<String>,
    create_dir: Option<bool>,
) -> Result<Value, String> {
    let create_dir = create_dir.unwrap_or(false);
    let resolved_work_dir = resolve_create_session_work_dir(work_dir.as_deref(), create_dir)?;

    let app_for_create = app.clone();
    let session_id = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let host = app_for_create.state::<RuntimeHost>();
        host.install_app(&app_for_create);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let params = SessionsCreateParams {
            session_id: None,
            cwd: resolved_work_dir,
            title: None,
            model: None,
        };
        let descriptor = client
            .sessions_create(&params, SESSIONS_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("sessions.create", err))?;
        Ok(descriptor.session_id)
    })
    .await
    .map_err(|e| format!("Failed to join create_session: {e}"))??;

    // The session config snapshot is fed by the host pump from runtime
    // `session.config` events (the ACP `set_session_config_from_response`
    // seeding is gone with the cutover).
    get_session(app, session_id).await
}

#[tauri::command]
pub async fn delete_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        if host_session_busy(&host, &session_id) {
            return Err(SESSION_BUSY_MESSAGE.to_string());
        }

        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        // Best-effort close: the session may not be open (or already gone);
        // `sessions.delete` below is the authoritative operation.
        if let Err(err) = client.session_close(&session_id, SESSIONS_CALL_TIMEOUT) {
            eprintln!("[delete_session] session.close for `{session_id}`: {err}");
        }
        match client.sessions_delete(&session_id, SESSIONS_CALL_TIMEOUT) {
            Ok(_) => {}
            // Already gone on the runtime; the local cleanup below is the
            // user-visible intent.
            Err(err) if session_store::is_session_not_found(&err) => {}
            Err(err) => return Err(runtime_error_message("sessions.delete", err)),
        }
        session_store::delete_session_dir(&session_id)
    })
    .await
    .map_err(|e| format!("Failed to join delete_session: {e}"))?
}

#[tauri::command]
pub async fn update_session(
    app: tauri::AppHandle,
    session_id: String,
    title: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    if title.is_none() && archived.is_none() {
        return get_session(app, session_id).await;
    }

    // Title/archive are desktop metadata; update locally without touching
    // the runtime (the busy guard is a read-only host table projection).
    let app_for_update = app.clone();
    let session_id_for_update = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let host = app_for_update.state::<RuntimeHost>();
        host.install_app(&app_for_update);
        if host_session_busy(&host, &session_id_for_update) {
            return Err(SESSION_BUSY_MESSAGE.to_string());
        }
        session_store::update_session_state(&session_id_for_update, title.as_deref(), archived)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Failed to join update_session: {e}"))??;

    get_session(app, session_id).await
}

#[tauri::command]
pub async fn fork_session(_session_id: String, _turn_index: u64) -> Result<Value, String> {
    // The frontend always requests turn-granularity copies; the built-in
    // runtime only supports whole-session fork, so keep the explicit error
    // instead of silently falling back to a full-session copy.
    Err("turn 粒度 fork 暂不支持：内置运行时仅支持整会话复制，请等待后续版本。".to_string())
}

#[tauri::command]
pub async fn generate_title(session_id: String) -> Result<Value, String> {
    let title = session_store::fallback_title_from_wire(&session_id)?;
    session_store::update_session_state(&session_id, Some(&title), None)?;
    Ok(json!({ "title": title }))
}

#[tauri::command]
pub async fn upload_session_file(
    _session_id: String,
    filename: String,
    data: Vec<u8>,
) -> Result<Value, String> {
    // runtime-v1 has no attachment API; uploads stay in the local pending
    // directory and enter the engine as `turn.start` input parts.
    session_files::upload_pending_file(&filename, &data)
}

#[tauri::command]
pub async fn delete_uploaded_file(file_id: String) -> Result<(), String> {
    session_files::delete_pending_file(&file_id)
}

#[tauri::command]
pub async fn list_session_directory(
    app: tauri::AppHandle,
    session_id: String,
    path: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let work_dir = session_files::resolve_session_work_dir_runtime(&app, &session_id)?;
        let rel_path = path.unwrap_or_else(|| ".".to_string());
        let dir_path = session_files::resolve_session_file(&work_dir, &rel_path)?;
        let entries = session_files::list_directory_entries(&dir_path)?;
        Ok(Value::Array(entries))
    })
    .await
    .map_err(|e| format!("Failed to join list_session_directory: {e}"))?
}

#[tauri::command]
pub async fn get_session_file(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let work_dir = session_files::resolve_session_work_dir_runtime(&app, &session_id)?;
        let file_path = session_files::resolve_session_file(&work_dir, &path)?;
        session_files::read_session_file_payload(&file_path)
    })
    .await
    .map_err(|e| format!("Failed to join get_session_file: {e}"))?
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
pub async fn list_work_dir_directory(
    work_dir: String,
    path: Option<String>,
) -> Result<Value, String> {
    let workspace = PathBuf::from(work_dir.trim());
    if workspace.as_os_str().is_empty() {
        return Err("Work directory is required".to_string());
    }
    let rel_path = path.unwrap_or_else(|| ".".to_string());
    let dir_path = session_files::resolve_session_file(&workspace, &rel_path)?;
    let entries = session_files::list_directory_entries(&dir_path)?;
    Ok(Value::Array(entries))
}

#[tauri::command]
pub async fn list_work_dirs(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);

        let mut work_dirs = Vec::new();
        let mut seen = HashSet::new();

        for dir in session_files::work_dirs_from_metadata()? {
            if is_hidden_work_dir(&dir) || !Path::new(&dir).exists() || !seen.insert(dir.clone()) {
                continue;
            }
            work_dirs.push(dir);
            if work_dirs.len() >= MAX_WORK_DIRS {
                break;
            }
        }

        // Metadata is enough for the picker. Only soft-probe the runtime when
        // the local cache is empty.
        if work_dirs.is_empty() {
            match fetch_runtime_sessions_soft(&host) {
                Ok(descriptors) => {
                    for descriptor in descriptors {
                        let Some(cwd) = descriptor.cwd else {
                            continue;
                        };
                        if is_hidden_work_dir(&cwd)
                            || !Path::new(&cwd).exists()
                            || !seen.insert(cwd.clone())
                        {
                            continue;
                        }
                        work_dirs.push(cwd);
                        if work_dirs.len() >= MAX_WORK_DIRS {
                            break;
                        }
                    }
                }
                Err(err) => {
                    eprintln!(
                        "[list_work_dirs] runtime sessions.list failed, using metadata only: {err}"
                    );
                }
            }
        }

        Ok(json!(work_dirs))
    })
    .await
    .map_err(|e| format!("Failed to join list_work_dirs: {e}"))?
}

#[tauri::command]
pub async fn get_startup_dir(_app: tauri::AppHandle) -> Result<Value, String> {
    Ok(json!(resolve_startup_dir()?))
}

pub(crate) fn is_hidden_work_dir(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized == "/tmp"
        || normalized.starts_with("/var/folders")
        || normalized.contains("/.cache/")
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
pub fn get_session_influence_snapshot(
    work_dir: Option<String>,
    include_custom_agents: Option<bool>,
) -> Result<Value, String> {
    session_influence::get_session_influence_snapshot(
        work_dir.as_deref(),
        include_custom_agents.unwrap_or(false),
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::lock::set_kimi_code_home;

    fn descriptor(
        session_id: &str,
        title: Option<&str>,
        cwd: Option<&str>,
        archived: Option<bool>,
    ) -> SessionDescriptor {
        SessionDescriptor {
            session_id: session_id.to_string(),
            workspace_id: None,
            cwd: cwd.map(str::to_string),
            title: title.map(str::to_string),
            model: None,
            archived,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn shape_runtime_session_to_legacy_maps_fields() {
        let session = SessionDescriptor {
            session_id: "id-1".to_string(),
            workspace_id: None,
            cwd: Some("/proj".to_string()),
            title: Some("My chat".to_string()),
            model: None,
            archived: Some(false),
            created_at: None,
            updated_at: Some(json!("2026-07-08T12:00:00Z")),
        };
        let legacy = shape_runtime_session_to_legacy(&session);
        assert_eq!(legacy["session_id"], "id-1");
        assert_eq!(legacy["title"], "My chat");
        assert_eq!(legacy["work_dir"], "/proj");
        assert_eq!(legacy["last_updated"], "2026-07-08T12:00:00Z");
        assert_eq!(legacy["archived"], false);
    }

    #[test]
    fn shape_runtime_session_to_legacy_uses_defaults() {
        let legacy = shape_runtime_session_to_legacy(&descriptor("id-2", None, None, None));
        assert_eq!(legacy["session_id"], "id-2");
        assert_eq!(legacy["title"], "Untitled");
        assert_eq!(legacy["work_dir"], Value::Null);
        assert_eq!(legacy["last_updated"], Value::Null);
        assert_eq!(legacy["archived"], false);
    }

    #[test]
    fn filter_sessions_by_query_matches_title() {
        let sessions = vec![
            shape_runtime_session_to_legacy(&descriptor("1", Some("Alpha"), Some("/a"), None)),
            shape_runtime_session_to_legacy(&descriptor("2", Some("Beta"), Some("/b"), None)),
        ];
        let filtered = filter_sessions(sessions, Some("alp"), None);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["session_id"], "1");
    }

    #[test]
    fn filter_sessions_none_excludes_archived() {
        let active =
            shape_runtime_session_to_legacy(&descriptor("1", Some("Active"), None, Some(false)));
        let old = shape_runtime_session_to_legacy(&descriptor("2", Some("Old"), None, Some(true)));
        let filtered = filter_sessions(vec![active.clone(), old.clone()], None, None);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["session_id"], "1");
        let archived_only = filter_sessions(vec![active, old], None, Some(true));
        assert_eq!(archived_only.len(), 1);
        assert_eq!(archived_only[0]["session_id"], "2");
    }

    #[test]
    fn host_session_busy_ignores_unknown_sessions() {
        let host = RuntimeHost::new();
        assert!(!host_session_busy(&host, "nope"));
    }

    #[test]
    fn omitted_custom_agent_flag_disables_discovery() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("kimi-home");
        let project = temp.path().join("project");
        let agents = project.join(".kimi-code").join("agents");
        std::fs::create_dir_all(project.join(".git")).expect("git marker");
        std::fs::create_dir_all(&agents).expect("agents directory");
        std::fs::write(
            agents.join("omitted-agent.md"),
            "---\nname: omitted-agent\n---\n",
        )
        .expect("agent file");

        let _home_guard = set_kimi_code_home(&home);
        let snapshot = super::get_session_influence_snapshot(
            Some(project.to_string_lossy().to_string()),
            None,
        )
        .expect("snapshot");
        assert_eq!(snapshot["agents"], serde_json::json!([]));
    }

    #[test]
    fn resolve_startup_dir_prefers_recent_work_dir() {
        // On macOS, tempfile::tempdir() lives under /var/folders, which the
        // is_hidden_work_dir() filter skips; use /tmp there instead so the
        // recorded work dir is not filtered out.
        #[cfg(target_os = "macos")]
        let temp = tempfile::Builder::new()
            .prefix("kimi-startup-test-")
            .tempdir_in("/tmp")
            .expect("tempdir");
        #[cfg(not(target_os = "macos"))]
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
