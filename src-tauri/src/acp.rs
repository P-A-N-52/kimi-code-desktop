//! Kimi Code ACP process manager (Milestone 1 shell + Milestone 2 translation).

use crate::acp_translate::{
    acp_permission_to_legacy_request, acp_update_to_wire_event,
    legacy_approval_result_to_acp_outcome, legacy_prompt_status_from_stop_reason,
    legacy_user_input_to_acp_prompt_with_swarm, normalize_workspace_path,
    translate_acp_lifecycle_notification, translate_session_update, wire_event_message,
};
use crate::wire_events::{emit_wire_message, RestartWorkersSummary, RuntimeStatus};
use crate::{global_config, session_files, session_store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tokio::sync::oneshot;

const ACP_RPC_TIMEOUT_DEFAULT_SECS: u64 = 120;
// `session/prompt` stays pending for the whole turn, so it gets its own,
// much longer timeout. Long multi-tool turns legitimately exceed the
// generic RPC timeout.
const ACP_PROMPT_TIMEOUT_DEFAULT_SECS: u64 = 3600;
const ACP_HELP_TIMEOUT: Duration = Duration::from_secs(5);

fn acp_rpc_timeout() -> Duration {
    std::env::var("ACP_RPC_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(ACP_RPC_TIMEOUT_DEFAULT_SECS))
}

fn acp_prompt_timeout() -> Duration {
    std::env::var("ACP_PROMPT_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(ACP_PROMPT_TIMEOUT_DEFAULT_SECS))
}

/// Resolve the Kimi Code CLI binary used for ACP.
///
/// Order: explicit value (tests / `KIMI_CODE_BIN`) then `kimi` on PATH.
/// Never use `KIMI_CLI_BIN` — that belongs to the legacy Python runtime.
pub fn resolve_acp_command_from_env(value: Option<&str>) -> String {
    match value {
        Some(path) if !path.trim().is_empty() => path.trim().to_string(),
        _ => "kimi".to_string(),
    }
}

pub fn resolve_acp_command() -> String {
    resolve_acp_command_from_env(std::env::var("KIMI_CODE_BIN").ok().as_deref())
}

/// Resolve and validate `KIMI_CODE_BIN` when explicitly set.
pub fn resolve_acp_command_validated() -> Result<String, String> {
    let explicit = std::env::var("KIMI_CODE_BIN").ok();
    let program = resolve_acp_command_from_env(explicit.as_deref());
    if explicit
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        crate::security::validate_kimi_code_bin_path(&program)?;
    }
    Ok(program)
}

/// Validate that `<program> acp --help` looks like the Kimi ACP entrypoint.
pub fn validate_kimi_acp_command(program: &str) -> Result<(), String> {
    let output = run_command_capture(program, &["acp", "--help"], ACP_HELP_TIMEOUT)?;
    let lowered = output.to_ascii_lowercase();
    if lowered.contains("acp") || lowered.contains("agent client protocol") {
        Ok(())
    } else {
        Err(format!(
            "`{} acp --help` did not look like an ACP entrypoint",
            program
        ))
    }
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Value::is_null")]
    params: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcError {
    pub code: Option<Value>,
    pub message: Option<String>,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcResponse {
    pub id: Option<u64>,
    pub result: Option<Value>,
    pub error: Option<JsonRpcError>,
    #[serde(default)]
    pub method: Option<String>,
}

/// Parse one stdout JSON-RPC line. Notifications (no id) are accepted.
pub fn parse_jsonrpc_line(line: &str) -> Result<JsonRpcResponse, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err("empty JSON-RPC line".to_string());
    }
    serde_json::from_str(trimmed).map_err(|err| format!("invalid JSON-RPC line: {err}"))
}

pub fn is_auth_required_response(response: &JsonRpcResponse) -> bool {
    if let Some(result) = &response.result {
        if result.get("authRequired").and_then(Value::as_bool) == Some(true) {
            return true;
        }
        if result
            .get("status")
            .and_then(Value::as_str)
            .map(|s| s.eq_ignore_ascii_case("authrequired"))
            .unwrap_or(false)
        {
            return true;
        }
        if result
            .get("reason")
            .and_then(Value::as_str)
            .map(|s| s.eq_ignore_ascii_case("authrequired"))
            .unwrap_or(false)
        {
            return true;
        }
        if result.get("authenticated").and_then(Value::as_bool) == Some(false) {
            return true;
        }
    }

    if let Some(error) = &response.error {
        let code = error
            .code
            .as_ref()
            .map(|c| c.to_string().to_ascii_lowercase())
            .unwrap_or_default();
        let message = error.message.as_deref().unwrap_or("").to_ascii_lowercase();
        if code.contains("32000")
            || code.contains("auth")
            || message.contains("authrequired")
            || message.contains("not logged")
            || message.contains("login")
        {
            return true;
        }
        if error
            .data
            .as_ref()
            .and_then(|d| d.get("authRequired"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            return true;
        }
        if error
            .data
            .as_ref()
            .and_then(Value::as_str)
            .map(|s| s.to_ascii_lowercase().contains("authrequired"))
            .unwrap_or(false)
        {
            return true;
        }
    }

    false
}

/// Empty authenticate `result: {}` means token present (observed on Kimi Code CLI 0.18.0).
pub fn is_authenticated_response(response: &JsonRpcResponse) -> bool {
    if response.error.is_some() || is_auth_required_response(response) {
        return false;
    }
    match &response.result {
        None => true,
        Some(Value::Null) => true,
        Some(Value::Object(map)) if map.is_empty() => true,
        Some(result) => {
            result.get("authenticated").and_then(Value::as_bool) != Some(false)
                && result.get("authRequired").and_then(Value::as_bool) != Some(true)
        }
    }
}

/// Redact session list payloads so logs never keep raw titles/cwds.
pub fn sanitize_session_list_for_log(value: &Value) -> Value {
    let mut copy = value.clone();
    if let Some(sessions) = copy.get_mut("sessions").and_then(Value::as_array_mut) {
        let count = sessions.len();
        let sample_fields = sessions
            .first()
            .and_then(Value::as_object)
            .map(|obj| obj.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let sample = sessions
            .first()
            .cloned()
            .map(|item| redact_session_value(&item))
            .unwrap_or(Value::Null);
        *sessions = vec![];
        return json!({
            "sessions": {
                "count": count,
                "sampleFields": sample_fields,
                "sample": sample,
            },
            "nextCursor": copy.get("nextCursor").cloned().unwrap_or(Value::Null),
        });
    }
    redact_session_value(&copy)
}

fn redact_session_value(value: &Value) -> Value {
    match value {
        Value::String(_) => Value::String("<string>".to_string()),
        Value::Number(_) => Value::String("<number>".to_string()),
        Value::Bool(_) => Value::String("<boolean>".to_string()),
        Value::Array(items) => Value::String(format!("<array:{}>", items.len())),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, nested) in map {
                out.insert(key.clone(), redact_session_value(nested));
            }
            Value::Object(out)
        }
        Value::Null => Value::Null,
    }
}

fn run_command_capture(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn `{program}`: {e}"))?;
    let started_at = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => {
                let output = child.wait_with_output().map_err(|e| e.to_string())?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let combined = format!("{stdout}{stderr}");
                if output.status.success() {
                    return Ok(combined);
                }
                return Err(format!(
                    "`{} {}` exited with {}: {}",
                    program,
                    args.join(" "),
                    output.status,
                    combined.trim()
                ));
            }
            None if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "`{} {}` timed out after {}s",
                    program,
                    args.join(" "),
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn pick_login_method_id(initialize_result: &Value) -> String {
    let methods = initialize_result
        .get("authMethods")
        .or_else(|| initialize_result.get("authenticationMethods"))
        .cloned()
        .unwrap_or(Value::Null);

    if let Some(arr) = methods.as_array() {
        for item in arr {
            let id = item
                .as_str()
                .map(str::to_string)
                .or_else(|| {
                    item.get("id")
                        .or_else(|| item.get("methodId"))
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            if id.eq_ignore_ascii_case("login") {
                return id;
            }
        }
        if let Some(first) = arr.first() {
            if let Some(id) = first.as_str() {
                return id.to_string();
            }
            if let Some(id) = first
                .get("id")
                .or_else(|| first.get("methodId"))
                .or_else(|| first.get("name"))
                .and_then(Value::as_str)
            {
                return id.to_string();
            }
        }
    }

    "login".to_string()
}

#[derive(Clone)]
pub struct AcpProcessManager {
    inner: Arc<AcpManagerState>,
}

struct AcpManagerState {
    workers: Mutex<HashMap<String, Arc<AcpWorker>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionMode {
    Manual,
    Auto,
    Yolo,
}

impl PermissionMode {
    fn from_kimi(value: &str) -> Option<Self> {
        match value {
            "manual" | "ask" | "default" => Some(Self::Manual),
            "auto" => Some(Self::Auto),
            "yolo" => Some(Self::Yolo),
            _ => None,
        }
    }

    fn as_wire(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Auto => "auto",
            Self::Yolo => "yolo",
        }
    }

    fn acp_mode_id(self) -> &'static str {
        match self {
            Self::Manual => "default",
            Self::Auto => "auto",
            Self::Yolo => "yolo",
        }
    }
}

pub(crate) struct AcpWorker {
    session_id: String,
    connection_id: Mutex<Option<String>>,
    workspace_cwd: Mutex<Option<PathBuf>>,
    status: Mutex<RuntimeStatus>,
    // Keep only a short-lived lock around the session handle itself. The
    // session is shared so a long-running `session/prompt` request cannot
    // block reverse-request responses or `session/cancel` notifications.
    rpc: Mutex<Option<Arc<AcpRpcSession>>>,
    status_seq: AtomicU64,
    in_flight_prompt_ids: Mutex<HashSet<String>>,
    pending_permission_ids: Mutex<HashMap<String, u64>>,
    sent_upload_files: Mutex<HashSet<String>>,
    last_session_update_at: Mutex<Option<Instant>>,
    plan_mode: Mutex<bool>,
    permission_mode: Mutex<PermissionMode>,
    swarm_mode: Mutex<bool>,
}

pub(crate) struct AcpRpcSession {
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    next_id: AtomicU64,
    reader_alive: Arc<Mutex<bool>>,
}

impl AcpProcessManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AcpManagerState {
                workers: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn get_status(&self, session_id: &str) -> Option<RuntimeStatus> {
        let workers = self.inner.workers.lock().unwrap();
        workers
            .get(session_id)
            .map(|worker| worker.status.lock().unwrap().clone())
    }

    pub fn is_running(&self, session_id: &str) -> bool {
        let workers = self.inner.workers.lock().unwrap();
        workers
            .get(session_id)
            .map(|worker| {
                let state = worker.status.lock().unwrap().state.clone();
                matches!(state.as_str(), "ready" | "running" | "busy" | "idle")
            })
            .unwrap_or(false)
    }

    pub fn ensure_editable(&self, session_id: &str) -> Result<(), String> {
        if let Some(status) = self.get_status(session_id) {
            if status.state == "busy" {
                return Err(
                    "Session is busy. Please wait for it to complete before modifying.".into(),
                );
            }
        }
        Ok(())
    }

    pub async fn connect(&self, app: &AppHandle, session_id: String) -> Result<(), String> {
        self.connect_with_lease(app, session_id, None).await
    }

    pub async fn connect_leased(
        &self,
        app: &AppHandle,
        session_id: String,
        connection_id: String,
    ) -> Result<(), String> {
        if connection_id.trim().is_empty() {
            return Err("Missing connection id".to_string());
        }
        self.connect_with_lease(app, session_id, Some(connection_id))
            .await
    }

    async fn connect_with_lease(
        &self,
        app: &AppHandle,
        session_id: String,
        connection_id: Option<String>,
    ) -> Result<(), String> {
        let stale_worker = {
            let mut workers = self.inner.workers.lock().unwrap();
            if let Some(existing) = workers.get(&session_id) {
                if is_worker_session_usable(existing) {
                    *existing.connection_id.lock().unwrap() = connection_id;
                    return Ok(());
                }
                workers.remove(&session_id)
            } else {
                None
            }
        };
        if let Some(stale) = stale_worker {
            stop_worker_async(&stale, "dead_session").await;
        }

        let program = resolve_acp_command_validated()?;
        validate_kimi_acp_command(&program)?;
        let cwd = resolve_session_cwd(app, &session_id).await?;
        let (initial_plan_mode, initial_permission_mode, initial_swarm_mode) =
            resolve_initial_runtime_modes(&session_id);

        let worker = Arc::new(AcpWorker {
            session_id: session_id.clone(),
            connection_id: Mutex::new(connection_id),
            workspace_cwd: Mutex::new(Some(cwd.clone())),
            status: Mutex::new(RuntimeStatus {
                session_id: session_id.clone(),
                state: "ready".to_string(),
                seq: 0,
                worker_id: Some(format!("acp-{session_id}")),
                reason: Some("acp_connecting".to_string()),
                detail: None,
                updated_at: now_ms(),
            }),
            rpc: Mutex::new(None),
            status_seq: AtomicU64::new(0),
            in_flight_prompt_ids: Mutex::new(HashSet::new()),
            pending_permission_ids: Mutex::new(HashMap::new()),
            sent_upload_files: Mutex::new(session_files::load_sent_upload_names(&session_id)),
            last_session_update_at: Mutex::new(None),
            plan_mode: Mutex::new(initial_plan_mode),
            permission_mode: Mutex::new(initial_permission_mode),
            swarm_mode: Mutex::new(initial_swarm_mode),
        });

        let mut rpc = spawn_acp_rpc_session(&program, app.clone(), Arc::clone(&worker))?;

        if let Err(err) = ensure_acp_authenticated(&mut rpc).await {
            let _ = rpc.shutdown();
            return Err(err);
        }

        let resume = match rpc
            .request(
                "session/resume",
                json!({
                    "sessionId": session_id,
                    "cwd": cwd.to_string_lossy(),
                    "mcpServers": crate::mcp_config::mcp_servers_for_acp(),
                }),
            )
            .await
        {
            Ok(response) => response,
            Err(err) => {
                let _ = rpc.shutdown();
                return Err(err);
            }
        };

        if resume.error.is_some() {
            let _ = rpc.shutdown();
            return Err(format!(
                "ACP session/resume failed: {}",
                describe_rpc_error(&resume)
            ));
        }

        worker.rpc.lock().unwrap().replace(Arc::new(rpc));
        set_worker_status(app, &worker, "idle", Some("acp_connected"), None);

        let previous_worker = {
            let mut workers = self.inner.workers.lock().unwrap();
            workers.insert(session_id, worker)
        };
        if let Some(previous) = previous_worker {
            stop_worker_async(&previous, "replaced").await;
        }
        Ok(())
    }

    pub async fn disconnect(&self, _app: &AppHandle, session_id: String) -> Result<(), String> {
        let worker = {
            let mut workers = self.inner.workers.lock().unwrap();
            workers.remove(&session_id)
        };
        if let Some(worker) = worker {
            stop_worker_async(&worker, "disconnected").await;
        }
        Ok(())
    }

    pub async fn disconnect_leased(
        &self,
        _app: &AppHandle,
        session_id: String,
        connection_id: String,
    ) -> Result<(), String> {
        let worker = {
            let mut workers = self.inner.workers.lock().unwrap();
            let matches_current_lease = workers
                .get(&session_id)
                .map(|worker| {
                    worker.connection_id.lock().unwrap().as_deref()
                        == Some(connection_id.as_str())
                })
                .unwrap_or(false);
            if matches_current_lease {
                workers.remove(&session_id)
            } else {
                None
            }
        };
        if let Some(worker) = worker {
            stop_worker_async(&worker, "disconnected").await;
        }
        Ok(())
    }

    pub async fn restart_running_workers(
        &self,
        app: &AppHandle,
        reason: &str,
        force: bool,
    ) -> RestartWorkersSummary {
        let running: Vec<String> = {
            let workers = self.inner.workers.lock().unwrap();
            workers
                .iter()
                .filter_map(|(session_id, worker)| {
                    let state = worker.status.lock().unwrap().state.clone();
                    if matches!(state.as_str(), "ready" | "running" | "busy" | "idle") {
                        Some(session_id.clone())
                    } else {
                        None
                    }
                })
                .collect()
        };

        let mut restarted = Vec::new();
        let mut skipped_busy = Vec::new();

        for session_id in running {
            let busy = {
                let workers = self.inner.workers.lock().unwrap();
                workers
                    .get(&session_id)
                    .map(|worker| !worker.in_flight_prompt_ids.lock().unwrap().is_empty())
                    .unwrap_or(false)
            };

            if !force && busy {
                skipped_busy.push(session_id);
                continue;
            }

            restarted.push(session_id.clone());
            let _ = self.disconnect(app, session_id.clone()).await;
            if let Err(error) = self.connect(app, session_id).await {
                eprintln!("[acp] restart after {reason} failed: {error}");
            }
        }

        RestartWorkersSummary {
            restarted_session_ids: restarted,
            skipped_busy_session_ids: skipped_busy,
        }
    }

    pub async fn send(
        &self,
        app: &AppHandle,
        session_id: String,
        message: String,
    ) -> Result<(), String> {
        let worker = {
            let workers = self.inner.workers.lock().unwrap();
            workers.get(&session_id).cloned().ok_or_else(|| {
                format!("ACP session `{session_id}` is not connected; call wire_connect first")
            })?
        };

        let parsed: Value =
            serde_json::from_str(&message).map_err(|e| format!("Invalid JSON-RPC message: {e}"))?;
        let method = parsed.get("method").and_then(Value::as_str);
        let id = parsed.get("id").cloned();

        match method {
            Some("initialize") => {
                emit_wire_message(
                    app,
                    &session_id,
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "slash_commands": [] }
                    })
                    .to_string(),
                );
                set_worker_status(app, &worker, "idle", Some("initialized"), None);
                emit_mode_status_wire(app, &worker);
                emit_usage_status_wire(app, &worker, None);
                Ok(())
            }
            Some("replay") => handle_replay(app, &worker, id).await,
            Some("prompt") => {
                handle_prompt(
                    app,
                    &worker,
                    id,
                    parsed.get("params").cloned().unwrap_or(Value::Null),
                )
                .await
            }
            Some("cancel") => handle_cancel(app, &worker, id).await,
            Some("set_plan_mode") => {
                handle_set_plan_mode(
                    app,
                    &worker,
                    id,
                    parsed.get("params").cloned().unwrap_or(Value::Null),
                )
                .await
            }
            Some("set_permission_mode") => {
                handle_set_permission_mode(
                    app,
                    &worker,
                    id,
                    parsed.get("params").cloned().unwrap_or(Value::Null),
                )
                .await
            }
            Some("set_swarm_mode") => handle_set_swarm_mode(
                app,
                &worker,
                id,
                parsed.get("params").cloned().unwrap_or(Value::Null),
            ),
            None if parsed.get("result").is_some() => {
                handle_permission_response(&worker, id, parsed.get("result")).await
            }
            _ => Ok(()),
        }
    }

    pub fn stop_all(&self) {
        let workers = {
            let mut workers = self.inner.workers.lock().unwrap();
            std::mem::take(&mut *workers)
        };
        for (_, worker) in workers {
            stop_worker_best_effort(&worker, "app_exit");
        }
    }
}

impl Default for AcpProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

fn describe_rpc_error(response: &JsonRpcResponse) -> String {
    if let Some(error) = &response.error {
        let code = error
            .code
            .as_ref()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let message = error.message.clone().unwrap_or_default();
        let details = error
            .data
            .as_ref()
            .and_then(|data| {
                data.get("details")
                    .and_then(Value::as_str)
                    .or_else(|| data.as_str())
            })
            .map(|details| format!(" details={details}"))
            .unwrap_or_default();
        format!("code={code} message={message}{details}")
    } else {
        "unknown error".to_string()
    }
}

fn is_already_in_plan_mode_error(response: &JsonRpcResponse) -> bool {
    response
        .error
        .as_ref()
        .and_then(|error| {
            error
                .data
                .as_ref()
                .and_then(|data| {
                    data.get("details")
                        .and_then(Value::as_str)
                        .or_else(|| data.as_str())
                })
                .or(error.message.as_deref())
        })
        .map(|details| details.trim().eq_ignore_ascii_case("Already in plan mode"))
        .unwrap_or(false)
}

async fn resolve_session_cwd(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    fetch_session_cwd_via_acp(app, session_id).await
}

/// Extract cwd from a single `session/list` item.
pub fn acp_session_cwd_from_list_item(item: &Value) -> Result<PathBuf, String> {
    item.get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "Session cwd not found in ACP session metadata".to_string())
}

