use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

const DESKTOP_API_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_STDOUT_FRAME_BYTES: usize = 8 * 1024 * 1024;
const WIRE_EVENT_NAME: &str = "wire:message";
const DESKTOP_API_TRACE_ENV: &str = "KIMI_DESKTOP_API_TRACE";

#[derive(Clone)]
pub struct WireProcessManager {
    inner: Arc<ManagerState>,
}

struct ManagerState {
    workers: Mutex<HashMap<String, Arc<WorkerState>>>,
}

struct WorkerState {
    session_id: String,
    child: Mutex<Option<CommandChild>>,
    in_flight_prompt_ids: Mutex<HashSet<String>>,
    status: Mutex<RuntimeStatus>,
    worker_id: Mutex<Option<String>>,
    status_seq: AtomicU64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeStatus {
    pub session_id: String,
    pub state: String,
    pub seq: u64,
    pub worker_id: Option<String>,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize)]
struct WireMessagePayload {
    session_id: String,
    message: String,
}

#[derive(Clone)]
struct DesktopApiCacheEntry {
    value: Value,
    expires_at: Instant,
}

static DESKTOP_API_CACHE: OnceLock<Mutex<HashMap<String, DesktopApiCacheEntry>>> = OnceLock::new();
static DESKTOP_API_PROCESS: OnceLock<DesktopApiProcessManager> = OnceLock::new();

#[derive(Clone)]
struct DesktopApiProcessManager {
    inner: Arc<DesktopApiProcessState>,
}

struct DesktopApiProcessState {
    child: Mutex<Option<CommandChild>>,
    active_process_id: Mutex<Option<u64>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    start_lock: tokio::sync::Mutex<()>,
    request_seq: AtomicU64,
    process_seq: AtomicU64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RestartWorkersSummary {
    pub restarted_session_ids: Vec<String>,
    pub skipped_busy_session_ids: Vec<String>,
}

impl DesktopApiProcessManager {
    fn new() -> Self {
        Self {
            inner: Arc::new(DesktopApiProcessState {
                child: Mutex::new(None),
                active_process_id: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                start_lock: tokio::sync::Mutex::new(()),
                request_seq: AtomicU64::new(0),
                process_seq: AtomicU64::new(0),
            }),
        }
    }

    async fn call(&self, app: &AppHandle, action: &str, params: Value) -> Result<Value, String> {
        self.ensure_started(app).await?;

        let request_id = format!(
            "desktop-api-{}",
            self.inner.request_seq.fetch_add(1, Ordering::SeqCst) + 1
        );
        let (tx, rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap()
            .insert(request_id.clone(), tx);

        let request = json!({
            "request_id": request_id,
            "action": action,
            "params": params,
        })
        .to_string();

        let write_result = {
            let mut child = self.inner.child.lock().unwrap();
            match child.as_mut() {
                Some(child) => child.write(format!("{}\n", request).as_bytes()),
                None => {
                    self.inner.pending.lock().unwrap().remove(&request_id);
                    return Err("Desktop API helper is not running".to_string());
                }
            }
        };

        if let Err(e) = write_result {
            self.inner.pending.lock().unwrap().remove(&request_id);
            self.stop("stdin_write_failed");
            return Err(format!("Failed to write desktop API request: {}", e));
        }

        match tokio::time::timeout(DESKTOP_API_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Desktop API helper stopped before responding".to_string()),
            Err(_) => {
                self.inner.pending.lock().unwrap().remove(&request_id);
                self.stop("timeout");
                Err("Desktop API helper timed out".to_string())
            }
        }
    }

    async fn ensure_started(&self, app: &AppHandle) -> Result<(), String> {
        if self.inner.child.lock().unwrap().is_some() {
            return Ok(());
        }

        let _guard = self.inner.start_lock.lock().await;
        if self.inner.child.lock().unwrap().is_some() {
            return Ok(());
        }

        let command = app
            .shell()
            .sidecar("kimi-sidecar")
            .map_err(|e| format!("Failed to create desktop API helper command: {}", e))?
            .args(["__desktop-api-server"]);

        let (mut rx, child) = command
            .spawn()
            .map_err(|e| format!("Failed to spawn desktop API helper: {}", e))?;

        let process_id = self.inner.process_seq.fetch_add(1, Ordering::SeqCst) + 1;
        *self.inner.active_process_id.lock().unwrap() = Some(process_id);
        *self.inner.child.lock().unwrap() = Some(child);

        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            let mut stdout_buf: Vec<u8> = Vec::new();
            let mut stderr_tail = String::new();

            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        stdout_buf.extend_from_slice(&bytes);
                        while let Some(newline_idx) = stdout_buf.iter().position(|b| *b == b'\n') {
                            let mut line_bytes: Vec<u8> = stdout_buf.drain(..=newline_idx).collect();
                            if line_bytes.last() == Some(&b'\n') {
                                line_bytes.pop();
                            }
                            if line_bytes.last() == Some(&b'\r') {
                                line_bytes.pop();
                            }
                            if line_bytes.iter().all(|b| b.is_ascii_whitespace()) {
                                continue;
                            }
                            match String::from_utf8(line_bytes) {
                                Ok(line) => handle_desktop_api_response_line(&inner, &line),
                                Err(err) => {
                                    eprintln!("[desktop-api] dropped invalid UTF-8 stdout line: {}", err);
                                }
                            }
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        eprint!("[desktop-api] {}", text);
                        stderr_tail.push_str(&text);
                        if stderr_tail.len() > 4096 {
                            let keep_from = stderr_tail.len().saturating_sub(4096);
                            stderr_tail = stderr_tail[keep_from..].to_string();
                        }
                    }
                    CommandEvent::Terminated(_) => break,
                    _ => {}
                }
            }

