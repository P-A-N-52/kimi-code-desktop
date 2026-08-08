//! Single runtime child-process supervisor (M2 skeleton).
//!
//! Owns the lifecycle of one source-built runtime child: spawn, the
//! request/response pending table, handshake and shutdown orchestration, and
//! fail-closed fault handling. The pump threads and routing plumbing live in
//! `pump.rs`. Threading follows the existing desktop pattern (`std::process`
//! + pump threads, as in `acp.rs`); no new crates.
//!
//! Fail closed: a protocol fault, an unexpected exit, or a duplicate/unknown
//! response id kills the child, moves the supervisor to `Failed`, settles
//! every pending request with the fault, and keeps the stderr ring for the
//! crash report. Not wired to Tauri commands yet (M4); consumed by tests only.

use super::codec::encode_request;
use super::protocol::{
    validate_runtime_info, ErrorBody, EventFrame, FaultCode, HelloParams, ProtocolFault,
    RequestFrame, RuntimeInfo, MAX_FRAME_BYTES, METHOD_HELLO, METHOD_SHUTDOWN,
};
use super::pump::{
    await_exit, fail_closed, kill_child, lock, record_fault_if_live, run_stderr_pump,
    run_stdout_pump, PendingTable, SettledIds, SettledKind,
};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Default cap on retained stderr lines (diagnostics for crash reports).
const STDERR_RING_LINES: usize = 200;

/// Supervisor lifecycle state machine:
/// `NotStarted -> Handshaking -> Ready -> Stopping -> Stopped`, with `Failed`
/// reachable from any live state via fail-closed fault handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorState {
    NotStarted,
    Handshaking,
    Ready,
    Stopping,
    Stopped,
    Failed,
}

/// Every supervisor-level failure. `Rejected` is the only non-fatal variant:
/// it is a well-formed `ok: false` answer from the runtime.
#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeError {
    /// Framing/envelope contract violation — always fail-closed.
    Protocol(ProtocolFault),
    Io(String),
    /// Operation is not valid in the current supervisor state.
    InvalidState(&'static str),
    Timeout(&'static str),
    /// Child exited while the supervisor still expected it to be alive.
    UnexpectedExit {
        code: Option<i32>,
    },
    /// Response id matched an already settled request (contract violation).
    DuplicateResponseId(String),
    /// Response id never had a live request (contract violation).
    UnknownResponseId(String),
    /// Runtime answered a request with `ok: false`.
    Rejected(ErrorBody),
    /// Handshake validation failed (protocol selection or source commit).
    Readiness(String),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(fault) => write!(f, "protocol fault: {fault}"),
            Self::Io(message) => write!(f, "io error: {message}"),
            Self::InvalidState(message) => write!(f, "invalid state: {message}"),
            Self::Timeout(message) => write!(f, "timeout: {message}"),
            Self::UnexpectedExit { code } => {
                write!(f, "runtime exited unexpectedly (code {code:?})")
            }
            Self::DuplicateResponseId(id) => write!(f, "duplicate response id `{id}`"),
            Self::UnknownResponseId(id) => write!(f, "response for unknown request id `{id}`"),
            Self::Rejected(error) => write!(
                f,
                "runtime rejected request: {}: {}",
                error.code, error.message
            ),
            Self::Readiness(reason) => write!(f, "readiness check failed: {reason}"),
        }
    }
}

impl std::error::Error for RuntimeError {}

/// How to spawn the runtime child. Tests inject the fixture worker path; the
/// production dist-path resolution lands with the M4 config surface.
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    pub program: String,
    pub args: Vec<String>,
    /// Extra environment entries layered over the inherited environment.
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

/// Tunables; tests shrink `max_frame_bytes` to exercise the size cap cheaply.
#[derive(Debug, Clone, Copy)]
pub struct SupervisorOptions {
    pub max_frame_bytes: usize,
    pub stderr_ring_lines: usize,
}

impl Default for SupervisorOptions {
    fn default() -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
            stderr_ring_lines: STDERR_RING_LINES,
        }
    }
}

/// Handshake orchestration inputs.
#[derive(Debug, Clone)]
pub struct HandshakeConfig {
    pub hello: HelloParams,
    /// Pinned Kimi source commit the runtime must report (`None` skips the
    /// commit check; production always pins one).
    pub expected_commit: Option<String>,
    /// Covers both the hello response and the trailing `runtime.ready` event.
    pub timeout: Duration,
}

/// Shutdown orchestration inputs.
#[derive(Debug, Clone, Copy)]
pub struct ShutdownConfig {
    /// Bound on waiting for the `runtime.shutdown` drain response.
    pub response_timeout: Duration,
    /// Bound on waiting for process exit after the drain response.
    pub exit_timeout: Duration,
}