pub(crate) fn spawn_acp_probe_worker(
    app: &AppHandle,
) -> Result<(AcpRpcSession, Arc<AcpWorker>), String> {
    let program = resolve_acp_command_validated()?;
    validate_kimi_acp_command(&program)?;
    let worker = Arc::new(new_probe_worker());
    let rpc = spawn_acp_rpc_session(&program, app.clone(), Arc::clone(&worker))?;
    Ok((rpc, worker))
}

fn new_probe_worker() -> AcpWorker {
    AcpWorker {
        session_id: "__desktop_probe__".to_string(),
        connection_id: Mutex::new(None),
        workspace_cwd: Mutex::new(None),
        status: Mutex::new(RuntimeStatus {
            session_id: "__desktop_probe__".to_string(),
            state: "ready".to_string(),
            seq: 0,
            worker_id: None,
            reason: None,
            detail: None,
            updated_at: now_ms(),
        }),
        rpc: Mutex::new(None),
        status_seq: AtomicU64::new(0),
        in_flight_prompt_ids: Mutex::new(HashSet::new()),
        pending_permission_ids: Mutex::new(HashMap::new()),
        sent_upload_files: Mutex::new(HashSet::new()),
        last_session_update_at: Mutex::new(None),
        plan_mode: Mutex::new(false),
        permission_mode: Mutex::new(PermissionMode::Manual),
        swarm_mode: Mutex::new(false),
    }
}