            let is_current = inner.active_process_id.lock().unwrap().as_ref() == Some(&process_id);
            if is_current {
                inner.child.lock().unwrap().take();
                *inner.active_process_id.lock().unwrap() = None;
                let detail = if stderr_tail.trim().is_empty() {
                    "Desktop API helper exited".to_string()
                } else {
                    format!("Desktop API helper exited: {}", stderr_tail.trim())
                };
                reject_desktop_api_pending(&inner, detail);
            }
        });

        Ok(())
    }

    fn stop(&self, reason: &str) {
        if let Some(child) = self.inner.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        *self.inner.active_process_id.lock().unwrap() = None;
        reject_desktop_api_pending(
            &self.inner,
            format!("Desktop API helper stopped ({})", reason),
        );
    }
}

impl WireProcessManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ManagerState {
                workers: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn get_or_create_worker(&self, session_id: &str) -> Arc<WorkerState> {
        let mut workers = self.inner.workers.lock().unwrap();
        workers
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(WorkerState::new(session_id.to_string())))
            .clone()
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
            .map(|worker| worker.child.lock().unwrap().is_some())
            .unwrap_or(false)
    }

    pub fn is_busy(&self, session_id: &str) -> bool {
        let workers = self.inner.workers.lock().unwrap();
        workers
            .get(session_id)
            .map(|worker| !worker.in_flight_prompt_ids.lock().unwrap().is_empty())
            .unwrap_or(false)
    }

    pub fn ensure_editable(&self, session_id: &str) -> Result<(), String> {
        if self.is_busy(session_id) {
            return Err("Session is busy. Please wait for it to complete before modifying.".into());
        }
        Ok(())
    }

    pub async fn connect(&self, app: &AppHandle, session_id: String) -> Result<(), String> {
        let worker = self.get_or_create_worker(&session_id);
        if worker.child.lock().unwrap().is_none() {
            self.start_worker(app.clone(), worker.clone(), "start").await?;
        } else {
            emit_status_snapshot(app, &worker);
        }
        Ok(())
    }

    pub async fn send(&self, app: &AppHandle, session_id: String, message: String) -> Result<(), String> {
        let worker = self.get_or_create_worker(&session_id);
        if worker.child.lock().unwrap().is_none() {
            self.start_worker(app.clone(), worker.clone(), "start").await?;
        }

        let parsed: Value = serde_json::from_str(&message)
            .map_err(|e| format!("Invalid JSON-RPC message: {}", e))?;
        let method = parsed.get("method").and_then(Value::as_str);
        let id = parsed
            .get("id")
            .and_then(|value| match value {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            });

        match method {
            Some("prompt") => {
                let prompt_id = id
                    .clone()
                    .ok_or_else(|| "prompt message requires an id".to_string())?;
                {
                    let mut in_flight = worker.in_flight_prompt_ids.lock().unwrap();
                    if !in_flight.is_empty() {
                        return Err("Session is busy; wait for completion before sending a new prompt.".into());
                    }
                    in_flight.insert(prompt_id);
                }
                emit_status(app, &worker, "busy", Some("prompt"), None);
            }
            Some("cancel") => {
                if worker.in_flight_prompt_ids.lock().unwrap().is_empty() {
                    if let Some(cancel_id) = id {
                        emit_wire_message(
                            app,
                            &session_id,
                            json!({"jsonrpc": "2.0", "id": cancel_id, "result": {}}).to_string(),
                        );
                    }
                    return Ok(());
                }
            }
            _ => {}
        }

        let write_result = {
            let mut child = worker.child.lock().unwrap();
            match child.as_mut() {
                Some(child) => child.write(format!("{}\n", message).as_bytes()),
                None => return Err("Wire worker is not running".into()),
            }
        };

        if let Err(e) = write_result {
            if method == Some("prompt") {
                if let Some(prompt_id) = id {
                    worker.in_flight_prompt_ids.lock().unwrap().remove(&prompt_id);
                }
                emit_status(app, &worker, "error", Some("stdin_write_failed"), Some(&e.to_string()));
            }
            return Err(format!("Failed to write to wire worker: {}", e));
        }

        Ok(())
    }

    pub async fn disconnect(&self, app: &AppHandle, session_id: String) -> Result<(), String> {
        let workers = self.inner.workers.lock().unwrap();
        if let Some(worker) = workers.get(&session_id) {
            emit_status_snapshot(app, worker);
        }
        Ok(())
    }

    pub async fn stop_session(&self, app: &AppHandle, session_id: &str, reason: &str) -> Result<(), String> {
        let worker = {
            let workers = self.inner.workers.lock().unwrap();
            workers.get(session_id).cloned()
        };
        if let Some(worker) = worker {
            stop_worker(app, &worker, reason, true);
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let workers: Vec<Arc<WorkerState>> = self
            .inner
            .workers
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for worker in workers {
            if let Some(child) = worker.child.lock().unwrap().take() {
                let _ = child.kill();
            }
            worker.in_flight_prompt_ids.lock().unwrap().clear();
            *worker.worker_id.lock().unwrap() = None;
        }
    }

    pub async fn restart_running_workers(
        &self,
        app: &AppHandle,
        reason: &str,
        force: bool,
    ) -> RestartWorkersSummary {
        let running: Vec<(String, Arc<WorkerState>)> = self
            .inner
            .workers
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(session_id, worker)| {
                if worker.child.lock().unwrap().is_some() {
                    Some((session_id.clone(), worker.clone()))
                } else {
                    None
                }
            })
            .collect();

        let mut restarted = Vec::new();
        let mut skipped_busy = Vec::new();

        for (session_id, worker) in running {
            if !force && !worker.in_flight_prompt_ids.lock().unwrap().is_empty() {
                skipped_busy.push(session_id);
                continue;
            }

            restarted.push(session_id.clone());
            emit_status(app, &worker, "restarting", Some(reason), None);
            stop_worker(app, &worker, "restart", false);
            if let Err(e) = self.start_worker(app.clone(), worker.clone(), reason).await {
                emit_status(app, &worker, "error", Some("restart_failed"), Some(&e));
            } else {
                emit_restart_notice(app, &worker, reason);
            }
        }

        RestartWorkersSummary {
            restarted_session_ids: restarted,
            skipped_busy_session_ids: skipped_busy,
        }
    }

    async fn start_worker(
        &self,
        app: AppHandle,
        worker: Arc<WorkerState>,
        reason: &str,
    ) -> Result<(), String> {
        if worker.child.lock().unwrap().is_some() {
            return Ok(());
        }

        worker.in_flight_prompt_ids.lock().unwrap().clear();
        let worker_id = new_worker_id(&worker.session_id);
        *worker.worker_id.lock().unwrap() = Some(worker_id.clone());

        let command = app
            .shell()
            .sidecar("kimi-sidecar")
            .map_err(|e| format!("Failed to create sidecar command: {}", e))?
            .args(["__desktop-worker", &worker.session_id]);

        let (mut rx, child) = command
            .spawn()
            .map_err(|e| format!("Failed to spawn wire worker: {}", e))?;

        *worker.child.lock().unwrap() = Some(child);
        emit_status(&app, &worker, "idle", Some(reason), None);

        let app_for_task = app.clone();
        let worker_for_task = worker.clone();
        tauri::async_runtime::spawn(async move {
            let mut stdout_buf: Vec<u8> = Vec::new();
            let mut stderr_tail = String::new();
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        stdout_buf.extend_from_slice(&bytes);
                        while let Some(newline_idx) = stdout_buf.iter().position(|b| *b == b'\n') {
                            let mut line_bytes: Vec<u8> = stdout_buf.drain(..=newline_idx).collect();
                            if line_bytes.last() == Some(&b'\n') {
                                line_bytes.pop();
                            }
                            if line_bytes.last() == Some(&b'\r') {
                                line_bytes.pop();
                            }
                            if line_bytes.iter().all(|b| b.is_ascii_whitespace()) {
                                continue;
                            }
                            match String::from_utf8(line_bytes) {
                                Ok(line) => {
                                    emit_wire_message(&app_for_task, &worker_for_task.session_id, line.clone());
                                    handle_worker_output(&app_for_task, &worker_for_task, &line);
                                }
                                Err(err) => {
                                    eprintln!(
                                        "[wire:{}] dropped invalid UTF-8 stdout line: {}",
                                        worker_for_task.session_id, err
                                    );
                                }
                            }
                        }
                        if stdout_buf.len() > MAX_STDOUT_FRAME_BYTES {
                            let detail = format!(
                                "Wire worker produced an oversized unterminated stdout frame ({} bytes)",
                                stdout_buf.len()
                            );
                            eprintln!("[wire:{}] {}", worker_for_task.session_id, detail);
                            emit_status(
                                &app_for_task,
                                &worker_for_task,
                                "error",
                                Some("oversized_stdout_frame"),
                                Some(&detail),
                            );
                            emit_wire_message(
                                &app_for_task,
                                &worker_for_task.session_id,
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": new_message_id(),
                                    "error": {
                                        "code": -1,
                                        "message": detail
                                    }
                                })
                                .to_string(),
                            );
                            stdout_buf.clear();
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        let text = String::from_utf8_lossy(&bytes).to_string();
                        eprint!("[wire:{}] {}", worker_for_task.session_id, text);
                        stderr_tail.push_str(&text);
                        if stderr_tail.len() > 4096 {
                            let keep_from = stderr_tail.len().saturating_sub(4096);
                            stderr_tail = stderr_tail[keep_from..].to_string();
                        }
                    }
                    CommandEvent::Terminated(_) => {
                        break;
                    }
                    _ => {}
                }
            }

            if !stdout_buf.iter().all(|b| b.is_ascii_whitespace()) {
                match String::from_utf8(stdout_buf) {
                    Ok(line) => {
                        emit_wire_message(&app_for_task, &worker_for_task.session_id, line.clone());
                        handle_worker_output(&app_for_task, &worker_for_task, &line);
                    }
                    Err(err) => {
                        eprintln!(
                            "[wire:{}] dropped invalid UTF-8 stdout tail: {}",
                            worker_for_task.session_id, err
                        );
                    }
                }
            }

            let still_current = worker_for_task
                .worker_id
                .lock()
                .unwrap()
                .as_deref()
                == Some(worker_id.as_str());
            if still_current {
                worker_for_task.child.lock().unwrap().take();
                worker_for_task.in_flight_prompt_ids.lock().unwrap().clear();
                *worker_for_task.worker_id.lock().unwrap() = None;
                let detail = if stderr_tail.trim().is_empty() {
                    None
                } else {
                    Some(stderr_tail.trim().to_string())
                };
                emit_status(
                    &app_for_task,
                    &worker_for_task,
                    "error",
                    Some("process_exit"),
                    detail.as_deref(),
                );
                emit_wire_message(
                    &app_for_task,
                    &worker_for_task.session_id,
                    json!({
                        "jsonrpc": "2.0",
                        "id": new_message_id(),
                        "error": {
                            "code": -1,
                            "message": detail.unwrap_or_else(|| "Wire worker exited".to_string())
                        }
                    })
                    .to_string(),
                );
            }
        });

        Ok(())
    }
}

