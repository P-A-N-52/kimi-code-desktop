//! Kimi Code ACP process manager (Milestone 1 shell + Milestone 2 translation).

use crate::acp_translate::{
    acp_permission_to_legacy_request, acp_slash_command_prompt, acp_update_to_wire_event,
    legacy_approval_result_to_acp_outcome_with_options, legacy_prompt_status_from_stop_reason,
    legacy_user_input_to_acp_prompt_with_swarm, normalize_workspace_path,
    translate_acp_lifecycle_notification, translate_session_config_snapshot,
    translate_session_update, wire_event_message,
};
use crate::wire_events::{
    emit_wire_message as emit_raw_wire_message,
    emit_wire_messages_batch as emit_raw_wire_messages_batch, RestartWorkersSummary, RuntimeStatus,
};
use crate::{global_config, goal_queue, goal_store, session_files, session_store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
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
const ACP_TEXT_FLUSH_WINDOW: Duration = Duration::from_millis(30);
const ACP_TEXT_FLUSH_MAX_BYTES: usize = 8 * 1024;
const GOAL_BRIDGE_POLL_INTERVAL: Duration = Duration::from_millis(200);
const GOAL_BRIDGE_HANDOFF_GRACE: Duration = Duration::from_secs(2);
const GOAL_TERMINAL_QUIET_PERIOD: Duration = Duration::from_secs(2);
const GOAL_CANCEL_ACK_TIMEOUT: Duration = Duration::from_secs(5);

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

fn pick_auth_method_id(initialize_result: &Value) -> String {
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
    connect_ops: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
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

pub(crate) struct PendingPermission {
    acp_request_id: u64,
    /// Opaque ACP permission options from the original request — response
    /// must echo one of these `optionId`s (plan_review uses plan_* ids).
    options: Vec<Value>,
}

struct TextWireAggregator {
    pending_messages: Vec<String>,
    pending_bytes: usize,
    max_bytes: usize,
}

impl TextWireAggregator {
    fn new(max_bytes: usize) -> Self {
        assert!(max_bytes > 0, "text flush threshold must be positive");
        Self {
            pending_messages: Vec::new(),
            pending_bytes: 0,
            max_bytes,
        }
    }

    fn push(&mut self, message: String) -> bool {
        self.pending_bytes = self.pending_bytes.saturating_add(message.len());
        self.pending_messages.push(message);
        self.pending_bytes >= self.max_bytes
    }

    fn take(&mut self) -> Vec<String> {
        self.pending_bytes = 0;
        std::mem::take(&mut self.pending_messages)
    }

    fn clear(&mut self) {
        self.pending_messages.clear();
        self.pending_bytes = 0;
    }

    fn is_empty(&self) -> bool {
        self.pending_messages.is_empty()
    }
}

impl Default for TextWireAggregator {
    fn default() -> Self {
        Self::new(ACP_TEXT_FLUSH_MAX_BYTES)
    }
}

#[derive(Default)]
struct WireOutputState {
    text: TextWireAggregator,
    flush_timer_started: bool,
    last_plan_message: Option<String>,
    last_config_message: Option<String>,
}

pub(crate) struct AcpWorker {
    session_id: String,
    // Keep the app handle on the worker so shutdown paths such as stop_all,
    // which cannot receive one from their caller, can still flush pending text.
    app_handle: Option<AppHandle>,
    connection_id: Mutex<Option<String>>,
    workspace_cwd: Mutex<Option<PathBuf>>,
    status: Mutex<RuntimeStatus>,
    // Keep only a short-lived lock around the session handle itself. The
    // session is shared so a long-running `session/prompt` request cannot
    // block reverse-request responses or `session/cancel` notifications.
    rpc: Mutex<Option<Arc<AcpRpcSession>>>,
    wire_output: Mutex<WireOutputState>,
    status_seq: AtomicU64,
    in_flight_prompt_ids: Mutex<HashSet<String>>,
    pending_permission_ids: Mutex<HashMap<String, PendingPermission>>,
    last_session_update_at: Mutex<Option<Instant>>,
    plan_mode: Mutex<bool>,
    permission_mode: Mutex<PermissionMode>,
    swarm_mode: Mutex<bool>,
    goal_mode: Mutex<bool>,
    /// Serialize plan/permission ACP `session/set_mode` sequences so concurrent
    /// wire_send handlers cannot interleave auto ↔ default and thrash wire.
    mode_ops: tokio::sync::Mutex<()>,
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
                connect_ops: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn connect_op(&self, session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut connect_ops = self.inner.connect_ops.lock().unwrap();
        Arc::clone(
            connect_ops
                .entry(session_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
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

    /// G5 observation IPC: read-only snapshot of every live worker, sorted by
    /// session id. `updated_at` mirrors `RuntimeStatus.updated_at` (Unix ms).
    pub fn list_workers(&self) -> Vec<crate::wire_events::WorkerStatusView> {
        let workers = self.inner.workers.lock().unwrap();
        let mut views: Vec<crate::wire_events::WorkerStatusView> = workers
            .iter()
            .map(|(session_id, worker)| {
                let status = worker.status.lock().unwrap();
                crate::wire_events::WorkerStatusView {
                    session_id: session_id.clone(),
                    state: status.state.clone(),
                    connection_id: worker.connection_id.lock().unwrap().clone(),
                    updated_at: status.updated_at,
                }
            })
            .collect();
        views.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        views
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
        // Resolving cwd, authenticating, and resuming happen before the worker
        // enters the map. Serialize that whole sequence per session so two
        // concurrent wire_connect calls cannot both spawn and then replace
        // each other's live ACP worker. Different sessions remain concurrent.
        let connect_op = self.connect_op(&session_id);
        let _connect_guard = connect_op.lock().await;

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
        let (initial_plan_mode, initial_permission_mode, initial_swarm_mode, initial_goal_mode) =
            resolve_initial_runtime_modes(&session_id);

        let worker = Arc::new(AcpWorker {
            session_id: session_id.clone(),
            app_handle: Some(app.clone()),
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
            wire_output: Mutex::new(WireOutputState::default()),
            status_seq: AtomicU64::new(0),
            in_flight_prompt_ids: Mutex::new(HashSet::new()),
            pending_permission_ids: Mutex::new(HashMap::new()),
            last_session_update_at: Mutex::new(None),
            plan_mode: Mutex::new(initial_plan_mode),
            permission_mode: Mutex::new(initial_permission_mode),
            swarm_mode: Mutex::new(initial_swarm_mode),
            goal_mode: Mutex::new(initial_goal_mode),
            mode_ops: tokio::sync::Mutex::new(()),
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

        let resume_result = resume.result.as_ref().unwrap_or(&Value::Null);
        crate::acp_capabilities::set_session_config_from_response(&session_id, resume_result);

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
            crate::acp_capabilities::clear_session_config(&session_id);
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
                    worker.connection_id.lock().unwrap().as_deref() == Some(connection_id.as_str())
                })
                .unwrap_or(false);
            if matches_current_lease {
                workers.remove(&session_id)
            } else {
                None
            }
        };
        if let Some(worker) = worker {
            crate::acp_capabilities::clear_session_config(&session_id);
            stop_worker_async(&worker, "disconnected").await;
        }
        Ok(())
    }

    async fn recover_worker_after_failure(
        &self,
        app: &AppHandle,
        expected: &Arc<AcpWorker>,
        failure: &str,
    ) -> String {
        let session_id = expected.session_id.clone();
        let connection_id = expected.connection_id.lock().unwrap().clone();
        let removed = {
            let mut workers = self.inner.workers.lock().unwrap();
            if workers
                .get(&session_id)
                .is_some_and(|current| Arc::ptr_eq(current, expected))
            {
                workers.remove(&session_id)
            } else {
                None
            }
        };

        let Some(removed) = removed else {
            return format!(
                "{failure} The affected ACP worker was already replaced or disconnected."
            );
        };
        stop_worker_async(&removed, "failure_recovery").await;

        match self
            .connect_with_lease(app, session_id, connection_id)
            .await
        {
            Ok(()) => format!("{failure} The ACP worker was reconnected; retry the operation."),
            Err(reconnect_error) => format!(
                "{failure} The failed ACP worker was removed, but reconnecting failed: {reconnect_error}"
            ),
        }
    }

    /// Apply the Goal controls that ACP 0.30 does not expose.
    ///
    /// A running goal is paused through ACP `session/cancel`, which makes the
    /// native Goal engine persist `paused`. Resume is completed by the following
    /// ACP prompt through the native GetGoal/UpdateGoal tools; restarting the
    /// worker here would normalize `active` back to `paused`. Cancel appends the
    /// CLI's canonical `goal.clear` because ACP 0.30 exposes no cancel Goal RPC.
    pub async fn control_goal(
        &self,
        app: &AppHandle,
        session_id: String,
        action: String,
    ) -> Result<Option<Value>, String> {
        if !matches!(action.as_str(), "pause" | "resume" | "cancel") {
            return Err(format!("Unsupported Goal control: {action}"));
        }

        let Some(current_goal) = goal_store::session_goal_snapshot(&session_id)? else {
            return Ok(None);
        };
        let current_status = current_goal.get("status").and_then(Value::as_str);
        if action == "pause" && matches!(current_status, Some("paused" | "blocked")) {
            return Ok(Some(current_goal));
        }
        if action == "resume" {
            if current_status == Some("active") {
                return Ok(Some(current_goal));
            }
            if current_status == Some("complete") {
                return Err(
                    "A completed Goal cannot be resumed; create a new Goal instead.".into(),
                );
            }
        }

        let worker = {
            let workers = self.inner.workers.lock().unwrap();
            workers.get(&session_id).cloned()
        };
        let connection_id = worker
            .as_ref()
            .and_then(|worker| worker.connection_id.lock().unwrap().clone());

        if let Some(worker) = worker.as_ref() {
            let has_in_flight_prompt = !worker.in_flight_prompt_ids.lock().unwrap().is_empty();
            if action == "resume" && has_in_flight_prompt {
                return Err("Cannot resume a Goal while a prompt is still running.".into());
            }
            if has_in_flight_prompt {
                if let Err(error) = handle_cancel(app, worker, None).await {
                    return Err(self.recover_worker_after_failure(app, worker, &error).await);
                }
            }
        }

        if action == "resume" {
            // The caller immediately sends a Goal-aware ACP prompt. Its
            // UpdateGoal tool call resumes the in-memory native Goal service
            // without tearing down or duplicating the session owner.
            return Ok(Some(current_goal));
        }

        let stopped_worker = {
            let mut workers = self.inner.workers.lock().unwrap();
            let is_same_worker = worker.as_ref().is_some_and(|expected| {
                workers
                    .get(&session_id)
                    .is_some_and(|actual| Arc::ptr_eq(actual, expected))
            });
            if is_same_worker {
                workers.remove(&session_id)
            } else {
                None
            }
        };
        if let Some(stopped) = stopped_worker.as_ref() {
            stop_worker_async(stopped, "goal_control").await;
        }

        if action == "cancel" {
            goal_store::append_clear(&session_id)?;
        } else if goal_store::session_goal_snapshot(&session_id)?
            .as_ref()
            .and_then(|goal| goal.get("status"))
            .and_then(Value::as_str)
            == Some("active")
        {
            goal_store::append_pause(&session_id)?;
        }

        if stopped_worker.is_some() {
            self.connect_with_lease(app, session_id.clone(), connection_id)
                .await?;
        }
        goal_store::session_goal_snapshot(&session_id)
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
                emit_worker_wire_message(
                    app,
                    &worker,
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
                emit_session_config_wire(app, &worker);
                Ok(())
            }
            Some("replay") => handle_replay(app, &worker, id).await,
            Some("prompt") => {
                let result = handle_prompt(
                    app,
                    &worker,
                    id,
                    parsed.get("params").cloned().unwrap_or(Value::Null),
                )
                .await;
                if let Err(error) = result {
                    let worker_stopped = worker.status.lock().unwrap().state == "stopped";
                    if worker_stopped {
                        return Err(self
                            .recover_worker_after_failure(app, &worker, &error)
                            .await);
                    }
                    return Err(error);
                }
                Ok(())
            }
            Some("cancel") => match handle_cancel(app, &worker, id).await {
                Ok(()) => Ok(()),
                Err(error) => Err(self
                    .recover_worker_after_failure(app, &worker, &error)
                    .await),
            },
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
            Some("set_goal_mode") => handle_set_goal_mode(
                app,
                &worker,
                id,
                parsed.get("params").cloned().unwrap_or(Value::Null),
            ),
            Some("set_config_option") => {
                handle_set_config_option(
                    app,
                    &worker,
                    id,
                    parsed.get("params").cloned().unwrap_or(Value::Null),
                )
                .await
            }
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

fn rpc_error_details(response: &JsonRpcResponse) -> Option<&str> {
    response.error.as_ref().and_then(|error| {
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
}

/// Kimi CLI returns -32603 / "Already in {mode} mode" when `session/set_mode`
/// repeats the active mode. Treat that as an idempotent no-op success.
fn is_already_in_target_mode_error(response: &JsonRpcResponse, mode_id: &str) -> bool {
    let Some(details) = rpc_error_details(response) else {
        return false;
    };
    let normalized = details.trim().to_ascii_lowercase();
    let prefix = "already in ";
    let suffix = " mode";
    if !normalized.starts_with(prefix) || !normalized.ends_with(suffix) {
        return false;
    }
    let inner = &normalized[prefix.len()..normalized.len() - suffix.len()];
    let mode = mode_id.trim().to_ascii_lowercase();
    inner == mode
        || (mode == "default" && inner == "manual")
        || (mode == "manual" && inner == "default")
}

async fn resolve_session_cwd(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let local_cwd = resolve_local_session_cwd(session_id)?;
    if let Some(path) = local_cwd.as_ref().filter(|path| path.is_dir()) {
        return Ok(path.clone());
    }

    match fetch_session_cwd_via_acp(app, session_id).await {
        Ok(cwd) => Ok(cwd),
        Err(acp_error) => local_cwd.ok_or(acp_error),
    }
}

fn resolve_local_session_cwd(session_id: &str) -> Result<Option<PathBuf>, String> {
    let Some(session_dir) = crate::session_store::find_session_dir_by_id(session_id)? else {
        return Ok(None);
    };
    crate::session_store::work_dir_from_session_dir(&session_dir)
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
        app_handle: None,
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
        wire_output: Mutex::new(WireOutputState::default()),
        status_seq: AtomicU64::new(0),
        in_flight_prompt_ids: Mutex::new(HashSet::new()),
        pending_permission_ids: Mutex::new(HashMap::new()),
        last_session_update_at: Mutex::new(None),
        plan_mode: Mutex::new(false),
        permission_mode: Mutex::new(PermissionMode::Manual),
        swarm_mode: Mutex::new(false),
        goal_mode: Mutex::new(false),
        mode_ops: tokio::sync::Mutex::new(()),
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

pub(crate) async fn ensure_acp_authenticated(rpc: &mut AcpRpcSession) -> Result<Value, String> {
    let initialize = rpc.request("initialize", acp_initialize_params()).await?;

    if initialize.error.is_some() {
        return Err(format!(
            "ACP initialize failed: {}",
            describe_rpc_error(&initialize)
        ));
    }

    let initialize_result = initialize.result.clone().unwrap_or(Value::Null);
    let method_id = pick_auth_method_id(&initialize_result);
    let authenticate = rpc
        .request("authenticate", json!({ "methodId": method_id }))
        .await?;

    if is_auth_required_response(&authenticate) || !is_authenticated_response(&authenticate) {
        let message =
            "Kimi Code rejected the configured provider credentials. Check config.toml / login state, then retry. If you use a VPN, confirm the network is reachable.";
        crate::provider_config::record_acp_auth_failure(message);
        return Err(message.to_string());
    }

    if authenticate.error.is_some() {
        let message = format!(
            "ACP authenticate failed: {}",
            describe_rpc_error(&authenticate)
        );
        crate::provider_config::record_acp_auth_failure(&message);
        return Err(message);
    }

    crate::provider_config::clear_acp_auth_failure();
    Ok(initialize_result)
}

#[derive(Clone, Copy)]
enum WireSnapshotKind {
    Plan,
    Config,
}

fn emit_worker_wire_message(app: &AppHandle, worker: &AcpWorker, message: String) {
    emit_worker_wire_message_with_kind(app, worker, message, None);
}

fn emit_worker_snapshot_wire_message(
    app: &AppHandle,
    worker: &AcpWorker,
    message: String,
    kind: WireSnapshotKind,
) {
    emit_worker_wire_message_with_kind(app, worker, message, Some(kind));
}

fn emit_worker_wire_message_with_kind(
    app: &AppHandle,
    worker: &AcpWorker,
    message: String,
    snapshot_kind: Option<WireSnapshotKind>,
) {
    let mut output = worker.wire_output.lock().unwrap();
    flush_pending_text_wire_messages_locked(app, worker, &mut output);

    if let Some(kind) = snapshot_kind {
        let last_message = match kind {
            WireSnapshotKind::Plan => &mut output.last_plan_message,
            WireSnapshotKind::Config => &mut output.last_config_message,
        };
        if last_message.as_deref() == Some(message.as_str()) {
            return;
        }
        *last_message = Some(message.clone());
    }

    emit_raw_wire_message(app, &worker.session_id, message);
}

fn queue_worker_text_wire_message(app: &AppHandle, worker: &Arc<AcpWorker>, message: String) {
    let should_start_timer;
    {
        let mut output = worker.wire_output.lock().unwrap();
        if output.text.push(message) {
            flush_pending_text_wire_messages_locked(app, worker, &mut output);
        }

        should_start_timer = !output.flush_timer_started && !output.text.is_empty();
        if should_start_timer {
            output.flush_timer_started = true;
        }
    }

    if should_start_timer {
        let app = app.clone();
        let worker = Arc::clone(worker);
        tauri::async_runtime::spawn(run_after_delay(
            tokio::time::sleep(ACP_TEXT_FLUSH_WINDOW),
            move || flush_worker_text_wire_messages(&app, &worker),
        ));
    }
}

async fn run_after_delay<D, F>(delay: D, action: F)
where
    D: Future<Output = ()> + Send + 'static,
    F: FnOnce() + Send + 'static,
{
    delay.await;
    action();
}

fn flush_worker_text_wire_messages(app: &AppHandle, worker: &AcpWorker) {
    let mut output = worker.wire_output.lock().unwrap();
    output.flush_timer_started = false;
    emit_pending_text_wire_messages(
        &mut output,
        |message| emit_raw_wire_message(app, &worker.session_id, message),
        |messages| emit_raw_wire_messages_batch(app, &worker.session_id, messages),
    );
}

fn emit_text_wire_messages<Single, Batch>(
    messages: Vec<String>,
    emit_single: Single,
    emit_batch: Batch,
) where
    Single: FnOnce(String),
    Batch: FnOnce(Vec<String>),
{
    match messages.len() {
        0 => {}
        1 => {
            let Some(message) = messages.into_iter().next() else {
                return;
            };
            emit_single(message);
        }
        _ => emit_batch(messages),
    }
}

fn emit_pending_text_wire_messages<Single, Batch>(
    output: &mut WireOutputState,
    emit_single: Single,
    emit_batch: Batch,
) where
    Single: FnOnce(String),
    Batch: FnOnce(Vec<String>),
{
    emit_text_wire_messages(output.text.take(), emit_single, emit_batch);
}

fn flush_pending_text_wire_messages_locked(
    app: &AppHandle,
    worker: &AcpWorker,
    output: &mut WireOutputState,
) {
    emit_pending_text_wire_messages(
        output,
        |message| emit_raw_wire_message(app, &worker.session_id, message),
        |messages| emit_raw_wire_messages_batch(app, &worker.session_id, messages),
    );
}

fn reset_worker_wire_snapshots(worker: &AcpWorker) {
    let mut output = worker.wire_output.lock().unwrap();
    output.last_plan_message = None;
    output.last_config_message = None;
}

fn clear_worker_wire_output(worker: &AcpWorker) {
    let mut output = worker.wire_output.lock().unwrap();
    output.text.clear();
    output.flush_timer_started = false;
    output.last_plan_message = None;
    output.last_config_message = None;
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

fn set_worker_idle_if_active(
    app: &AppHandle,
    worker: &AcpWorker,
    reason: &str,
) -> Result<(), String> {
    active_worker_rpc(worker)?;
    let seq = record_worker_idle_if_active(worker, reason)?;
    emit_session_status_wire(app, worker, "idle", seq, Some(reason), None);
    Ok(())
}

fn record_worker_idle_if_active(worker: &AcpWorker, reason: &str) -> Result<u64, String> {
    let mut status = worker.status.lock().unwrap();
    if !matches!(status.state.as_str(), "ready" | "running" | "busy" | "idle") {
        return Err(format!(
            "ACP worker cannot become idle because it is `{}`.",
            status.state
        ));
    }
    let seq = worker.status_seq.fetch_add(1, Ordering::SeqCst) + 1;
    status.state = "idle".to_string();
    status.seq = seq;
    status.reason = Some(reason.to_string());
    status.detail = None;
    status.updated_at = now_ms();
    Ok(seq)
}

fn emit_session_status_wire(
    app: &AppHandle,
    worker: &AcpWorker,
    state: &str,
    seq: u64,
    reason: Option<&str>,
    detail: Option<&str>,
) {
    emit_worker_wire_message(
        app,
        worker,
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

fn resolve_initial_runtime_modes(session_id: &str) -> (bool, PermissionMode, bool, bool) {
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
    let goal_mode = session_store::session_goal_mode(session_id).unwrap_or_else(|err| {
        eprintln!("[acp] failed to read persisted goal mode for {session_id}: {err}");
        false
    });

    (
        persisted.plan_mode.unwrap_or(defaults.plan_mode),
        permission_mode,
        swarm_mode,
        goal_mode,
    )
}

fn mode_status_payload(worker: &AcpWorker) -> Value {
    let plan_mode = *worker.plan_mode.lock().unwrap();
    let permission_mode = *worker.permission_mode.lock().unwrap();
    let swarm_mode = *worker.swarm_mode.lock().unwrap();
    let goal_mode = *worker.goal_mode.lock().unwrap();
    mode_status_payload_for(plan_mode, permission_mode, swarm_mode, goal_mode)
}

fn mode_status_payload_for(
    plan_mode: bool,
    permission_mode: PermissionMode,
    swarm_mode: bool,
    goal_mode: bool,
) -> Value {
    json!({
        "context_usage": null,
        "token_usage": null,
        "plan_mode": plan_mode,
        "permission_mode": permission_mode.as_wire(),
        "swarm_mode": swarm_mode,
        "goal_mode": goal_mode,
    })
}

fn emit_mode_status_wire(app: &AppHandle, worker: &AcpWorker) {
    emit_worker_wire_message(
        app,
        worker,
        wire_event_message("StatusUpdate", mode_status_payload(worker)),
    );
}

fn emit_session_config_wire(app: &AppHandle, worker: &AcpWorker) {
    let Some(state) = crate::acp_capabilities::resolve_session_config(&worker.session_id) else {
        return;
    };
    if state.status != crate::acp_capabilities::SessionConfigStatus::Known
        || state.options.is_empty()
    {
        return;
    }
    emit_worker_snapshot_wire_message(
        app,
        worker,
        translate_session_config_snapshot(&worker.session_id, &state),
        WireSnapshotKind::Config,
    );
}

fn emit_config_option_error(app: &AppHandle, worker: &AcpWorker, id: Option<Value>, message: &str) {
    let Some(id) = id else {
        return;
    };
    emit_worker_wire_message(
        app,
        worker,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32000,
                "message": message,
            }
        })
        .to_string(),
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

    emit_worker_wire_message(
        app,
        worker,
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
                            n.as_f64().map(|v| {
                                if v.is_finite() && v > 0.0 {
                                    v as u64
                                } else {
                                    0
                                }
                            })
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
    emit_worker_wire_message(
        app,
        worker,
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
    let _mode_guard = worker.mode_ops.lock().await;

    // Idempotent: skip ACP when the worker already mirrors the desired plan bit.
    if *worker.plan_mode.lock().unwrap() == enabled {
        emit_mode_response(app, worker, id);
        emit_mode_status_wire(app, worker);
        return Ok(());
    }

    let permission_mode = *worker.permission_mode.lock().unwrap();
    let mode_id = acp_mode_id_for_plan(enabled, permission_mode);

    let response = {
        let rpc = active_worker_rpc(worker)?;
        rpc.request(
            "session/set_mode",
            json!({
                "sessionId": worker.session_id,
                "modeId": mode_id,
            }),
        )
        .await?
    };

    if response.error.is_some() {
        // CLI already in the target mode — treat as success and sync local state.
        if !is_already_in_target_mode_error(&response, mode_id) {
            return Err(format!(
                "ACP session/set_mode failed: {}",
                describe_rpc_error(&response)
            ));
        }
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
    // Permission mode hot-switches mid-turn (issue #13): session/set_mode only
    // affects subsequent permission requests, so an in-flight prompt is fine.
    // Plan/swarm/goal handlers keep the idle gate.
    let _mode_guard = worker.mode_ops.lock().await;

    let previous_mode = *worker.permission_mode.lock().unwrap();
    if previous_mode == next_mode {
        emit_mode_response(app, worker, id);
        emit_mode_status_wire(app, worker);
        return Ok(());
    }

    // Commit desired permission before ACP RPCs so concurrent readers see the
    // intended mode even while set_mode is in flight.
    *worker.permission_mode.lock().unwrap() = next_mode;
    let plan_mode = *worker.plan_mode.lock().unwrap();
    let permission_mode_id = next_mode.acp_mode_id();
    {
        let rpc = active_worker_rpc(worker)?;
        let permission_response = match rpc
            .request(
                "session/set_mode",
                json!({
                    "sessionId": worker.session_id,
                    "modeId": permission_mode_id,
                }),
            )
            .await
        {
            Ok(response) => response,
            Err(err) => {
                *worker.permission_mode.lock().unwrap() = previous_mode;
                return Err(err);
            }
        };
        if permission_response.error.is_some()
            && !is_already_in_target_mode_error(&permission_response, permission_mode_id)
        {
            *worker.permission_mode.lock().unwrap() = previous_mode;
            return Err(format!(
                "ACP session/set_mode failed: {}",
                describe_rpc_error(&permission_response)
            ));
        }

        if plan_mode {
            let plan_response = match rpc
                .request(
                    "session/set_mode",
                    json!({
                        "sessionId": worker.session_id,
                        "modeId": "plan",
                    }),
                )
                .await
            {
                Ok(response) => response,
                Err(err) => {
                    *worker.permission_mode.lock().unwrap() = previous_mode;
                    return Err(err);
                }
            };
            if plan_response.error.is_some()
                && !is_already_in_target_mode_error(&plan_response, "plan")
            {
                *worker.permission_mode.lock().unwrap() = previous_mode;
                return Err(format!(
                    "ACP session/set_mode failed while restoring Plan: {}",
                    describe_rpc_error(&plan_response)
                ));
            }
        }
    }

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

fn handle_set_goal_mode(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let enabled = mode_enabled_from_params(&params)?;
    ensure_mode_change_idle(worker)?;

    // Kimi ACP has no native goal mode option. Keep the compatibility behavior
    // in the worker, but persist the user's choice in the Kimi session state so
    // it follows this conversation across desktop restarts.
    session_store::update_session_goal_mode(&worker.session_id, enabled)?;
    *worker.goal_mode.lock().unwrap() = enabled;
    emit_mode_response(app, worker, id);
    emit_mode_status_wire(app, worker);
    Ok(())
}

async fn handle_set_config_option(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let config_id = match params
        .get("configId")
        .or_else(|| params.get("config_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(config_id) => config_id.to_string(),
        None => {
            emit_config_option_error(app, worker, id, "Missing configId");
            return Ok(());
        }
    };
    let value = match params.get("value").cloned() {
        Some(value) => value,
        None => {
            emit_config_option_error(app, worker, id, "Missing value");
            return Ok(());
        }
    };

    if let Err(message) = crate::acp_capabilities::validate_config_option_value(
        &worker.session_id,
        &config_id,
        &value,
    ) {
        emit_config_option_error(app, worker, id, &message);
        return Ok(());
    }
    if let Err(message) = ensure_mode_change_idle(worker) {
        emit_config_option_error(app, worker, id, &message);
        return Ok(());
    }

    let response = match active_worker_rpc(worker) {
        Ok(rpc) => match rpc
            .request(
                "session/set_config_option",
                json!({
                    "sessionId": worker.session_id,
                    "configId": config_id,
                    "value": value,
                }),
            )
            .await
        {
            Ok(response) => response,
            Err(err) => {
                emit_config_option_error(app, worker, id, &err);
                return Ok(());
            }
        },
        Err(message) => {
            emit_config_option_error(app, worker, id, &message);
            return Ok(());
        }
    };

    if response.error.is_some() {
        emit_config_option_error(
            app,
            worker,
            id,
            &format!(
                "ACP session/set_config_option failed: {}",
                describe_rpc_error(&response)
            ),
        );
        return Ok(());
    }

    if let Some(id) = id {
        emit_worker_wire_message(
            app,
            worker,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "status": "ok" },
            })
            .to_string(),
        );
    }
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
    reset_worker_wire_snapshots(worker);
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

    if let Some(result) = response.result.as_ref() {
        crate::acp_capabilities::set_session_config_from_response(&worker.session_id, result);
    }

    wait_for_session_update_quiescence(worker, Duration::from_millis(150), Duration::from_secs(5))
        .await;

    emit_worker_wire_message(
        app,
        worker,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "status": "finished", "events": 0, "requests": 0 }
        })
        .to_string(),
    );
    set_worker_status(app, worker, "idle", Some("replay_complete"), None);
    emit_usage_status_wire(app, worker, None);
    emit_session_config_wire(app, worker);
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GoalPromptExpectation {
    Start,
    Resume,
    Continue,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct GoalBridgeOutcome {
    history_resync: bool,
    completed: bool,
}

fn goal_prompt_expectation(
    params: &Value,
    goal_mode: bool,
    initial_snapshot: &Option<Value>,
) -> Option<GoalPromptExpectation> {
    match params.get("goal_action").and_then(Value::as_str) {
        Some("create" | "replace") => Some(GoalPromptExpectation::Start),
        Some("resume") => Some(GoalPromptExpectation::Resume),

        _ if goal_status(initial_snapshot) == Some("active") => {
            Some(GoalPromptExpectation::Continue)
        }
        _ if goal_mode => Some(GoalPromptExpectation::Start),
        _ => None,
    }
}

fn goal_id(snapshot: &Option<Value>) -> Option<&str> {
    snapshot
        .as_ref()
        .and_then(|goal| goal.get("goal_id"))
        .and_then(Value::as_str)
}

fn goal_handoff_goal_id(
    expectation: GoalPromptExpectation,
    initial_snapshot: &Option<Value>,
    poll: &goal_store::GoalJournalPoll,
    baseline_record: u64,
) -> Option<String> {
    match expectation {
        GoalPromptExpectation::Start => poll
            .last_goal_create_record
            .filter(|record| *record > baseline_record)
            .and(poll.last_goal_create_id.clone()),
        GoalPromptExpectation::Resume => {
            let initial_goal_id = goal_id(initial_snapshot)?;
            let active_goal_id = poll.last_goal_active_id.as_deref()?;
            (poll.last_goal_active_record? > baseline_record && active_goal_id == initial_goal_id)
                .then(|| initial_goal_id.to_string())
        }
        GoalPromptExpectation::Continue => (goal_status(initial_snapshot) == Some("active"))
            .then(|| goal_id(initial_snapshot).map(str::to_string))
            .flatten(),
    }
}

fn goal_terminal_matches_current(
    poll: &goal_store::GoalJournalPoll,
    baseline_record: u64,
    monitored_goal_id: &str,
    snapshot: &Option<Value>,
) -> Result<Option<bool>, String> {
    let expected_terminal_status = if let Some(goal) = snapshot.as_ref() {
        let current_goal_id = goal
            .get("goal_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Native Goal snapshot is missing its goal id.".to_string())?;
        if current_goal_id != monitored_goal_id {
            return Err(format!(
                "Native Goal `{monitored_goal_id}` was replaced by `{current_goal_id}` while it was running."
            ));
        }
        match goal.get("status").and_then(Value::as_str) {
            Some("active") => return Ok(None),
            Some(status @ ("paused" | "blocked" | "complete")) => status,
            Some(status) => {
                return Err(format!(
                    "Native Goal `{monitored_goal_id}` entered unsupported status `{status}`."
                ))
            }
            None => return Err("Native Goal snapshot is missing its status.".to_string()),
        }
    } else {
        "clear"
    };

    let terminal_record = poll
        .last_goal_terminal_record
        .filter(|record| *record > baseline_record)
        .ok_or_else(|| {
            format!(
                "Native Goal `{monitored_goal_id}` stopped without a new canonical terminal record."
            )
        })?;
    if poll.last_goal_terminal_goal_id.as_deref() != Some(monitored_goal_id)
        || poll.last_goal_terminal_status.as_deref() != Some(expected_terminal_status)
    {
        return Err(format!(
            "Native Goal `{monitored_goal_id}` terminal record does not match the current Goal snapshot."
        ));
    }

    debug_assert!(terminal_record > baseline_record);
    Ok(Some(poll.last_goal_terminal_requires_closed_step))
}

fn goal_terminal_is_settled(
    poll: &goal_store::GoalJournalPoll,
    baseline_record: u64,
    monitored_goal_id: &str,
    snapshot: &Option<Value>,
) -> Result<bool, String> {
    let Some(requires_closed_step) =
        goal_terminal_matches_current(poll, baseline_record, monitored_goal_id, snapshot)?
    else {
        return Ok(false);
    };
    if !requires_closed_step {
        return Ok(true);
    }
    let Some(terminal_record) = poll
        .last_goal_terminal_record
        .filter(|record| *record > baseline_record)
    else {
        return Ok(false);
    };
    let Some(step_end_record) = poll
        .last_step_end_record
        .filter(|record| *record > terminal_record)
    else {
        return Ok(false);
    };
    if let Some(step_begin_record) = poll
        .last_step_begin_record
        .filter(|record| *record > baseline_record)
    {
        return Ok(step_end_record >= step_begin_record);
    }
    Ok(true)
}

fn goal_terminal_was_completed(poll: &goal_store::GoalJournalPoll) -> bool {
    poll.last_goal_terminal_status.as_deref() == Some("complete")
        || (poll.last_goal_terminal_status.as_deref() == Some("clear")
            && poll.last_goal_terminal_requires_closed_step)
}

fn goal_cancel_ack_observed(
    poll: &goal_store::GoalJournalPoll,
    baseline_record: u64,
    monitored_goal_id: &str,
    snapshot: &Option<Value>,
) -> Result<bool, String> {
    let expected_status = match snapshot.as_ref() {
        Some(goal) => {
            let current_goal_id = goal
                .get("goal_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Native Goal snapshot is missing its goal id.".to_string())?;
            if current_goal_id != monitored_goal_id {
                return Err(format!(
                    "Native Goal `{monitored_goal_id}` was replaced by `{current_goal_id}` while cancellation was pending."
                ));
            }
            match goal.get("status").and_then(Value::as_str) {
                Some(status @ ("paused" | "blocked")) => status,
                _ => return Ok(false),
            }
        }
        None => "clear",
    };

    Ok(poll
        .last_goal_terminal_record
        .is_some_and(|record| record > baseline_record)
        && poll.last_goal_terminal_goal_id.as_deref() == Some(monitored_goal_id)
        && poll.last_goal_terminal_status.as_deref() == Some(expected_status))
}

fn emit_goal_refresh(app: &AppHandle, worker: &AcpWorker) {
    emit_worker_wire_message(
        app,
        worker,
        wire_event_message(
            "StatusUpdate",
            json!({
                "context_usage": null,
                "goal_refresh": true,
            }),
        ),
    );
}

fn goal_status(snapshot: &Option<Value>) -> Option<&str> {
    snapshot
        .as_ref()
        .and_then(|goal| goal.get("status"))
        .and_then(Value::as_str)
}

/// ACP 0.30 resolves `session/prompt` after the first main-agent turn while
/// Kimi's native Goal driver may still own continuation turns. Keep the
/// desktop prompt pending until the canonical Goal journal reaches a settled
/// state, then ask the frontend to atomically replay the persisted history.
/// Kimi remains the only Goal loop owner; this bridge never synthesizes turns.
struct GoalBridgeRequest {
    cursor: goal_store::GoalJournalCursor,
    baseline_record: u64,
    expectation: GoalPromptExpectation,
    initial_snapshot: Option<Value>,
    upcoming_goal_id: Option<String>,
    prompt_started_at: Instant,
}

async fn bridge_native_goal_continuation(
    app: &AppHandle,
    worker: &Arc<AcpWorker>,
    request: GoalBridgeRequest,
) -> Result<GoalBridgeOutcome, String> {
    let GoalBridgeRequest {
        mut cursor,
        baseline_record,
        expectation,
        initial_snapshot,
        upcoming_goal_id,
        prompt_started_at,
    } = request;
    let mut poll = cursor.poll()?;
    if poll.truncated || poll.replaced {
        return Err("Native Goal journal changed while the prompt was running.".to_string());
    }
    if poll.saw_goal_record {
        emit_goal_refresh(app, worker);
    }

    let handoff_started_at = Instant::now();
    let monitored_goal_id = loop {
        if let Some(goal_id) =
            goal_handoff_goal_id(expectation, &initial_snapshot, &poll, baseline_record)
        {
            break goal_id;
        }
        if handoff_started_at.elapsed() >= GOAL_BRIDGE_HANDOFF_GRACE {
            let detail = match expectation {
                GoalPromptExpectation::Start => "Kimi did not create the requested native Goal.",
                GoalPromptExpectation::Resume => {
                    "Kimi did not reactivate the same paused native Goal."
                }
                GoalPromptExpectation::Continue => "Kimi did not continue the active native Goal.",
            };
            return Err(detail.to_string());
        }

        tokio::time::sleep(GOAL_BRIDGE_POLL_INTERVAL).await;
        let next = cursor.poll()?;
        if next.truncated || next.replaced {
            return Err("Native Goal journal changed while the prompt was running.".to_string());
        }
        if next.saw_goal_record {
            emit_goal_refresh(app, worker);
        }
        poll = next;
    };

    if expectation == GoalPromptExpectation::Start {
        if let Some(queue_id) = upcoming_goal_id.as_deref() {
            if let Err(error) = goal_queue::consume_started(&worker.session_id, queue_id) {
                eprintln!(
                    "[acp] native Goal was created but upcoming Goal `{queue_id}` could not be consumed: {error}"
                );
            }
        }
    }

    set_worker_status(app, worker, "busy", Some("goal"), None);
    emit_goal_refresh(app, worker);
    let mut last_journal_activity = Instant::now();

    loop {
        // Always poll before testing the quiet window. Otherwise a record that
        // landed just before the timer check could make an old terminal state
        // look settled.
        tokio::time::sleep(GOAL_BRIDGE_POLL_INTERVAL).await;
        let next = cursor.poll()?;
        if next.truncated || next.replaced {
            return Err("Native Goal journal changed while the prompt was running.".to_string());
        }
        if next.advanced {
            last_journal_activity = Instant::now();
        }
        if next.saw_goal_record {
            emit_goal_refresh(app, worker);
        }
        poll = next;

        let snapshot = cursor.snapshot();
        if !poll.has_pending_line
            && goal_terminal_is_settled(&poll, baseline_record, &monitored_goal_id, &snapshot)?
            && last_journal_activity.elapsed() >= GOAL_TERMINAL_QUIET_PERIOD
        {
            // Final incremental barrier: only return if a zero-advance poll
            // still describes the same Goal and terminal record.
            let barrier = cursor.poll()?;
            if barrier.truncated || barrier.replaced {
                return Err("Native Goal journal changed while the prompt was running.".to_string());
            }
            if barrier.saw_goal_record {
                emit_goal_refresh(app, worker);
            }
            if barrier.advanced {
                last_journal_activity = Instant::now();
                continue;
            }
            poll = barrier;
            let barrier_snapshot = cursor.snapshot();
            if !poll.has_pending_line
                && goal_terminal_is_settled(
                    &poll,
                    baseline_record,
                    &monitored_goal_id,
                    &barrier_snapshot,
                )?
                && last_journal_activity.elapsed() >= GOAL_TERMINAL_QUIET_PERIOD
            {
                emit_goal_refresh(app, worker);
                let completed = goal_terminal_was_completed(&poll);
                return Ok(GoalBridgeOutcome {
                    history_resync: true,
                    completed,
                });
            }
        }

        if prompt_started_at.elapsed() >= acp_prompt_timeout() {
            if let Ok(rpc) = active_worker_rpc(worker) {
                let _ = rpc.notify("session/cancel", json!({ "sessionId": worker.session_id }));
            }
            let cancel_deadline = Instant::now() + GOAL_CANCEL_ACK_TIMEOUT;
            while Instant::now() < cancel_deadline {
                tokio::time::sleep(GOAL_BRIDGE_POLL_INTERVAL).await;
                let next = cursor.poll()?;
                if next.truncated || next.replaced {
                    return Err(
                        "Native Goal journal changed while cancellation was pending.".to_string(),
                    );
                }
                if next.saw_goal_record {
                    emit_goal_refresh(app, worker);
                }
                let snapshot = cursor.snapshot();
                if goal_cancel_ack_observed(&next, baseline_record, &monitored_goal_id, &snapshot)?
                {
                    return Err("Native Goal continuation timed out and was paused.".to_string());
                }
            }
            stop_worker_async(worker, "goal_timeout").await;
            return Err(
                "Native Goal continuation timed out; the unresponsive ACP worker was stopped."
                    .to_string(),
            );
        }

        if active_worker_rpc(worker).is_err() {
            return Err("ACP worker stopped during native Goal continuation.".to_string());
        }
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
    let expand_result = session_files::expand_prompt_with_uploads(&worker.session_id, &params);
    let expanded_params = match expand_result {
        Ok(expanded) => expanded,
        Err(err) => {
            fail_prompt_in_flight(app, worker, &prompt_id, "prompt_prepare_error", &err);
            return Err(err);
        }
    };
    let swarm_mode = *worker.swarm_mode.lock().unwrap();
    let goal_mode = *worker.goal_mode.lock().unwrap();
    let goal_requested = goal_mode
        || expanded_params
            .get("goal_action")
            .and_then(Value::as_str)
            .is_some_and(|action| matches!(action, "create" | "replace" | "resume"));
    let upcoming_goal_id = expanded_params
        .get("upcoming_goal_id")
        .and_then(Value::as_str)
        .filter(|goal_id| !goal_id.trim().is_empty())
        .map(str::to_string);
    let goal_bridge = if goal_requested {
        let cursor = match goal_store::GoalJournalCursor::open(&worker.session_id) {
            Ok(cursor) => cursor,
            Err(err) => {
                fail_prompt_in_flight(app, worker, &prompt_id, "goal_journal_error", &err);
                return Err(err);
            }
        };
        let initial_snapshot = cursor.snapshot();
        let expectation =
            goal_prompt_expectation(&expanded_params, goal_mode, &initial_snapshot)
                .ok_or_else(|| "Missing native Goal action for Goal prompt.".to_string())?;
        let baseline_record = cursor.record_index();
        Some(GoalBridgeRequest {
            cursor,
            baseline_record,
            expectation,
            initial_snapshot,
            upcoming_goal_id,
            prompt_started_at,
        })
    } else {
        None
    };
    // Prefer slash-only prompt so ACP `detectLeadingSlashIntent` sees `/compact`
    // as blocks[0]. Upload expansion otherwise prepends `<uploaded_files>` and
    // the CLI treats the slash as ordinary model text.
    let prompt = if let Some(slash) = acp_slash_command_prompt(&expanded_params) {
        slash
    } else {
        legacy_user_input_to_acp_prompt_with_swarm(&expanded_params, swarm_mode, goal_mode)
    };
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

    let goal_bridge_outcome = if let Some(request) = goal_bridge {
        match bridge_native_goal_continuation(app, worker, request).await {
            Ok(outcome) => outcome,
            Err(detail) => {
                fail_prompt_in_flight(app, worker, &prompt_id, "goal_continuation_error", &detail);
                return Err(detail);
            }
        }
    } else {
        GoalBridgeOutcome::default()
    };

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
    emit_worker_wire_message(
        app,
        worker,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "status": status,
                "goal_history_resync": goal_bridge_outcome.history_resync,
                "goal_completed": goal_bridge_outcome.completed,
            }
        })
        .to_string(),
    );
    // A concurrent cancel/control path may have stopped this exact worker
    // after the in-flight id was removed. Never overwrite that terminal state
    // with a late idle transition from prompt completion.
    let _ = set_worker_idle_if_active(app, worker, status);
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
    let worker_stopped = worker.status.lock().unwrap().state == "stopped";
    if !worker_stopped {
        set_worker_status(app, worker, "error", Some(reason), Some(detail));
    }
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

        let deadline = Instant::now() + GOAL_CANCEL_ACK_TIMEOUT;
        loop {
            if worker.in_flight_prompt_ids.lock().unwrap().is_empty() {
                break;
            }
            if Instant::now() >= deadline {
                stop_worker_async(worker, "cancel_timeout").await;
                return Err(
                    "ACP did not acknowledge cancellation; the unresponsive worker was stopped."
                        .to_string(),
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    set_worker_idle_if_active(app, worker, "cancelled")?;
    if id.is_some() {
        emit_worker_wire_message(
            app,
            worker,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "status": "cancelled" }
            })
            .to_string(),
        );
    }
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
    let acp_permission = worker
        .pending_permission_ids
        .lock()
        .unwrap()
        .remove(&wire_id);
    let Some(acp_permission) = acp_permission else {
        // Question answers share this result path; missing mapping used to no-op and hang the turn.
        if result.and_then(|v| v.get("answers")).is_some() {
            return Err(format!(
                "No pending ACP request for question response id `{wire_id}`"
            ));
        }
        return Ok(());
    };
    let outcome = legacy_approval_result_to_acp_outcome_with_options(
        result.unwrap_or(&Value::Null),
        &acp_permission.options,
    );
    let rpc = active_worker_rpc(worker)?;
    rpc.respond(acp_permission.acp_request_id, outcome)?;
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
    let app = worker.app_handle.clone();
    let session_id = worker.session_id.clone();
    mark_worker_stopped_with_emitter(worker, reason, move |messages| {
        if let Some(app) = app.as_ref() {
            emit_raw_wire_messages_batch(app, &session_id, messages);
        }
    });
}

fn mark_worker_stopped_with_emitter<F>(worker: &AcpWorker, reason: &str, emit: F)
where
    F: FnOnce(Vec<String>),
{
    worker.in_flight_prompt_ids.lock().unwrap().clear();
    worker.pending_permission_ids.lock().unwrap().clear();
    {
        let mut output = worker.wire_output.lock().unwrap();
        output.flush_timer_started = false;
        let pending_messages = output.text.take();
        if !pending_messages.is_empty() {
            // Keep the output lock through the drain so another wire event
            // cannot overtake the stop flush.
            emit(pending_messages);
        }
    }
    // Stopping must flush text first, but snapshot messages are still only
    // caches and must be discarded with the worker.
    clear_worker_wire_output(worker);
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
                emit_worker_wire_message(app, worker, wire_message);
            } else {
                let update_kind = update.get("sessionUpdate").and_then(Value::as_str);
                let is_text_chunk = matches!(
                    update_kind,
                    Some("agent_message_chunk" | "agent_thought_chunk" | "thought_message_chunk")
                );
                let snapshot_kind = match update_kind {
                    Some("plan") => Some(WireSnapshotKind::Plan),
                    Some("config_option_update") => Some(WireSnapshotKind::Config),
                    _ => None,
                };
                for wire_message in translate_session_update(&worker.session_id, &update) {
                    if is_text_chunk {
                        queue_worker_text_wire_message(app, worker, wire_message);
                    } else if let Some(kind) = snapshot_kind {
                        emit_worker_snapshot_wire_message(app, worker, wire_message, kind);
                    } else {
                        emit_worker_wire_message(app, worker, wire_message);
                    }
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
                    emit_worker_wire_message(app, worker, wire_message);
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
            if let Some((wire_message, wire_id, options)) =
                acp_permission_to_legacy_request(request_id, params)
            {
                worker.pending_permission_ids.lock().unwrap().insert(
                    wire_id,
                    PendingPermission {
                        acp_request_id: request_id,
                        options,
                    },
                );
                emit_worker_wire_message(app, worker, wire_message);
            } else {
                eprintln!(
                    "[WARN] Unknown ACP permission request (id={request_id}); defaulting to reject"
                );
                write_acp_response(
                    stdin,
                    request_id,
                    json!({
                        "outcome": { "outcome": "selected", "optionId": "reject" }
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
    fn text_aggregator_preserves_order_under_high_frequency_pushes() {
        let mut buffer = TextWireAggregator::default();
        let expected: Vec<String> = (0..20_000).map(|index| format!("chunk-{index}")).collect();
        let mut emitted = Vec::new();

        for message in expected.iter().cloned() {
            if buffer.push(message) {
                emitted.extend(buffer.take());
            }
        }
        emitted.extend(buffer.take());

        assert_eq!(emitted, expected);
        assert!(buffer.is_empty());
    }

    #[test]
    fn text_aggregator_flushes_immediately_at_byte_threshold() {
        let mut buffer = TextWireAggregator::new(ACP_TEXT_FLUSH_MAX_BYTES);
        let first = "a".repeat(ACP_TEXT_FLUSH_MAX_BYTES - 1);

        assert!(!buffer.push(first.clone()));
        assert!(buffer.push("b".to_string()));
        assert_eq!(buffer.take(), vec![first, "b".to_string()]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn text_flush_emits_one_batch_for_multiple_pending_messages() {
        let mut output = WireOutputState::default();
        for message in ["first", "second", "third"] {
            assert!(!output.text.push(message.to_string()));
        }
        let mut singles = Vec::new();
        let mut batches = Vec::new();

        emit_pending_text_wire_messages(
            &mut output,
            |message| singles.push(message),
            |messages| batches.push(messages),
        );

        assert!(singles.is_empty());
        assert_eq!(
            batches,
            vec![vec![
                "first".to_string(),
                "second".to_string(),
                "third".to_string()
            ]]
        );
        assert!(output.text.is_empty());
    }

    #[test]
    fn text_flush_emits_single_pending_message_as_single_event() {
        let mut output = WireOutputState::default();
        assert!(!output.text.push("single".to_string()));
        let mut singles = Vec::new();
        let mut batches = Vec::new();

        emit_pending_text_wire_messages(
            &mut output,
            |message| singles.push(message),
            |messages| batches.push(messages),
        );

        assert_eq!(singles, vec!["single"]);
        assert!(batches.is_empty());
        assert!(output.text.is_empty());
    }

    #[tokio::test]
    async fn text_aggregator_flushes_after_injected_flush_window() {
        assert_eq!(ACP_TEXT_FLUSH_WINDOW, Duration::from_millis(30));

        let buffer = Arc::new(Mutex::new(TextWireAggregator::default()));
        assert!(!buffer.lock().unwrap().push("delayed".to_string()));
        let emitted = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let buffer_for_flush = Arc::clone(&buffer);
        let emitted_for_flush = Arc::clone(&emitted);

        let task = tokio::spawn(run_after_delay(
            async move {
                let _ = release_rx.await;
            },
            move || {
                let messages = buffer_for_flush.lock().unwrap().take();
                if !messages.is_empty() {
                    emitted_for_flush.lock().unwrap().push(messages);
                }
            },
        ));
        tokio::task::yield_now().await;
        assert!(emitted.lock().unwrap().is_empty());
        assert!(!task.is_finished());

        release_tx.send(()).expect("release flush timer");
        task.await.expect("flush timer task");
        let emitted = emitted.lock().unwrap().clone();
        assert_eq!(emitted, vec![vec!["delayed".to_string()]]);
        assert!(buffer.lock().unwrap().is_empty());
    }

    #[test]
    fn terminal_wire_paths_flush_pending_text_without_loss() {
        for (path, pending) in [
            ("prompt_complete", "prompt-pending"),
            ("cancel", "cancel-pending"),
        ] {
            let mut output = WireOutputState::default();
            assert!(!output.text.push(pending.to_string()));
            let mut singles = Vec::new();
            let mut batches = Vec::new();
            emit_pending_text_wire_messages(
                &mut output,
                |message| singles.push(message),
                |messages| batches.push(messages),
            );

            assert_eq!(singles, vec![pending.to_string()], "{path} path");
            assert!(batches.is_empty(), "{path} unexpectedly batched");
            assert!(output.text.is_empty(), "{path} pending text");
        }

        let worker = new_probe_worker();
        {
            let mut output = worker.wire_output.lock().unwrap();
            assert!(!output.text.push("worker-stop-first".to_string()));
            assert!(!output.text.push("worker-stop-second".to_string()));
            output.flush_timer_started = true;
            output.last_plan_message = Some("cached plan".to_string());
            output.last_config_message = Some("cached config".to_string());
        }
        let mut emitted_batches = Vec::new();
        mark_worker_stopped_with_emitter(&worker, "worker_stop", |messages| {
            emitted_batches.push(messages)
        });

        assert_eq!(
            emitted_batches,
            vec![vec![
                "worker-stop-first".to_string(),
                "worker-stop-second".to_string()
            ]]
        );
        let output = worker.wire_output.lock().unwrap();
        assert!(output.text.is_empty());
        assert!(!output.flush_timer_started);
        assert!(output.last_plan_message.is_none());
        assert!(output.last_config_message.is_none());
        drop(output);
        assert_eq!(worker.status.lock().unwrap().state, "stopped");
    }

    #[test]
    fn goal_prompt_expectation_uses_explicit_native_actions() {
        let no_goal = None;
        assert_eq!(
            goal_prompt_expectation(&json!({ "goal_action": "create" }), false, &no_goal),
            Some(GoalPromptExpectation::Start)
        );
        assert_eq!(
            goal_prompt_expectation(&json!({ "goal_action": "resume" }), false, &no_goal),
            Some(GoalPromptExpectation::Resume)
        );
        assert_eq!(
            goal_prompt_expectation(&json!({}), true, &no_goal),
            Some(GoalPromptExpectation::Start)
        );
        let active_goal = Some(json!({ "goal_id": "g", "status": "active" }));
        assert_eq!(
            goal_prompt_expectation(&json!({}), true, &active_goal),
            Some(GoalPromptExpectation::Continue)
        );
    }

    #[test]
    fn goal_handoff_requires_the_expected_goal_and_record_kind() {
        let initial = Some(json!({ "goal_id": "g", "status": "paused" }));
        let mut poll = goal_store::GoalJournalPoll {
            last_goal_active_record: Some(11),
            last_goal_active_id: Some("g".to_string()),
            ..goal_store::GoalJournalPoll::default()
        };
        assert_eq!(
            goal_handoff_goal_id(GoalPromptExpectation::Resume, &initial, &poll, 10),
            Some("g".to_string())
        );

        poll.last_goal_active_id = Some("replacement".to_string());
        assert_eq!(
            goal_handoff_goal_id(GoalPromptExpectation::Resume, &initial, &poll, 10),
            None
        );
        poll.last_goal_active_id = Some("g".to_string());
        poll.last_goal_active_record = Some(10);
        assert_eq!(
            goal_handoff_goal_id(GoalPromptExpectation::Resume, &initial, &poll, 10),
            None
        );

        let initially_active = Some(json!({ "goal_id": "g", "status": "active" }));
        let no_new_record = goal_store::GoalJournalPoll::default();
        assert_eq!(
            goal_handoff_goal_id(
                GoalPromptExpectation::Resume,
                &initially_active,
                &no_new_record,
                10,
            ),
            None,
            "an already-active snapshot is not a resume acknowledgement"
        );
    }

    #[test]
    fn goal_terminal_waits_for_the_last_step_after_clear() {
        let mut poll = goal_store::GoalJournalPoll {
            last_goal_terminal_record: Some(10),
            last_goal_terminal_status: Some("clear".to_string()),
            last_goal_terminal_goal_id: Some("g".to_string()),
            last_goal_terminal_requires_closed_step: true,
            last_step_begin_record: Some(11),
            last_step_end_record: Some(9),
            ..goal_store::GoalJournalPoll::default()
        };
        assert!(!goal_terminal_is_settled(&poll, 5, "g", &None).unwrap());

        // A step may end after goal.clear and the native driver can
        // immediately open one final summary step. That newer begin keeps the
        // bridge pending until its matching end arrives.
        poll.last_step_end_record = Some(12);
        poll.last_step_begin_record = Some(13);
        assert!(!goal_terminal_is_settled(&poll, 5, "g", &None).unwrap());

        poll.last_step_end_record = Some(14);
        assert!(goal_terminal_is_settled(&poll, 5, "g", &None).unwrap());
        assert!(goal_terminal_is_settled(&poll, 10, "g", &None).is_err());
    }

    #[test]
    fn only_natural_completion_marks_the_bridge_completed() {
        let mut poll = goal_store::GoalJournalPoll {
            last_goal_terminal_status: Some("complete".to_string()),
            ..goal_store::GoalJournalPoll::default()
        };
        assert!(goal_terminal_was_completed(&poll));

        poll.last_goal_terminal_status = Some("clear".to_string());
        poll.last_goal_terminal_requires_closed_step = true;
        assert!(goal_terminal_was_completed(&poll));

        poll.last_goal_terminal_requires_closed_step = false;
        assert!(!goal_terminal_was_completed(&poll));
        poll.last_goal_terminal_status = Some("paused".to_string());
        assert!(!goal_terminal_was_completed(&poll));
        poll.last_goal_terminal_status = Some("blocked".to_string());
        assert!(!goal_terminal_was_completed(&poll));
    }
    #[test]
    fn paused_or_blocked_goal_settles_without_step_end() {
        let mut poll = goal_store::GoalJournalPoll {
            last_goal_terminal_record: Some(10),
            last_goal_terminal_status: Some("paused".to_string()),
            last_goal_terminal_goal_id: Some("g".to_string()),
            last_goal_terminal_requires_closed_step: false,
            last_step_begin_record: Some(9),
            last_step_end_record: Some(7),
            ..goal_store::GoalJournalPoll::default()
        };
        let paused = Some(json!({ "goal_id": "g", "status": "paused" }));
        assert!(goal_terminal_is_settled(&poll, 5, "g", &paused).unwrap());

        poll.last_goal_terminal_status = Some("blocked".to_string());
        let blocked = Some(json!({ "goal_id": "g", "status": "blocked" }));
        assert!(goal_terminal_is_settled(&poll, 5, "g", &blocked).unwrap());
    }

    #[test]
    fn old_terminal_or_replacement_goal_cannot_settle_current_goal() {
        let poll = goal_store::GoalJournalPoll {
            last_goal_terminal_record: Some(10),
            last_goal_terminal_status: Some("paused".to_string()),
            last_goal_terminal_goal_id: Some("g".to_string()),
            ..goal_store::GoalJournalPoll::default()
        };
        let active = Some(json!({ "goal_id": "g", "status": "active" }));
        assert!(!goal_terminal_is_settled(&poll, 5, "g", &active).unwrap());

        let replacement = Some(json!({ "goal_id": "new", "status": "active" }));
        assert!(goal_terminal_is_settled(&poll, 5, "g", &replacement).is_err());
    }

    #[test]
    fn cancel_ack_must_be_a_new_terminal_for_the_same_goal() {
        let poll = goal_store::GoalJournalPoll {
            last_goal_terminal_record: Some(10),
            last_goal_terminal_status: Some("paused".to_string()),
            last_goal_terminal_goal_id: Some("g".to_string()),
            ..goal_store::GoalJournalPoll::default()
        };
        let paused = Some(json!({ "goal_id": "g", "status": "paused" }));
        assert!(goal_cancel_ack_observed(&poll, 5, "g", &paused).unwrap());
        assert!(!goal_cancel_ack_observed(&poll, 10, "g", &paused).unwrap());

        let replacement = Some(json!({ "goal_id": "new", "status": "paused" }));
        assert!(goal_cancel_ack_observed(&poll, 5, "g", &replacement).is_err());
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
            .respond(
                42,
                json!({ "outcome": { "outcome": "selected", "optionId": "approve_once" } }),
            )
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
    fn late_cancel_completion_cannot_overwrite_stopped_worker_with_idle() {
        let worker = new_probe_worker();
        mark_worker_stopped(&worker, "cancel_timeout");

        assert!(record_worker_idle_if_active(&worker, "cancelled").is_err());
        let status = worker.status.lock().unwrap().clone();
        assert_eq!(status.state, "stopped");
        assert_eq!(status.reason.as_deref(), Some("cancel_timeout"));
    }

    #[test]
    fn list_workers_mirrors_the_worker_map() {
        let manager = AcpProcessManager::new();
        assert!(manager.list_workers().is_empty());

        let mut worker_a = new_probe_worker();
        worker_a.session_id = "session-a".to_string();
        *worker_a.connection_id.lock().unwrap() = Some("lease-1".to_string());
        {
            let mut status = worker_a.status.lock().unwrap();
            status.state = "busy".to_string();
            status.reason = Some("prompt".to_string());
        }
        let updated_a = worker_a.status.lock().unwrap().updated_at;

        let mut worker_b = new_probe_worker();
        worker_b.session_id = "session-b".to_string();

        {
            let mut workers = manager.inner.workers.lock().unwrap();
            workers.insert("session-a".to_string(), Arc::new(worker_a));
            workers.insert("session-b".to_string(), Arc::new(worker_b));
        }

        let views = manager.list_workers();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].session_id, "session-a");
        assert_eq!(views[0].state, "busy");
        assert_eq!(views[0].connection_id.as_deref(), Some("lease-1"));
        assert_eq!(views[0].updated_at, updated_a);
        assert_eq!(views[1].session_id, "session-b");
        assert_eq!(views[1].state, "ready");
        assert_eq!(views[1].connection_id, None);

        // The observation view stays in sync with the ground-truth map.
        manager.inner.workers.lock().unwrap().remove("session-b");
        assert_eq!(manager.list_workers().len(), 1);
        assert_eq!(manager.list_workers()[0].session_id, "session-a");
    }

    #[test]
    fn connect_operations_are_shared_per_session_only() {
        let manager = AcpProcessManager::new();
        let session_a_first = manager.connect_op("session-a");
        let session_a_second = manager.connect_op("session-a");
        let session_b = manager.connect_op("session-b");

        assert!(Arc::ptr_eq(&session_a_first, &session_a_second));
        assert!(!Arc::ptr_eq(&session_a_first, &session_b));

        let session_a_guard = session_a_first.try_lock().expect("first session-a connect");
        assert!(session_a_second.try_lock().is_err());
        assert!(session_b.try_lock().is_ok());
        drop(session_a_guard);
        assert!(session_a_second.try_lock().is_ok());
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

    fn already_in_mode_response(details: &str) -> JsonRpcResponse {
        JsonRpcResponse {
            id: Some(4),
            result: None,
            error: Some(JsonRpcError {
                code: Some(json!(-32603)),
                message: Some("Internal error".to_string()),
                data: Some(json!({ "details": details })),
            }),
            method: None,
        }
    }

    #[test]
    fn detects_kimi_already_in_plan_mode_error() {
        let response = already_in_mode_response("Already in plan mode");

        assert!(is_already_in_target_mode_error(&response, "plan"));
        assert_eq!(
            describe_rpc_error(&response),
            "code=-32603 message=Internal error details=Already in plan mode"
        );
    }

    #[test]
    fn detects_symmetric_already_in_permission_mode_errors() {
        assert!(is_already_in_target_mode_error(
            &already_in_mode_response("Already in auto mode"),
            "auto"
        ));
        assert!(is_already_in_target_mode_error(
            &already_in_mode_response("Already in yolo mode"),
            "yolo"
        ));
        assert!(is_already_in_target_mode_error(
            &already_in_mode_response("Already in default mode"),
            "default"
        ));
        // Manual maps to ACP `default`; accept either wording.
        assert!(is_already_in_target_mode_error(
            &already_in_mode_response("Already in manual mode"),
            "default"
        ));
        assert!(is_already_in_target_mode_error(
            &already_in_mode_response("Already in default mode"),
            "manual"
        ));
        // Wrong target must not match.
        assert!(!is_already_in_target_mode_error(
            &already_in_mode_response("Already in plan mode"),
            "auto"
        ));
    }

    #[test]
    fn does_not_treat_other_internal_errors_as_idempotent_plan_success() {
        let response = already_in_mode_response("Session is busy");

        assert!(!is_already_in_target_mode_error(&response, "plan"));
        assert!(!is_already_in_target_mode_error(&response, "auto"));
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
            (true, PermissionMode::Auto, false, false)
        );

        session_store::update_session_swarm_mode(session_id, true).expect("persist swarm mode");
        session_store::update_session_goal_mode(session_id, true).expect("persist goal mode");

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
            (false, PermissionMode::Manual, true, true)
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
        let payload = mode_status_payload_for(true, PermissionMode::Auto, false, true);
        assert_eq!(payload["plan_mode"], true);
        assert_eq!(payload["permission_mode"], "auto");
        assert_eq!(payload["swarm_mode"], false);
        assert_eq!(payload["goal_mode"], true);
        assert!(payload["context_usage"].is_null());
    }
}

#[cfg(test)]
mod session_cwd_tests {
    use super::{acp_session_cwd_from_list_item, resolve_local_session_cwd};
    use crate::test_env::lock::set_kimi_code_home;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn acp_session_cwd_from_list_item_prefers_cwd_field() {
        let item = serde_json::json!({ "sessionId": "abc", "cwd": "C:\\work", "title": "t" });
        assert_eq!(
            acp_session_cwd_from_list_item(&item).unwrap(),
            PathBuf::from(r"C:\work")
        );
    }

    #[test]
    fn local_session_cwd_uses_state_before_acp_metadata() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let work_dir = temp.path().join("project");
        let session_dir = home
            .join("sessions")
            .join("work-key")
            .join("session-local-cwd");
        fs::create_dir_all(&work_dir).expect("work dir");
        fs::create_dir_all(&session_dir).expect("session dir");
        fs::write(
            session_dir.join("state.json"),
            serde_json::to_vec(&serde_json::json!({
                "cwd": work_dir.to_string_lossy(),
            }))
            .expect("state json"),
        )
        .expect("state");

        let _home_guard = set_kimi_code_home(&home);
        assert_eq!(
            resolve_local_session_cwd("session-local-cwd").expect("resolve local cwd"),
            Some(work_dir)
        );
    }
}