async fn fetch_session_cwd_via_acp(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let (mut rpc, _worker) = spawn_acp_probe_worker(app)?;
    let init_result = ensure_acp_authenticated(&mut rpc).await;
    if let Err(err) = init_result {
        let _ = rpc.shutdown();
        return Err(err);
    }

    let list_response = rpc.request("session/list", json!({})).await?;
    let _ = rpc.shutdown();

    if list_response.error.is_some() {
        return Err(format!(
            "ACP session/list failed: {}",
            describe_rpc_error(&list_response)
        ));
    }

    let sessions = list_response
        .result
        .as_ref()
        .and_then(|result| result.get("sessions"))
        .and_then(Value::as_array)
        .ok_or_else(|| "ACP session/list returned no sessions array".to_string())?;

    for item in sessions {
        if item.get("sessionId").and_then(Value::as_str) == Some(session_id) {
            return acp_session_cwd_from_list_item(item);
        }
    }

    Err(format!(
        "Session `{session_id}` not found via ACP session/list"
    ))
}

fn acp_initialize_params() -> Value {
    // `kimi acp` is a same-user local subprocess, so it can safely use its own
    // filesystem fallback. Advertising client filesystem callbacks makes Kimi
    // route persisted `~/.kimi-code/sessions/...` reads through our workspace-
    // only broker during resume, which rejects those session artifacts.
    json!({
        "protocolVersion": 1,
        "clientInfo": {
            "name": "kimi-code-desktop",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "clientCapabilities": {}
    })
}

pub(crate) async fn ensure_acp_authenticated(rpc: &mut AcpRpcSession) -> Result<(), String> {
    let initialize = rpc.request("initialize", acp_initialize_params()).await?;

    if initialize.error.is_some() {
        return Err(format!(
            "ACP initialize failed: {}",
            describe_rpc_error(&initialize)
        ));
    }

    let method_id = pick_login_method_id(initialize.result.as_ref().unwrap_or(&Value::Null));
    let authenticate = rpc
        .request("authenticate", json!({ "methodId": method_id }))
        .await?;

    if is_auth_required_response(&authenticate) || !is_authenticated_response(&authenticate) {
        return Err(
            "ACP authentication required. Sign in from Settings (device code) or run `kimi login`, then retry."
                .to_string(),
        );
    }

    if authenticate.error.is_some() {
        return Err(format!(
            "ACP authenticate failed: {}",
            describe_rpc_error(&authenticate)
        ));
    }

    Ok(())
}

fn set_worker_status(
    app: &AppHandle,
    worker: &AcpWorker,
    state: &str,
    reason: Option<&str>,
    detail: Option<&str>,
) {
    let seq = worker.status_seq.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut status = worker.status.lock().unwrap();
        status.state = state.to_string();
        status.seq = seq;
        status.reason = reason.map(str::to_string);
        status.detail = detail.map(str::to_string);
        status.updated_at = now_ms();
    }
    emit_session_status_wire(app, worker, state, seq, reason, detail);
}

fn emit_session_status_wire(
    app: &AppHandle,
    worker: &AcpWorker,
    state: &str,
    seq: u64,
    reason: Option<&str>,
    detail: Option<&str>,
) {
    emit_wire_message(
        app,
        &worker.session_id,
        json!({
            "jsonrpc": "2.0",
            "method": "session_status",
            "params": {
                "session_id": worker.session_id,
                "state": state,
                "seq": seq,
                "worker_id": format!("acp-{}", worker.session_id),
                "reason": reason,
                "detail": detail,
                "updated_at": now_ms().to_string(),
            }
        })
        .to_string(),
    );
}

fn mode_enabled_from_params(params: &Value) -> Result<bool, String> {
    params
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "mode update requires boolean params.enabled".to_string())
}

fn permission_mode_from_params(params: &Value) -> Result<PermissionMode, String> {
    params
        .get("mode")
        .and_then(Value::as_str)
        .and_then(PermissionMode::from_kimi)
        .ok_or_else(|| {
            "permission mode update requires params.mode = manual, yolo, or auto".to_string()
        })
}

fn acp_mode_id_for_plan(enabled: bool, permission_mode: PermissionMode) -> &'static str {
    if enabled {
        "plan"
    } else {
        permission_mode.acp_mode_id()
    }
}

/// Apply an agent-initiated mode change reported through ACP `session/update`
/// `current_mode_update` (e.g. the CLI leaving plan mode after ExitPlanMode).
/// Returns true when the update was a mode update the caller should broadcast
/// via `emit_mode_status_wire` instead of the stream translator. Unknown mode
/// ids are logged and treated as handled so they never reach the UI as stream
/// events.
fn apply_current_mode_update(worker: &AcpWorker, update: &Value) -> bool {
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("current_mode_update") {
        return false;
    }
    let mode_id = update
        .get("currentModeId")
        .and_then(Value::as_str)
        .or_else(|| update.get("current_mode_id").and_then(Value::as_str))
        .unwrap_or("");
    if mode_id == "plan" {
        *worker.plan_mode.lock().unwrap() = true;
        return true;
    }
    match PermissionMode::from_kimi(mode_id) {
        Some(permission_mode) => {
            *worker.plan_mode.lock().unwrap() = false;
            *worker.permission_mode.lock().unwrap() = permission_mode;
        }
        None => {
            eprintln!("[acp] ignored current_mode_update with unknown modeId: {mode_id}");
        }
    }
    true
}