impl WorkerState {
    fn new(session_id: String) -> Self {
        Self {
            status: Mutex::new(RuntimeStatus {
                session_id: session_id.clone(),
                state: "stopped".to_string(),
                seq: 0,
                worker_id: None,
                reason: None,
                detail: None,
                updated_at: now_ms(),
            }),
            session_id,
            child: Mutex::new(None),
            in_flight_prompt_ids: Mutex::new(HashSet::new()),
            worker_id: Mutex::new(None),
            status_seq: AtomicU64::new(0),
        }
    }
}

fn desktop_api_process_manager() -> &'static DesktopApiProcessManager {
    DESKTOP_API_PROCESS.get_or_init(DesktopApiProcessManager::new)
}

pub fn stop_desktop_api_process() {
    if let Some(manager) = DESKTOP_API_PROCESS.get() {
        manager.stop("app_exit");
    }
}

fn handle_desktop_api_response_line(inner: &Arc<DesktopApiProcessState>, line: &str) {
    let Ok(envelope) = serde_json::from_str::<Value>(line) else {
        eprintln!("[desktop-api] ignored non-JSON stdout line: {}", line);
        return;
    };

    let Some(request_id) = envelope.get("request_id").and_then(Value::as_str) else {
        eprintln!("[desktop-api] ignored response without request_id");
        return;
    };

    let sender = inner.pending.lock().unwrap().remove(request_id);
    let Some(sender) = sender else {
        return;
    };

    let result = if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(envelope
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Desktop API helper failed")
            .to_string())
    };
    let _ = sender.send(result);
}