impl Default for ShutdownConfig {
    fn default() -> Self {
        Self {
            response_timeout: Duration::from_secs(15),
            exit_timeout: Duration::from_secs(10),
        }
    }
}

/// State shared with the pump threads. Locking rule: acquire each mutex in
/// its own scope; never hold two different mutexes across a blocking call.
pub(crate) struct Shared {
    pub(crate) state: Mutex<SupervisorState>,
    /// First fault wins; set exactly once on the transition to `Failed`.
    pub(crate) fault: Mutex<Option<RuntimeError>>,
    pub(crate) pending: Mutex<PendingTable>,
    pub(crate) settled: Mutex<SettledIds>,
    pub(crate) stdin: Mutex<Option<ChildStdin>>,
    pub(crate) child: Mutex<Option<Child>>,
    pub(crate) stderr_ring: Mutex<VecDeque<String>>,
    pub(crate) events_tx: mpsc::Sender<EventFrame>,
    /// Set when the pump routes `runtime.ready`; also notified on fail-closed
    /// so a waiting handshake wakes up and observes the state.
    pub(crate) ready: (Mutex<bool>, Condvar),
    pub(crate) exit: (Mutex<Option<ExitStatus>>, Condvar),
    pub(crate) next_request_id: AtomicU64,
    pub(crate) options: SupervisorOptions,
}

/// Supervisor for one runtime child. Public methods are synchronous; Tauri
/// commands (M4) will call them from blocking contexts.
pub struct RuntimeSupervisor {
    shared: Arc<Shared>,
    config: SpawnConfig,
    events_rx: Mutex<Option<mpsc::Receiver<EventFrame>>>,
    stdout_thread: Mutex<Option<JoinHandle<()>>>,
    stderr_thread: Mutex<Option<JoinHandle<()>>>,
}

impl RuntimeSupervisor {
    pub fn new(config: SpawnConfig) -> Self {
        Self::with_options(config, SupervisorOptions::default())
    }