/// Kimi Code 0.27 does not emit `current_mode_update` when the agent leaves
/// plan mode via ExitPlanMode; the only signal on the wire is the completed
/// tool result whose output starts with "Exited plan mode." (the CLI detects
/// its own plan exits the same way). Flip plan mode off so the UI toggle
/// follows the agent. Returns true only when the state actually changed; the
/// update itself must still be translated for the timeline.
fn sync_plan_mode_exit_from_tool_result(worker: &AcpWorker, update: &Value) -> bool {
    if !*worker.plan_mode.lock().unwrap() {
        return false;
    }
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("tool_call_update") {
        return false;
    }
    if update.get("status").and_then(Value::as_str) != Some("completed") {
        return false;
    }
    let Some(items) = update.get("content").and_then(Value::as_array) else {
        return false;
    };
    let marks_plan_exit = items.iter().any(|item| {
        let text = match item.get("type").and_then(Value::as_str) {
            Some("content") => item
                .get("content")
                .and_then(|content| content.get("text"))
                .and_then(Value::as_str),
            Some("text") => item.get("text").and_then(Value::as_str),
            _ => None,
        };
        text.is_some_and(|text| text.starts_with("Exited plan mode."))
    });
    if !marks_plan_exit {
        return false;
    }
    *worker.plan_mode.lock().unwrap() = false;
    true
}

fn resolve_initial_runtime_modes(session_id: &str) -> (bool, PermissionMode, bool) {
    let defaults = global_config::runtime_mode_defaults().unwrap_or_else(|err| {
        eprintln!("[acp] failed to read global runtime mode defaults: {err}");
        global_config::RuntimeModeDefaults::default()
    });
    let persisted = session_store::persisted_runtime_modes(session_id).unwrap_or_else(|err| {
        eprintln!("[acp] failed to read persisted runtime modes for {session_id}: {err}");
        session_store::PersistedRuntimeModes::default()
    });
    let permission_mode = persisted
        .permission_mode
        .as_deref()
        .and_then(PermissionMode::from_kimi)
        .or_else(|| PermissionMode::from_kimi(&defaults.permission_mode))
        .unwrap_or(PermissionMode::Manual);
    let swarm_mode = session_store::session_swarm_mode(session_id).unwrap_or_else(|err| {
        eprintln!("[acp] failed to read persisted swarm mode for {session_id}: {err}");
        false
    });

    (
        persisted.plan_mode.unwrap_or(defaults.plan_mode),
        permission_mode,
        swarm_mode,
    )
}

fn mode_status_payload(worker: &AcpWorker) -> Value {
    let plan_mode = *worker.plan_mode.lock().unwrap();
    let permission_mode = *worker.permission_mode.lock().unwrap();
    let swarm_mode = *worker.swarm_mode.lock().unwrap();
    mode_status_payload_for(plan_mode, permission_mode, swarm_mode)
}

fn mode_status_payload_for(
    plan_mode: bool,
    permission_mode: PermissionMode,
    swarm_mode: bool,
) -> Value {
    json!({
        "context_usage": null,
        "token_usage": null,
        "plan_mode": plan_mode,
        "permission_mode": permission_mode.as_wire(),
        "swarm_mode": swarm_mode,
    })
}

fn emit_mode_status_wire(app: &AppHandle, worker: &AcpWorker) {
    emit_wire_message(
        app,
        &worker.session_id,
        wire_event_message("StatusUpdate", mode_status_payload(worker)),
    );
}

/// Best-effort context/token usage for the status ring.
///
/// Kimi ACP currently omits `usage_update` (see MoonshotAI/kimi-code#1855), so we
/// fall back to the latest `usage.record` in wire.jsonl and the model's
/// `max_context_size` from config.toml. When a future CLI fills
/// `PromptResponse.usage`, that is preferred for the token breakdown.
fn emit_usage_status_wire(app: &AppHandle, worker: &AcpWorker, prompt_result: Option<&Value>) {
    let from_prompt = prompt_result
        .and_then(|result| result.get("usage"))
        .and_then(usage_snapshot_from_acp_usage);
    let from_wire = match session_store::latest_turn_usage(&worker.session_id) {
        Ok(snapshot) => snapshot,
        Err(err) => {
            eprintln!(
                "[acp] failed to read usage.record for {}: {err}",
                worker.session_id
            );
            None
        }
    };

    // Prefer wire for context fill (last-turn prompt size). Prefer ACP usage for
    // the tooltip breakdown when present; otherwise reuse the wire snapshot.
    let context_source = from_wire.clone().or_else(|| from_prompt.clone());
    let token_source = from_prompt.or(from_wire);
    let Some(context_source) = context_source else {
        return;
    };

    let used = context_source.context_tokens();
    let model = context_source
        .model
        .as_deref()
        .or(token_source.as_ref().and_then(|u| u.model.as_deref()))
        .unwrap_or("");
    let size = global_config::max_context_size_for_model(model);
    let context_usage = size
        .filter(|s| *s > 0)
        .map(|s| ((used as f64) / (s as f64)).clamp(0.0, 1.0));

    let token_usage = token_source
        .as_ref()
        .map(session_store::SessionUsageSnapshot::to_token_usage_json)
        .unwrap_or(Value::Null);

    emit_wire_message(
        app,
        &worker.session_id,
        wire_event_message(
            "StatusUpdate",
            json!({
                "context_usage": context_usage,
                "token_usage": token_usage,
                "context_tokens": used,
                "max_context_tokens": size,
            }),
        ),
    );
}

fn usage_snapshot_from_acp_usage(usage: &Value) -> Option<session_store::SessionUsageSnapshot> {
    if !usage.is_object() {
        return None;
    }
    let snapshot = session_store::SessionUsageSnapshot {
        model: None,
        input_other: acp_usage_u64(usage, &["inputTokens", "input_tokens", "inputOther"]),
        output: acp_usage_u64(usage, &["outputTokens", "output_tokens", "output"]),
        input_cache_read: acp_usage_u64(
            usage,
            &[
                "cachedReadTokens",
                "cacheReadTokens",
                "inputCacheRead",
                "cache_read_input_tokens",
            ],
        ),
        input_cache_creation: acp_usage_u64(
            usage,
            &[
                "cachedWriteTokens",
                "cacheWriteTokens",
                "inputCacheCreation",
                "cache_creation_input_tokens",
            ],
        ),
    };
    if snapshot.context_tokens() == 0 && snapshot.output == 0 {
        return None;
    }
    Some(snapshot)
}

fn acp_usage_u64(usage: &Value, keys: &[&str]) -> u64 {
    for key in keys {
        if let Some(value) = usage.get(*key) {
            match value {
                Value::Number(n) => {
                    return n
                        .as_u64()
                        .or_else(|| n.as_i64().map(|v| v.max(0) as u64))
                        .or_else(|| {
                            n.as_f64()
                                .map(|v| if v.is_finite() && v > 0.0 { v as u64 } else { 0 })
                        })
                        .unwrap_or(0);
                }
                Value::String(s) => {
                    if let Ok(parsed) = s.parse::<u64>() {
                        return parsed;
                    }
                }
                _ => {}
            }
        }
    }
    0
}

fn emit_mode_response(app: &AppHandle, worker: &AcpWorker, id: Option<Value>) {
    let Some(id) = id else {
        return;
    };
    emit_wire_message(
        app,
        &worker.session_id,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": mode_status_payload(worker),
        })
        .to_string(),
    );
}

fn ensure_mode_change_idle(worker: &AcpWorker) -> Result<(), String> {
    if worker.in_flight_prompt_ids.lock().unwrap().is_empty() {
        Ok(())
    } else {
        Err("Session is busy; wait for completion before changing modes.".to_string())
    }
}

fn active_worker_rpc(worker: &AcpWorker) -> Result<Arc<AcpRpcSession>, String> {
    let rpc = worker
        .rpc
        .lock()
        .map_err(|err| err.to_string())?
        .as_ref()
        .cloned()
        .ok_or_else(|| "ACP RPC session is not running".to_string())?;
    if rpc.is_alive() {
        Ok(rpc)
    } else {
        Err("ACP RPC session is not running".to_string())
    }
}

async fn handle_set_plan_mode(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let enabled = mode_enabled_from_params(&params)?;
    ensure_mode_change_idle(worker)?;
    let permission_mode = *worker.permission_mode.lock().unwrap();

    let response = {
        let rpc = active_worker_rpc(worker)?;
        let mut response = rpc
            .request(
                "session/set_mode",
                json!({
                    "sessionId": worker.session_id,
                    "modeId": acp_mode_id_for_plan(enabled, permission_mode),
                }),
            )
            .await?;

        // Kimi Code CLI 0.27.0 restores persisted plan state while its ACP
        // session/resume response still advertises `default`. Re-selecting
        // Plan then returns -32603 / "Already in plan mode" before ACP can
        // apply the matching manual permission. Cycle through default so the
        // requested ACP mode is applied completely instead of swallowing a
        // partially-satisfied mode transition.
        if enabled && is_already_in_plan_mode_error(&response) {
            let reset = rpc
                .request(
                    "session/set_mode",
                    json!({
                        "sessionId": worker.session_id,
                        "modeId": acp_mode_id_for_plan(false, permission_mode),
                    }),
                )
                .await?;
            if reset.error.is_some() {
                return Err(format!(
                    "ACP session/set_mode recovery failed while resetting Plan: {}",
                    describe_rpc_error(&reset)
                ));
            }

            response = rpc
                .request(
                    "session/set_mode",
                    json!({
                        "sessionId": worker.session_id,
                        "modeId": acp_mode_id_for_plan(true, permission_mode),
                    }),
                )
                .await?;
        }

        response
    };

    if response.error.is_some() {
        return Err(format!(
            "ACP session/set_mode failed: {}",
            describe_rpc_error(&response)
        ));
    }

    *worker.plan_mode.lock().unwrap() = enabled;
    emit_mode_response(app, worker, id);
    emit_mode_status_wire(app, worker);
    Ok(())
}