fn reject_desktop_api_pending(inner: &Arc<DesktopApiProcessState>, message: String) {
    let pending = {
        let mut pending = inner.pending.lock().unwrap();
        std::mem::take(&mut *pending)
    };
    for (_, sender) in pending {
        let _ = sender.send(Err(message.clone()));
    }
}

fn stop_worker(app: &AppHandle, worker: &Arc<WorkerState>, reason: &str, emit: bool) {
    if let Some(child) = worker.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    worker.in_flight_prompt_ids.lock().unwrap().clear();
    *worker.worker_id.lock().unwrap() = None;
    if emit {
        emit_status(app, worker, "stopped", Some(reason), None);
    }
}

fn handle_worker_output(app: &AppHandle, worker: &Arc<WorkerState>, line: &str) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        eprintln!(
            "[wire:{}] ignored non-JSON stdout line: {}",
            worker.session_id,
            line
        );
        return;
    };

    let message_id = message.get("id").and_then(Value::as_str).map(str::to_string);
    let Some(message_id) = message_id else {
        return;
    };

    let is_response = message.get("method").is_none()
        && (message.get("result").is_some() || message.get("error").is_some());
    if !is_response {
        return;
    }

    let mut was_prompt_response = false;
    let mut now_idle = false;
    {
        let mut in_flight = worker.in_flight_prompt_ids.lock().unwrap();
        if in_flight.remove(&message_id) {
            was_prompt_response = true;
            now_idle = in_flight.is_empty();
        }
    }

    if was_prompt_response && now_idle {
        let reason = if message.get("error").is_some() {
            "prompt_error"
        } else {
            "prompt_complete"
        };
        emit_status(app, worker, "idle", Some(reason), None);
    }
}