    pub fn with_options(config: SpawnConfig, options: SupervisorOptions) -> Self {
        let (events_tx, events_rx) = mpsc::channel();
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(SupervisorState::NotStarted),
                fault: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                settled: Mutex::new(SettledIds::default()),
                stdin: Mutex::new(None),
                child: Mutex::new(None),
                stderr_ring: Mutex::new(VecDeque::new()),
                events_tx,
                ready: (Mutex::new(false), Condvar::new()),
                exit: (Mutex::new(None), Condvar::new()),
                next_request_id: AtomicU64::new(1),
                options,
            }),
            config,
            events_rx: Mutex::new(Some(events_rx)),
            stdout_thread: Mutex::new(None),
            stderr_thread: Mutex::new(None),
        }
    }

    pub fn state(&self) -> SupervisorState {
        *lock(&self.shared.state)
    }

    /// The recorded fault once the supervisor is `Failed` (first fault wins).
    pub fn fault(&self) -> Option<RuntimeError> {
        lock(&self.shared.fault).clone()
    }

    /// Process exit status, once the child has been reaped.
    pub fn exit_status(&self) -> Option<ExitStatus> {
        *lock(&self.shared.exit.0)
    }

    /// Newest-last stderr lines (up to the ring cap) for crash diagnostics.
    pub fn stderr_tail(&self, max_lines: usize) -> Vec<String> {
        let ring = lock(&self.shared.stderr_ring);
        ring.iter()
            .skip(ring.len().saturating_sub(max_lines))
            .cloned()
            .collect()
    }

    /// Hand the single event stream to its consumer (wave-2 translate). The
    /// handshake does not consume it, so `runtime.ready` is included.
    pub fn take_event_receiver(&self) -> Option<mpsc::Receiver<EventFrame>> {
        lock(&self.events_rx).take()
    }

    /// Spawn the child and start the stdio pumps. `NotStarted -> Handshaking`.
    pub fn start(&self) -> Result<(), RuntimeError> {
        {
            let mut state = lock(&self.shared.state);
            if *state != SupervisorState::NotStarted {
                return Err(RuntimeError::InvalidState("supervisor already started"));
            }
            *state = SupervisorState::Handshaking;
        }
        match self.spawn_child() {
            Ok(()) => Ok(()),
            Err(err) => {
                fail_closed(&self.shared, err.clone());
                Err(err)
            }
        }
    }

    fn spawn_child(&self) -> Result<(), RuntimeError> {
        let mut command = Command::new(&self.config.program);
        command
            .args(&self.config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(self.config.env.iter().map(|(key, value)| (key, value)));
        if let Some(cwd) = &self.config.cwd {
            command.current_dir(cwd);
        }
        let mut child = command
            .spawn()
            .map_err(|err| RuntimeError::Io(format!("failed to spawn runtime: {err}")))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        *lock(&self.shared.stdin) = stdin;
        *lock(&self.shared.child) = Some(child);
        if let Some(stdout) = stdout {
            let shared = Arc::clone(&self.shared);
            *lock(&self.stdout_thread) =
                Some(thread::spawn(move || run_stdout_pump(shared, stdout)));
        }
        if let Some(stderr) = stderr {
            let shared = Arc::clone(&self.shared);
            *lock(&self.stderr_thread) =
                Some(thread::spawn(move || run_stderr_pump(shared, stderr)));
        }
        Ok(())
    }

    /// Send a request and block for its response. Gates on liveness, not on
    /// the handshake state: a request sent before hello must still reach the
    /// runtime so its `handshake_required` error-response can surface.
    pub fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RuntimeError> {
        let id = format!(
            "req-{}",
            self.shared.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        let frame = RequestFrame::new(id, method, params);
        self.call_frame(frame, timeout)
    }

    /// Like [`Self::call`], but attaches the envelope-level `sessionId`
    /// (`RequestFrame::with_session`) for session-scoped methods
    /// (`session.open`/`session.close`, `turn.*`, `approval.respond`,
    /// `question.respond`). The runtime refuses an empty envelope
    /// `sessionId` as a fault, so an empty one is rejected locally without
    /// touching the child.
    pub fn call_with_session(
        &self,
        method: &str,
        session_id: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RuntimeError> {
        if session_id.is_empty() {
            return Err(RuntimeError::Protocol(ProtocolFault::new(
                FaultCode::InvalidEnvelope,
                "session-scoped request requires a non-empty session id",
            )));
        }
        let id = format!(
            "req-{}",
            self.shared.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        let frame = RequestFrame::new(id, method, params).with_session(session_id);
        self.call_frame(frame, timeout)
    }

    /// Shared request/response machinery behind `call`/`call_with_session`.
    fn call_frame(&self, frame: RequestFrame, timeout: Duration) -> Result<Value, RuntimeError> {
        {
            let state = lock(&self.shared.state);
            match *state {
                SupervisorState::Handshaking
                | SupervisorState::Ready
                | SupervisorState::Stopping => {}
                SupervisorState::NotStarted => {
                    return Err(RuntimeError::InvalidState("supervisor not started"));
                }
                SupervisorState::Stopped => {
                    return Err(RuntimeError::InvalidState("runtime already stopped"));
                }
                SupervisorState::Failed => {
                    return Err(RuntimeError::InvalidState("runtime supervisor failed"));
                }
            }
        }
        let id = frame.id.clone();
        let line = encode_request(&frame, self.shared.options.max_frame_bytes)
            .map_err(RuntimeError::Protocol)?;
        let (tx, rx) = mpsc::channel();
        lock(&self.shared.pending).insert(id.clone(), tx);
        let write_result = {
            let mut stdin_guard = lock(&self.shared.stdin);
            match stdin_guard.as_mut() {
                Some(stdin) => stdin
                    .write_all(line.as_bytes())
                    .and_then(|()| stdin.flush())
                    .map_err(|err| RuntimeError::Io(format!("runtime stdin write failed: {err}"))),
                None => Err(RuntimeError::InvalidState("runtime stdin is closed")),
            }
        };
        if let Err(err) = write_result {
            lock(&self.shared.pending).remove(&id);
            if matches!(err, RuntimeError::Io(_)) {
                // A broken pipe means the child is gone; fail deterministically
                // instead of waiting for the pump to notice.
                fail_closed(&self.shared, err.clone());
            }
            return Err(err);
        }
        match rx.recv_timeout(timeout) {
            Ok(outcome) => outcome,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                lock(&self.shared.pending).remove(&id);
                lock(&self.shared.settled).record(id, SettledKind::TimedOut);
                Err(RuntimeError::Timeout("runtime request timed out"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(RuntimeError::Io(
                "runtime response channel closed".to_string(),
            )),
        }
    }

    /// `Handshaking -> Ready`: send `runtime.hello`, validate the returned
    /// `RuntimeInfo` (protocol selection + pinned commit), then await the
    /// trailing `runtime.ready` event. Any failure fails the runtime closed.
    pub fn handshake(&self, config: &HandshakeConfig) -> Result<RuntimeInfo, RuntimeError> {
        {
            let state = lock(&self.shared.state);
            if *state != SupervisorState::Handshaking {
                return Err(RuntimeError::InvalidState(
                    "handshake requires a started, not-yet-ready supervisor",
                ));
            }
        }
        let params = serde_json::to_value(&config.hello)
            .map_err(|err| RuntimeError::Io(format!("hello params not serializable: {err}")))?;
        let value = match self.call(METHOD_HELLO, params, config.timeout) {
            Ok(value) => value,
            Err(err) => {
                fail_closed(&self.shared, err.clone());
                return Err(err);
            }
        };
        let info: RuntimeInfo = match serde_json::from_value(value) {
            Ok(info) => info,
            Err(err) => {
                let failure =
                    RuntimeError::Readiness(format!("hello result is not a runtimeInfo: {err}"));
                fail_closed(&self.shared, failure.clone());
                return Err(failure);
            }
        };
        if let Err(reason) = validate_runtime_info(&info, config.expected_commit.as_deref()) {
            let failure = RuntimeError::Readiness(reason);
            fail_closed(&self.shared, failure.clone());
            return Err(failure);
        }
        self.await_ready(config.timeout)?;
        *lock(&self.shared.state) = SupervisorState::Ready;
        Ok(info)
    }

    /// Wait for the `runtime.ready` event (flagged by the stdout pump) while
    /// watching for a concurrent fail-closed transition.
    fn await_ready(&self, timeout: Duration) -> Result<(), RuntimeError> {
        let deadline = Instant::now() + timeout;
        let mut ready_guard = lock(&self.shared.ready.0);
        loop {
            if *ready_guard {
                return Ok(());
            }
            if self.state() == SupervisorState::Failed {
                return Err(self.fault().unwrap_or(RuntimeError::Readiness(
                    "runtime failed during handshake".to_string(),
                )));
            }
            let now = Instant::now();
            if now >= deadline {
                let failure = RuntimeError::Timeout("runtime.ready was not emitted in time");
                fail_closed(&self.shared, failure.clone());
                return Err(failure);
            }
            let (guard, _) = self
                .shared
                .ready
                .1
                .wait_timeout(ready_guard, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            ready_guard = guard;
        }
    }

    /// `Ready -> Stopping -> Stopped`: send `runtime.shutdown`, wait bounded
    /// for the drain response, then for exit 0. Escalates to `kill` on any
    /// timeout. Idempotent on `Stopped`/`Failed`.
    pub fn shutdown(&self, config: &ShutdownConfig) -> Result<(), RuntimeError> {
        {
            let mut state = lock(&self.shared.state);
            match *state {
                SupervisorState::Stopped | SupervisorState::Failed => return Ok(()),
                SupervisorState::Ready | SupervisorState::Handshaking => {
                    *state = SupervisorState::Stopping;
                }
                SupervisorState::Stopping => {}
                SupervisorState::NotStarted => {
                    return Err(RuntimeError::InvalidState("supervisor not started"));
                }
            }
        }
        let response = self.call(
            METHOD_SHUTDOWN,
            Value::Object(Default::default()),
            config.response_timeout,
        );
        if let Err(err) = response {
            // The bounded drain did not answer: kill and report the failure.
            kill_child(&self.shared);
            await_exit(&self.shared, Duration::from_secs(2));
            record_fault_if_live(&self.shared, err.clone());
            return Err(err);
        }
        match await_exit(&self.shared, config.exit_timeout) {
            Some(status) if status.success() => {
                *lock(&self.shared.state) = SupervisorState::Stopped;
                Ok(())
            }
            Some(status) => {
                let failure = RuntimeError::UnexpectedExit {
                    code: status.code(),
                };
                record_fault_if_live(&self.shared, failure.clone());
                Err(failure)
            }
            None => {
                let failure = RuntimeError::Timeout("runtime did not exit after shutdown drain");
                kill_child(&self.shared);
                await_exit(&self.shared, Duration::from_secs(2));
                record_fault_if_live(&self.shared, failure.clone());
                Err(failure)
            }
        }
    }
}

impl Drop for RuntimeSupervisor {
    fn drop(&mut self) {
        if matches!(
            self.state(),
            SupervisorState::Handshaking | SupervisorState::Ready | SupervisorState::Stopping
        ) {
            kill_child(&self.shared);
        }
        // Reap and join so tests never leak processes or threads. The stdout
        // pump only blocks in `wait` after stdout EOF, i.e. once the child is
        // already exiting, so these joins are bounded.
        if let Some(mut child) = lock(&self.shared.child).take() {
            let _ = child.wait();
        }
        if let Some(handle) = lock(&self.stdout_thread).take() {
            let _ = handle.join();
        }
        if let Some(handle) = lock(&self.stderr_thread).take() {
            let _ = handle.join();
        }
    }
}