async fn handle_set_permission_mode(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let next_mode = permission_mode_from_params(&params)?;
    ensure_mode_change_idle(worker)?;

    if *worker.permission_mode.lock().unwrap() == next_mode {
        emit_mode_response(app, worker, id);
        emit_mode_status_wire(app, worker);
        return Ok(());
    }

    let plan_mode = *worker.plan_mode.lock().unwrap();
    let response = {
        let rpc = active_worker_rpc(worker)?;
        let permission_response = rpc
            .request(
                "session/set_mode",
                json!({
                    "sessionId": worker.session_id,
                    "modeId": next_mode.acp_mode_id(),
                }),
            )
            .await?;
        if permission_response.error.is_some() {
            return Err(format!(
                "ACP session/set_mode failed: {}",
                describe_rpc_error(&permission_response)
            ));
        }

        if plan_mode {
            rpc.request(
                "session/set_mode",
                json!({
                    "sessionId": worker.session_id,
                    "modeId": "plan",
                }),
            )
            .await?
        } else {
            permission_response
        }
    };

    if response.error.is_some() {
        return Err(format!(
            "ACP session/set_mode failed while restoring Plan: {}",
            describe_rpc_error(&response)
        ));
    }

    *worker.permission_mode.lock().unwrap() = next_mode;
    emit_mode_response(app, worker, id);
    emit_mode_status_wire(app, worker);
    Ok(())
}

fn handle_set_swarm_mode(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let enabled = mode_enabled_from_params(&params)?;
    ensure_mode_change_idle(worker)?;

    // Kimi ACP has no native swarm mode option. Keep the compatibility behavior
    // in the worker, but persist the user's choice in the Kimi session state so
    // it follows this conversation across desktop restarts.
    session_store::update_session_swarm_mode(&worker.session_id, enabled)?;
    *worker.swarm_mode.lock().unwrap() = enabled;
    emit_mode_response(app, worker, id);
    emit_mode_status_wire(app, worker);
    Ok(())
}

async fn handle_replay(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    id: Option<Value>,
) -> Result<(), String> {
    let cwd = worker
        .workspace_cwd
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "ACP session workspace is not ready".to_string())?;
    *worker.last_session_update_at.lock().unwrap() = None;
    set_worker_status(app, worker, "busy", Some("replay"), None);
    let response = {
        let rpc = active_worker_rpc(worker)?;
        rpc.request(
            "session/load",
            json!({
                "sessionId": worker.session_id,
                "cwd": cwd.to_string_lossy(),
                "mcpServers": crate::mcp_config::mcp_servers_for_acp(),
            }),
        )
        .await
    }?;

    if response.error.is_some() {
        set_worker_status(app, worker, "idle", Some("replay_error"), None);
        return Err(format!(
            "ACP session/load failed: {}",
            describe_rpc_error(&response)
        ));
    }

    wait_for_session_update_quiescence(worker, Duration::from_millis(150), Duration::from_secs(5))
        .await;

    emit_wire_message(
        app,
        &worker.session_id,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "status": "finished", "events": 0, "requests": 0 }
        })
        .to_string(),
    );
    set_worker_status(app, worker, "idle", Some("replay_complete"), None);
    emit_usage_status_wire(app, worker, None);
    Ok(())
}

async fn wait_for_session_update_quiescence(
    worker: &AcpWorker,
    quiet_period: Duration,
    timeout: Duration,
) {
    let started = Instant::now();
    loop {
        let last_update = *worker.last_session_update_at.lock().unwrap();
        if last_update
            .map(|instant| instant.elapsed() >= quiet_period)
            .unwrap_or(true)
        {
            return;
        }
        if started.elapsed() >= timeout {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn handle_prompt(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let prompt_id = id
        .as_ref()
        .map(|value| match value {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => value.to_string(),
        })
        .ok_or_else(|| "prompt message requires an id".to_string())?;

    {
        let mut in_flight = worker.in_flight_prompt_ids.lock().unwrap();
        if !in_flight.is_empty() {
            return Err(
                "Session is busy; wait for completion before sending a new prompt.".to_string(),
            );
        }
        in_flight.insert(prompt_id.clone());
    }

    let prompt_started_at = Instant::now();
    let prompt_log_offset = session_store::session_log_offset(&worker.session_id)
        .ok()
        .flatten();
    set_worker_status(app, worker, "busy", Some("prompt"), None);
    let expand_result = {
        let mut sent = worker.sent_upload_files.lock().unwrap();
        session_files::expand_prompt_with_uploads(&worker.session_id, &params, &mut sent)
    };
    let expanded_params = match expand_result {
        Ok(expanded) => expanded,
        Err(err) => {
            fail_prompt_in_flight(app, worker, &prompt_id, "prompt_prepare_error", &err);
            return Err(err);
        }
    };
    let swarm_mode = *worker.swarm_mode.lock().unwrap();
    let prompt = legacy_user_input_to_acp_prompt_with_swarm(&expanded_params, swarm_mode);
    let response = {
        let rpc = match active_worker_rpc(worker) {
            Ok(rpc) => rpc,
            Err(err) => {
                fail_prompt_in_flight(app, worker, &prompt_id, "rpc_unavailable", &err);
                return Err(err);
            }
        };
        rpc.request_with_timeout(
            "session/prompt",
            json!({
                "sessionId": worker.session_id,
                "prompt": prompt,
            }),
            acp_prompt_timeout(),
        )
        .await
    };

    let response = match response {
        Ok(response) => response,
        Err(err) => {
            fail_prompt_in_flight(app, worker, &prompt_id, "prompt_transport_error", &err);
            return Err(err);
        }
    };

    if response.error.is_some() {
        let detail = response
            .error
            .as_ref()
            .and_then(|error| error.message.as_deref())
            .filter(|message| !message.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| describe_rpc_error(&response));
        fail_prompt_in_flight(app, worker, &prompt_id, "prompt_error", &detail);
        return Err(format!(
            "ACP session/prompt failed: {}",
            describe_rpc_error(&response)
        ));
    }

    let had_session_update = worker
        .last_session_update_at
        .lock()
        .unwrap()
        .is_some_and(|updated_at| updated_at >= prompt_started_at);
    let mut logged_failure = prompt_log_offset.and_then(|offset| {
        match session_store::acp_turn_failure_since(&worker.session_id, offset) {
            Ok(detail) => detail,
            Err(err) => {
                eprintln!("[acp] failed to inspect prompt log: {err}");
                None
            }
        }
    });
    if logged_failure.is_none() && !had_session_update && prompt_log_offset.is_some() {
        tokio::time::sleep(Duration::from_millis(40)).await;
        logged_failure = prompt_log_offset.and_then(|offset| {
            session_store::acp_turn_failure_since(&worker.session_id, offset)
                .map_err(|err| eprintln!("[acp] failed to inspect prompt log: {err}"))
                .ok()
                .flatten()
        });
    }
    if let Some(detail) = logged_failure {
        fail_prompt_in_flight(app, worker, &prompt_id, "prompt_runtime_error", &detail);
        return Err(format!("ACP prompt failed: {detail}"));
    }

    worker
        .in_flight_prompt_ids
        .lock()
        .unwrap()
        .remove(&prompt_id);

    let stop_reason = response
        .result
        .as_ref()
        .and_then(|result| result.get("stopReason"))
        .and_then(Value::as_str);
    let status = legacy_prompt_status_from_stop_reason(stop_reason);
    emit_wire_message(
        app,
        &worker.session_id,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "status": status }
        })
        .to_string(),
    );
    set_worker_status(app, worker, "idle", Some(status), None);
    emit_usage_status_wire(app, worker, response.result.as_ref());
    Ok(())
}

fn fail_prompt_in_flight(
    app: &AppHandle,
    worker: &AcpWorker,
    prompt_id: &str,
    reason: &str,
    detail: &str,
) {
    worker
        .in_flight_prompt_ids
        .lock()
        .unwrap()
        .remove(prompt_id);
    set_worker_status(app, worker, "error", Some(reason), Some(detail));
}

async fn handle_cancel(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    id: Option<Value>,
) -> Result<(), String> {
    let had_in_flight = !worker.in_flight_prompt_ids.lock().unwrap().is_empty();

    if had_in_flight {
        {
            let rpc = active_worker_rpc(worker)?;
            rpc.notify("session/cancel", json!({ "sessionId": worker.session_id }))?;
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if worker.in_flight_prompt_ids.lock().unwrap().is_empty() {
                break;
            }
            if Instant::now() >= deadline {
                worker.in_flight_prompt_ids.lock().unwrap().clear();
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    emit_wire_message(
        app,
        &worker.session_id,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "status": "cancelled" }
        })
        .to_string(),
    );
    set_worker_status(app, worker, "idle", Some("cancelled"), None);
    Ok(())
}