fn emit_status(
    app: &AppHandle,
    worker: &Arc<WorkerState>,
    state: &str,
    reason: Option<&str>,
    detail: Option<&str>,
) {
    let seq = worker.status_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let status = RuntimeStatus {
        session_id: worker.session_id.clone(),
        state: state.to_string(),
        seq,
        worker_id: worker.worker_id.lock().unwrap().clone(),
        reason: reason.map(str::to_string),
        detail: detail.map(str::to_string),
        updated_at: now_ms(),
    };
    *worker.status.lock().unwrap() = status.clone();
    emit_wire_message(
        app,
        &worker.session_id,
        json!({"jsonrpc": "2.0", "method": "session_status", "params": status}).to_string(),
    );
}

fn emit_status_snapshot(app: &AppHandle, worker: &Arc<WorkerState>) {
    let status = worker.status.lock().unwrap().clone();
    emit_wire_message(
        app,
        &worker.session_id,
        json!({"jsonrpc": "2.0", "method": "session_status", "params": status}).to_string(),
    );
}

fn emit_restart_notice(app: &AppHandle, worker: &Arc<WorkerState>, reason: &str) {
    emit_wire_message(
        app,
        &worker.session_id,
        json!({
            "jsonrpc": "2.0",
            "method": "event",
            "params": {
                "type": "SessionNotice",
                "payload": {
                    "text": "Session restarted due to config update",
                    "kind": "restart",
                    "reason": reason,
                    "restart_ms": null
                }
            }
        })
        .to_string(),
    );
}