async fn handle_permission_response(
    worker: &Arc<AcpWorker>,
    id: Option<Value>,
    result: Option<&Value>,
) -> Result<(), String> {
    let wire_id = id
        .map(|value| match value {
            Value::String(s) => s,
            Value::Number(n) => n.to_string(),
            _ => value.to_string(),
        })
        .unwrap_or_default();
    let acp_request_id = worker
        .pending_permission_ids
        .lock()
        .unwrap()
        .remove(&wire_id);
    let Some(acp_request_id) = acp_request_id else {
        // Question answers share this result path; missing mapping used to no-op and hang the turn.
        if result.and_then(|v| v.get("answers")).is_some() {
            return Err(format!(
                "No pending ACP request for question response id `{wire_id}`"
            ));
        }
        return Ok(());
    };
    let outcome = legacy_approval_result_to_acp_outcome(result.unwrap_or(&Value::Null));
    let rpc = active_worker_rpc(worker)?;
    rpc.respond(acp_request_id, outcome)?;
    Ok(())
}

fn is_worker_session_usable(worker: &AcpWorker) -> bool {
    let state = match worker.status.lock() {
        Ok(guard) => guard.state.clone(),
        Err(_) => return false,
    };
    if !matches!(state.as_str(), "ready" | "running" | "busy" | "idle") {
        return false;
    }
    active_worker_rpc(worker).is_ok()
}

async fn stop_worker_async(worker: &AcpWorker, reason: &str) {
    // Mark stopped before killing so the stdout reader does not treat an
    // intentional shutdown (e.g. config_update restart) as an unexpected exit.
    mark_worker_stopped(worker, reason);
    if let Some(rpc) = worker.rpc.lock().unwrap().take() {
        let _ = rpc.shutdown();
    }
}

fn stop_worker_best_effort(worker: &AcpWorker, reason: &str) {
    mark_worker_stopped(worker, reason);
    if let Ok(mut guard) = worker.rpc.try_lock() {
        if let Some(rpc) = guard.take() {
            let _ = rpc.shutdown();
        }
    }
}

fn mark_worker_stopped(worker: &AcpWorker, reason: &str) {
    worker.in_flight_prompt_ids.lock().unwrap().clear();
    worker.pending_permission_ids.lock().unwrap().clear();
    let seq = worker.status_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let mut status = worker.status.lock().unwrap();
    status.state = "stopped".to_string();
    status.seq = seq;
    status.reason = Some(reason.to_string());
    status.detail = Some(format!("ACP worker stopped ({reason})"));
    status.updated_at = now_ms();
}

fn record_worker_rpc_dead(worker: &AcpWorker) -> Option<u64> {
    worker.in_flight_prompt_ids.lock().unwrap().clear();
    let mut status = worker.status.lock().unwrap();
    if status.state == "stopped" {
        return None;
    }
    let seq = worker.status_seq.fetch_add(1, Ordering::SeqCst) + 1;
    status.state = "error".to_string();
    status.seq = seq;
    status.reason = Some("acp_process_exited".to_string());
    status.detail = Some("The ACP subprocess exited unexpectedly".to_string());
    status.updated_at = now_ms();
    Some(seq)
}

fn mark_worker_rpc_dead(app: &AppHandle, worker: &AcpWorker) {
    let Some(seq) = record_worker_rpc_dead(worker) else {
        return;
    };
    emit_session_status_wire(
        app,
        worker,
        "error",
        seq,
        Some("acp_process_exited"),
        Some("The ACP subprocess exited unexpectedly"),
    );
}

fn spawn_acp_rpc_session(
    program: &str,
    app: AppHandle,
    worker: Arc<AcpWorker>,
) -> Result<AcpRpcSession, String> {
    if let Some(repair) = global_config::repair_active_provider_endpoint()? {
        eprintln!(
            "[acp] repaired active provider endpoint: model={} provider={} type={}",
            repair.model_alias, repair.provider, repair.provider_type
        );
    }
    let mut command = Command::new(program);
    command
        .arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn `{program} acp`: {e}"))?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or_else(|| "ACP child stdin unavailable".to_string())?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ACP child stdout unavailable".to_string())?;
    let stderr = child.stderr.take();

    let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let reader_alive = Arc::new(Mutex::new(true));

    let pending_reader = Arc::clone(&pending);
    let reader_flag = Arc::clone(&reader_alive);
    let stdin_writer = Arc::clone(&stdin);
    let app_for_reader = app.clone();
    let worker_for_reader = Arc::clone(&worker);
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if let Err(err) = handle_acp_stdout_line(
                &line,
                &app_for_reader,
                &worker_for_reader,
                &pending_reader,
                &stdin_writer,
            ) {
                eprintln!("[acp] {err}");
            }
        }
        *reader_flag.lock().unwrap() = false;
        mark_worker_rpc_dead(&app_for_reader, &worker_for_reader);
        let leftover = {
            let mut pending = pending_reader.lock().unwrap();
            std::mem::take(&mut *pending)
        };
        for (_, sender) in leftover {
            let _ = sender.send(JsonRpcResponse {
                id: None,
                result: None,
                error: Some(JsonRpcError {
                    code: Some(json!(-32001)),
                    message: Some("ACP process closed before response".to_string()),
                    data: None,
                }),
                method: None,
            });
        }
    });

    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    eprintln!("[acp:stderr] {line}");
                }
            }
        });
    }

    Ok(AcpRpcSession {
        child: Mutex::new(child),
        stdin,
        pending,
        next_id: AtomicU64::new(1),
        reader_alive,
    })
}

fn handle_acp_stdout_line(
    line: &str,
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    stdin: &Arc<Mutex<ChildStdin>>,
) -> Result<(), String> {
    let message: Value =
        serde_json::from_str(line.trim()).map_err(|err| format!("invalid JSON-RPC line: {err}"))?;
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").and_then(json_id_as_u64);
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    if let Some(method) = method {
        if let Some(request_id) = id {
            handle_acp_reverse_request(app, worker, request_id, method, &params, stdin)?;
            return Ok(());
        }
        handle_acp_notification(app, worker, method, &params)?;
        return Ok(());
    }

    if let Some(request_id) = id {
        let response = JsonRpcResponse {
            id: Some(request_id),
            result: message.get("result").cloned(),
            error: message
                .get("error")
                .and_then(|value| serde_json::from_value(value.clone()).ok()),
            method: None,
        };
        if let Some(sender) = pending.lock().unwrap().remove(&request_id) {
            let _ = sender.send(response);
        }
    }
    Ok(())
}

fn handle_acp_notification(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    method: &str,
    params: &Value,
) -> Result<(), String> {
    match method {
        "session/update" => {
            *worker.last_session_update_at.lock().unwrap() = Some(Instant::now());
            let update = params.get("update").cloned().unwrap_or(Value::Null);
            if apply_current_mode_update(worker, &update) {
                // Agent-initiated mode change (e.g. ExitPlanMode): worker state
                // is updated, push the new mode status to the UI.
                emit_mode_status_wire(app, worker);
                return Ok(());
            }
            if sync_plan_mode_exit_from_tool_result(worker, &update) {
                // Plan mode flipped off; keep translating the tool result for
                // the timeline as usual.
                emit_mode_status_wire(app, worker);
            }
            if let Some(wire_message) = acp_update_to_wire_event(&worker.session_id, &update) {
                emit_wire_message(app, &worker.session_id, wire_message);
            } else {
                for wire_message in translate_session_update(&worker.session_id, &update) {
                    emit_wire_message(app, &worker.session_id, wire_message);
                }
            }
        }
        _ => {
            let wire_messages =
                translate_acp_lifecycle_notification(&worker.session_id, method, params);
            if wire_messages.is_empty() {
                eprintln!("[acp] ignored notification: {method}");
            } else {
                for wire_message in wire_messages {
                    emit_wire_message(app, &worker.session_id, wire_message);
                }
            }
        }
    }
    Ok(())
}

fn handle_acp_reverse_request(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    request_id: u64,
    method: &str,
    params: &Value,
    stdin: &Arc<Mutex<ChildStdin>>,
) -> Result<(), String> {
    match method {
        "session/request_permission" => {
            if let Some((wire_message, wire_id)) =
                acp_permission_to_legacy_request(request_id, params)
            {
                worker
                    .pending_permission_ids
                    .lock()
                    .unwrap()
                    .insert(wire_id, request_id);
                emit_wire_message(app, &worker.session_id, wire_message);
            } else {
                eprintln!(
                    "[WARN] Unknown ACP permission request (id={request_id}); defaulting to reject-once"
                );
                write_acp_response(
                    stdin,
                    request_id,
                    json!({
                        "outcome": { "outcome": "selected", "optionId": "reject-once" }
                    }),
                )?;
            }
        }
        "fs/read_text_file" => {
            let result = handle_fs_read_text_file(worker, params);
            write_acp_response(stdin, request_id, result)?;
        }
        "fs/write_text_file" => {
            let result = handle_fs_write_text_file(worker, params);
            write_acp_response(stdin, request_id, result)?;
        }
        _ => {
            write_acp_response(
                stdin,
                request_id,
                json!({
                    "error": {
                        "code": -32601,
                        "message": format!("Unsupported ACP client method: {method}")
                    }
                }),
            )?;
        }
    }
    Ok(())
}

fn handle_fs_read_text_file(worker: &Arc<AcpWorker>, params: &Value) -> Value {
    let path = params.get("path").and_then(Value::as_str).unwrap_or("");
    let workspace = match worker.workspace_cwd.lock().unwrap().clone() {
        Some(path) => path,
        None => return json!({ "error": { "code": -32603, "message": "workspace unavailable" } }),
    };
    match normalize_workspace_path(path, &workspace) {
        Ok(resolved) => match std::fs::read_to_string(&resolved) {
            Ok(content) => json!({ "content": content }),
            Err(err) => json!({
                "error": {
                    "code": -32603,
                    "message": format!("failed to read {}: {err}", resolved.display())
                }
            }),
        },
        Err(message) => json!({ "error": { "code": -32603, "message": message } }),
    }
}

fn handle_fs_write_text_file(worker: &Arc<AcpWorker>, params: &Value) -> Value {
    let path = params.get("path").and_then(Value::as_str).unwrap_or("");
    let content = params.get("content").and_then(Value::as_str).unwrap_or("");
    let workspace = match worker.workspace_cwd.lock().unwrap().clone() {
        Some(path) => path,
        None => return json!({ "error": { "code": -32603, "message": "workspace unavailable" } }),
    };
    match normalize_workspace_path(path, &workspace) {
        Ok(resolved) => {
            if let Some(parent) = resolved.parent() {
                if let Err(err) = std::fs::create_dir_all(parent) {
                    return json!({
                        "error": {
                            "code": -32603,
                            "message": format!(
                                "failed to create parent directories for {}: {err}",
                                resolved.display()
                            )
                        }
                    });
                }
            }
            match std::fs::write(&resolved, content) {
                Ok(()) => json!({}),
                Err(err) => json!({
                    "error": {
                        "code": -32603,
                        "message": format!("failed to write {}: {err}", resolved.display())
                    }
                }),
            }
        }
        Err(message) => json!({ "error": { "code": -32603, "message": message } }),
    }
}

fn write_acp_response(
    stdin: &Arc<Mutex<ChildStdin>>,
    request_id: u64,
    body: Value,
) -> Result<(), String> {
    let message = if body.get("error").is_some() {
        json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": body.get("error").cloned().unwrap_or(Value::Null),
        })
    } else {
        json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": body,
        })
    };
    let line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    let mut stdin = stdin.lock().map_err(|e| e.to_string())?;
    stdin
        .write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("failed to write ACP response: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("failed to flush ACP response: {e}"))?;
    Ok(())
}

fn json_id_as_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