fn emit_wire_message(app: &AppHandle, session_id: &str, message: String) {
    let _ = app.emit(
        WIRE_EVENT_NAME,
        WireMessagePayload {
            session_id: session_id.to_string(),
            message,
        },
    );
}

pub async fn call_desktop_api(
    app: &AppHandle,
    action: &str,
    params: Value,
) -> Result<Value, String> {
    let trace_enabled = desktop_api_trace_enabled();
    let total_start = Instant::now();
    let cache_key = desktop_api_cache_ttl(action).map(|_| desktop_api_cache_key(action, &params));
    if let Some(key) = cache_key.as_deref() {
        if let Some(value) = get_cached_desktop_api_response(key) {
            if trace_enabled {
                eprintln!(
                    "[desktop-api] action={} cache=hit total_ms={}",
                    action,
                    total_start.elapsed().as_millis()
                );
            }
            return Ok(value);
        }
    }

    let result = desktop_api_process_manager()
        .call(app, action, params)
        .await;

    match result {
        Ok(result) => {
            if desktop_api_action_invalidates_cache(action) {
                clear_desktop_api_cache();
            } else if let (Some(key), Some(ttl)) = (cache_key, desktop_api_cache_ttl(action)) {
                cache_desktop_api_response(key, result.clone(), ttl);
            }
            if trace_enabled {
                eprintln!(
                    "[desktop-api] action={} cache=miss persistent=true total_ms={}",
                    action,
                    total_start.elapsed().as_millis()
                );
            }
            Ok(result)
        }
        Err(message) => {
            if trace_enabled {
                eprintln!(
                    "[desktop-api] action={} cache=miss persistent=true error=true total_ms={}",
                    action,
                    total_start.elapsed().as_millis()
                );
            }
            Err(message)
        }
    }
}

pub fn prewarm_desktop_api_process(app: AppHandle) {
    if matches!(
        std::env::var("KIMI_DESKTOP_API_PREWARM").as_deref(),
        Ok("0") | Ok("false") | Ok("FALSE") | Ok("no") | Ok("NO")
    ) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        if let Err(err) = desktop_api_process_manager().ensure_started(&app).await {
            eprintln!("[desktop-api] prewarm failed: {}", err);
        }
    });
}

fn desktop_api_cache() -> &'static Mutex<HashMap<String, DesktopApiCacheEntry>> {
    DESKTOP_API_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn desktop_api_cache_ttl(action: &str) -> Option<Duration> {
    match action {
        "list_sessions" | "get_session" => Some(Duration::from_secs(5)),
        "list_work_dirs" | "get_global_config" => Some(Duration::from_secs(60)),
        "get_git_diff_stats" | "list_session_directory" => Some(Duration::from_secs(15)),
        _ => None,
    }
}

fn desktop_api_cache_key(action: &str, params: &Value) -> String {
    format!("{}\n{}", action, params)
}

fn get_cached_desktop_api_response(key: &str) -> Option<Value> {
    let mut cache = desktop_api_cache().lock().unwrap();
    let Some(entry) = cache.get(key) else {
        return None;
    };
    if Instant::now() <= entry.expires_at {
        return Some(entry.value.clone());
    }
    cache.remove(key);
    None
}

fn cache_desktop_api_response(key: String, value: Value, ttl: Duration) {
    let expires_at = Instant::now() + ttl;
    desktop_api_cache()
        .lock()
        .unwrap()
        .insert(key, DesktopApiCacheEntry { value, expires_at });
}

fn clear_desktop_api_cache() {
    desktop_api_cache().lock().unwrap().clear();
}

fn desktop_api_action_invalidates_cache(action: &str) -> bool {
    matches!(
        action,
        "create_session"
            | "delete_session"
            | "update_session"
            | "fork_session"
            | "generate_title"
            | "upload_session_file"
            | "update_global_config"
    )
}

fn desktop_api_trace_enabled() -> bool {
    matches!(
        std::env::var(DESKTOP_API_TRACE_ENV).as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_message_id() -> String {
    format!("rust-{}", now_ms())
}

fn new_worker_id(session_id: &str) -> String {
    format!("worker-{}-{}", session_id, now_ms())
}