impl AcpRpcSession {
    pub(crate) fn is_alive(&self) -> bool {
        if !*self.reader_alive.lock().unwrap() {
            return false;
        }
        let Ok(mut child) = self.child.lock() else {
            return false;
        };
        match child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    pub(crate) async fn request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<JsonRpcResponse, String> {
        self.request_with_timeout(method, params, acp_rpc_timeout())
            .await
    }

    pub(crate) async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<JsonRpcResponse, String> {
        if !self.is_alive() {
            return Err("ACP reader is not alive".to_string());
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        {
            let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
            stdin
                .write_all(format!("{line}\n").as_bytes())
                .map_err(|e| format!("failed to write ACP request: {e}"))?;
            stdin
                .flush()
                .map_err(|e| format!("failed to flush ACP request: {e}"))?;
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(format!("ACP request `{method}` channel closed")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                let _ = self.shutdown();
                Err(format!(
                    "ACP request `{method}` timed out after {}s",
                    timeout.as_secs()
                ))
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
        let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .map_err(|e| format!("failed to write ACP notification: {e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("failed to flush ACP notification: {e}"))?;
        Ok(())
    }

    fn respond(&self, request_id: u64, result: Value) -> Result<(), String> {
        write_acp_response(&self.stdin, request_id, result)
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let leftover = {
            let mut pending = self.pending.lock().unwrap();
            std::mem::take(&mut *pending)
        };
        for (_, sender) in leftover {
            let _ = sender.send(JsonRpcResponse {
                id: None,
                result: None,
                error: Some(JsonRpcError {
                    code: Some(json!(-32001)),
                    message: Some("ACP session shutting down".to_string()),
                    data: None,
                }),
                method: None,
            });
        }

        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::lock::set_kimi_code_home;
    use serde_json::json;

    #[cfg(target_os = "windows")]
    fn spawn_stdin_sink_rpc() -> AcpRpcSession {
        let mut child = Command::new("cmd")
            .args(["/d", "/c", "more > nul"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn stdin sink");
        let stdin = child.stdin.take().expect("stdin sink pipe");
        AcpRpcSession {
            child: Mutex::new(child),
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            reader_alive: Arc::new(Mutex::new(true)),
        }
    }

    #[test]
    fn acp_rpc_timeout_reads_env_override() {
        std::env::set_var("ACP_RPC_TIMEOUT_SECS", "300");
        assert_eq!(super::acp_rpc_timeout(), Duration::from_secs(300));
        std::env::remove_var("ACP_RPC_TIMEOUT_SECS");
        assert_eq!(
            super::acp_rpc_timeout(),
            Duration::from_secs(super::ACP_RPC_TIMEOUT_DEFAULT_SECS)
        );
    }

    #[test]
    fn acp_prompt_timeout_reads_env_override() {
        std::env::set_var("ACP_PROMPT_TIMEOUT_SECS", "600");
        assert_eq!(super::acp_prompt_timeout(), Duration::from_secs(600));
        std::env::remove_var("ACP_PROMPT_TIMEOUT_SECS");
        assert_eq!(
            super::acp_prompt_timeout(),
            Duration::from_secs(super::ACP_PROMPT_TIMEOUT_DEFAULT_SECS)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn prompt_handle_does_not_block_reverse_response_or_cancel_writes() {
        let worker = new_probe_worker();
        let rpc = Arc::new(spawn_stdin_sink_rpc());
        worker.rpc.lock().unwrap().replace(Arc::clone(&rpc));

        // Keeping the prompt-side handle alive must not retain the worker slot
        // lock. Reverse permission responses and cancellation notifications
        // need the same transport while `session/prompt` is still pending.
        let prompt_rpc = active_worker_rpc(&worker).expect("prompt transport");
        let reverse_rpc = active_worker_rpc(&worker).expect("reverse transport");
        assert!(Arc::ptr_eq(&prompt_rpc, &reverse_rpc));
        reverse_rpc
            .respond(42, json!({ "outcome": "allow-once" }))
            .expect("write reverse response while prompt handle is alive");
        reverse_rpc
            .notify("session/cancel", json!({ "sessionId": "probe" }))
            .expect("write cancel while prompt handle is alive");

        rpc.shutdown().expect("stop stdin sink");
    }

    #[test]
    fn resolve_prefers_explicit_path() {
        assert_eq!(
            resolve_acp_command_from_env(Some(r"C:\Tools\kimi.exe")),
            r"C:\Tools\kimi.exe"
        );
    }

    #[test]
    fn resolve_defaults_to_kimi() {
        assert_eq!(resolve_acp_command_from_env(None), "kimi");
        assert_eq!(resolve_acp_command_from_env(Some("")), "kimi");
        assert_eq!(resolve_acp_command_from_env(Some("  ")), "kimi");
    }

    #[test]
    fn parser_accepts_valid_response() {
        let parsed = parse_jsonrpc_line(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#).unwrap();
        assert_eq!(parsed.id, Some(1));
        assert!(parsed.result.is_some());
    }

    #[test]
    fn parser_rejects_invalid_json() {
        assert!(parse_jsonrpc_line("not-json").is_err());
    }

    #[test]
    fn unexpected_rpc_exit_becomes_a_terminal_error() {
        let worker = new_probe_worker();
        worker
            .in_flight_prompt_ids
            .lock()
            .unwrap()
            .insert("prompt-1".to_string());

        let seq = record_worker_rpc_dead(&worker).expect("exit should update status");
        let status = worker.status.lock().unwrap().clone();

        assert_eq!(status.state, "error");
        assert_eq!(status.seq, seq);
        assert_eq!(status.reason.as_deref(), Some("acp_process_exited"));
        assert!(status.detail.as_deref().unwrap().contains("unexpectedly"));
        assert!(worker.in_flight_prompt_ids.lock().unwrap().is_empty());
    }

    #[test]
    fn intentional_stop_suppresses_unexpected_exit_error() {
        let worker = new_probe_worker();
        {
            let mut status = worker.status.lock().unwrap();
            status.state = "idle".to_string();
        }
        mark_worker_stopped(&worker, "config_update");

        assert!(
            record_worker_rpc_dead(&worker).is_none(),
            "stdout EOF after intentional stop must not become an error"
        );
        let status = worker.status.lock().unwrap().clone();
        assert_eq!(status.state, "stopped");
        assert_eq!(status.reason.as_deref(), Some("config_update"));
    }

    #[test]
    fn initialize_uses_local_filesystem_fallback() {
        let params = acp_initialize_params();
        assert_eq!(params["protocolVersion"], 1);
        assert_eq!(params["clientCapabilities"], json!({}));
        assert!(params["clientCapabilities"]["fs"].is_null());
    }

    #[test]
    fn auth_required_detects_error_code_and_message() {
        let response = JsonRpcResponse {
            id: Some(2),
            result: None,
            error: Some(JsonRpcError {
                code: Some(json!(-32000)),
                message: Some("authRequired".to_string()),
                data: None,
            }),
            method: None,
        };
        assert!(is_auth_required_response(&response));
        assert!(!is_authenticated_response(&response));
    }

    #[test]
    fn empty_authenticate_result_counts_as_authenticated() {
        let response = JsonRpcResponse {
            id: Some(2),
            result: Some(json!({})),
            error: None,
            method: None,
        };
        assert!(is_authenticated_response(&response));
        assert!(!is_auth_required_response(&response));
    }

    #[test]
    fn detects_kimi_already_in_plan_mode_error() {
        let response = JsonRpcResponse {
            id: Some(4),
            result: None,
            error: Some(JsonRpcError {
                code: Some(json!(-32603)),
                message: Some("Internal error".to_string()),
                data: Some(json!({ "details": "Already in plan mode" })),
            }),
            method: None,
        };

        assert!(is_already_in_plan_mode_error(&response));
        assert_eq!(
            describe_rpc_error(&response),
            "code=-32603 message=Internal error details=Already in plan mode"
        );
    }

    #[test]
    fn does_not_treat_other_internal_errors_as_idempotent_plan_success() {
        let response = JsonRpcResponse {
            id: Some(4),
            result: None,
            error: Some(JsonRpcError {
                code: Some(json!(-32603)),
                message: Some("Internal error".to_string()),
                data: Some(json!({ "details": "Session is busy" })),
            }),
            method: None,
        };

        assert!(!is_already_in_plan_mode_error(&response));
    }

    #[test]
    fn session_list_sanitizer_redacts_values() {
        let raw = json!({
            "sessions": [{
                "sessionId": "sess-1",
                "cwd": "C:/Users/secret/project",
                "title": "private title",
                "updatedAt": "2026-07-08T00:00:00Z"
            }],
            "nextCursor": null
        });
        let sanitized = sanitize_session_list_for_log(&raw);
        let text = sanitized.to_string();
        assert!(!text.contains("private title"));
        assert!(!text.contains("Users/secret"));
        assert_eq!(sanitized["sessions"]["count"], 1);
        assert!(sanitized["sessions"]["sampleFields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some("title")));
    }

    #[test]
    fn mode_update_requires_boolean_enabled() {
        assert_eq!(
            mode_enabled_from_params(&json!({ "enabled": true })),
            Ok(true)
        );
        assert!(mode_enabled_from_params(&json!({ "enabled": "true" })).is_err());
        assert!(mode_enabled_from_params(&json!({})).is_err());
    }

    #[test]
    fn permission_mode_update_accepts_only_supported_modes() {
        assert_eq!(
            permission_mode_from_params(&json!({ "mode": "manual" })),
            Ok(PermissionMode::Manual)
        );
        assert_eq!(
            permission_mode_from_params(&json!({ "mode": "ask" })),
            Ok(PermissionMode::Manual)
        );
        assert_eq!(
            permission_mode_from_params(&json!({ "mode": "auto" })),
            Ok(PermissionMode::Auto)
        );
        assert_eq!(
            permission_mode_from_params(&json!({ "mode": "yolo" })),
            Ok(PermissionMode::Yolo)
        );
        assert!(permission_mode_from_params(&json!({ "mode": "unsafe" })).is_err());
    }

    #[test]
    fn initial_runtime_modes_use_session_state_then_global_defaults() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("kimi-home");
        let session_id = "session-mode-inheritance";
        let wire_dir = home
            .join("sessions")
            .join("work-key")
            .join(session_id)
            .join("agents")
            .join("main");
        std::fs::create_dir_all(&wire_dir).expect("wire dir");
        std::fs::write(
            home.join("config.toml"),
            "default_plan_mode = true\ndefault_permission_mode = \"auto\"\n",
        )
        .expect("config");
        let _lock = set_kimi_code_home(&home);

        assert_eq!(
            resolve_initial_runtime_modes(session_id),
            (true, PermissionMode::Auto, false)
        );

        session_store::update_session_swarm_mode(session_id, true).expect("persist swarm mode");

        std::fs::write(
            wire_dir.join("wire.jsonl"),
            concat!(
                "{\"type\":\"permission.set_mode\",\"mode\":\"manual\"}\n",
                "{\"type\":\"plan_mode.cancel\"}\n"
            ),
        )
        .expect("wire log");

        assert_eq!(
            resolve_initial_runtime_modes(session_id),
            (false, PermissionMode::Manual, true)
        );
    }

    #[test]
    fn plan_mode_restores_the_independent_permission_mode_when_disabled() {
        assert_eq!(acp_mode_id_for_plan(true, PermissionMode::Auto), "plan");
        assert_eq!(
            acp_mode_id_for_plan(false, PermissionMode::Manual),
            "default"
        );
        assert_eq!(acp_mode_id_for_plan(false, PermissionMode::Auto), "auto");
        assert_eq!(acp_mode_id_for_plan(false, PermissionMode::Yolo), "yolo");
    }

    #[test]
    fn current_mode_update_syncs_agent_initiated_mode_changes() {
        let worker = new_probe_worker();

        // Agent reports entering plan mode on its own.
        assert!(apply_current_mode_update(
            &worker,
            &json!({ "sessionUpdate": "current_mode_update", "currentModeId": "plan" })
        ));
        assert!(*worker.plan_mode.lock().unwrap());

        // Agent left plan mode (e.g. ExitPlanMode): plan off, permission mode
        // follows the reported mode id.
        assert!(apply_current_mode_update(
            &worker,
            &json!({ "sessionUpdate": "current_mode_update", "currentModeId": "auto" })
        ));
        assert!(!(*worker.plan_mode.lock().unwrap()));
        assert_eq!(
            *worker.permission_mode.lock().unwrap(),
            PermissionMode::Auto
        );

        // Unknown mode ids are swallowed without corrupting state.
        assert!(apply_current_mode_update(
            &worker,
            &json!({ "sessionUpdate": "current_mode_update", "currentModeId": "bogus" })
        ));
        assert_eq!(
            *worker.permission_mode.lock().unwrap(),
            PermissionMode::Auto
        );

        // Other session updates pass through to the stream translator.
        assert!(!apply_current_mode_update(
            &worker,
            &json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hi" }
            })
        ));
    }

    #[test]
    fn plan_exit_is_detected_from_exit_plan_mode_tool_result() {
        let worker = new_probe_worker();
        *worker.plan_mode.lock().unwrap() = true;

        // Shape captured from a live `kimi acp` 0.27 turn (ACP probe).
        let exit_update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "0:tool_URf7LCpy1l1yJXij5X7T3oMl",
            "status": "completed",
            "content": [{
                "type": "content",
                "content": {
                    "type": "text",
                    "text": "Exited plan mode. Plan mode deactivated. All tools are now available."
                }
            }]
        });
        assert!(sync_plan_mode_exit_from_tool_result(&worker, &exit_update));
        assert!(!(*worker.plan_mode.lock().unwrap()));

        // Already off: nothing to sync, no duplicate status emit.
        assert!(!sync_plan_mode_exit_from_tool_result(&worker, &exit_update));

        // Other completed tool results must not flip plan mode.
        *worker.plan_mode.lock().unwrap() = true;
        let write_update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "0:tool_pA5t5AlE0q6zy8EDJZfBiK93",
            "status": "completed",
            "content": [{
                "type": "content",
                "content": { "type": "text", "text": "Wrote 71 bytes to plan.md" }
            }]
        });
        assert!(!sync_plan_mode_exit_from_tool_result(
            &worker,
            &write_update
        ));
        assert!(*worker.plan_mode.lock().unwrap());

        // In-progress updates never flip plan mode.
        let in_progress = json!({
            "sessionUpdate": "tool_call_update",
            "status": "in_progress",
            "content": [{
                "type": "content",
                "content": { "type": "text", "text": "Exited plan mode." }
            }]
        });
        assert!(!sync_plan_mode_exit_from_tool_result(&worker, &in_progress));
        assert!(*worker.plan_mode.lock().unwrap());
    }

    #[test]
    fn mode_status_acknowledges_all_backend_modes() {
        let payload = mode_status_payload_for(true, PermissionMode::Auto, false);
        assert_eq!(payload["plan_mode"], true);
        assert_eq!(payload["permission_mode"], "auto");
        assert_eq!(payload["swarm_mode"], false);
        assert!(payload["context_usage"].is_null());
    }
}

#[cfg(test)]
mod session_cwd_tests {
    use super::acp_session_cwd_from_list_item;
    use std::path::PathBuf;

    #[test]
    fn acp_session_cwd_from_list_item_prefers_cwd_field() {
        let item = serde_json::json!({ "sessionId": "abc", "cwd": "C:\\work", "title": "t" });
        assert_eq!(
            acp_session_cwd_from_list_item(&item).unwrap(),
            PathBuf::from(r"C:\work")
        );
    }
}
