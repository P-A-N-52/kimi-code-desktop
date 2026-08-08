//! Desktop-semantic host over the source runtime (M4 wave 0).
//!
//! `RuntimeHost` is the Tauri-managed singleton that turns the pure process
//! lifecycle of [`RuntimeSupervisor`] into desktop semantics:
//!
//! - **spawn resolution** (`host/spawn.rs`): dev default is the source-tree
//!   dist entry `runtime/kimi-code/apps/desktop-runtime/dist/main.mjs`
//!   spawned with `node`; `KIMI_RUNTIME_ENTRY` overrides it (tests and
//!   fixture injection). The handshake pins [`EXPECTED_KIMI_COMMIT`], and the
//!   runtime-reported Node version is gated at >= 24.15.0 (the
//!   `engines.node` floor of `apps/desktop-runtime`).
//! - **lazy lifecycle**: `ensure_started` runs `readiness::check_artifact` ->
//!   spawn -> handshake -> event-pump start, caches the handshake
//!   [`RuntimeInfo`], and rebuilds a failed/stopped generation on the next
//!   call, re-opening sessions via `session.open` on demand.
//! - **single emit point**: the pump thread (`host/event_pump.rs`) is the
//!   only place wire lines are emitted. Command-side lines (synthesized
//!   `TurnBegin`, prompt errors, approval echoes) are posted through a
//!   control channel and emitted by the pump, preserving per-session order.
//! - **session table / leases** (`host/session.rs`): open/close bookkeeping
//!   with ACP-verbatim `connection_id` lease semantics (acp.rs
//!   `connect_leased` / `disconnect_leased`), in-flight turn ids, pending
//!   approval/question tables, and the `session.config` snapshot cache.
//!
//! Wave 0 only registers the host as Tauri state; the ACP managers stay
//! managed and the production command rewiring lands in W1.

mod event_pump;
mod session;
mod spawn;

use self::session::{
    lease_allows_disconnect, lock, now_ms, post_control, slot_serves_connect, turn_failed_payload,
    ControlMessage, HostShared, SessionStatusProjection,
};
use self::spawn::{resolve_spawn_config, validate_node_version};
use super::client::{
    ApprovalDecision, ApprovalRespondParams, QuestionRespondParams, RuntimeClient,
    TurnCancelParams, TurnStartParams, TurnStartResult,
};
use super::protocol::{HelloParams, RuntimeInfo};
use super::readiness;
use super::supervisor::{HandshakeConfig, RuntimeSupervisor, ShutdownConfig, SupervisorState};
use super::translate::{synthesize_approval_resolved, synthesize_turn_begin, WireTranslator};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::AppHandle;

/// Kimi source commit pinned by the M0 freeze. Kept in lockstep with
/// `runtime/UPSTREAM.md`; `release:preflight` will verify the match.
pub const EXPECTED_KIMI_COMMIT: &str = "53c832dfdf9566afd59a8b3d54ebd36d3cb03d72";

/// Timeout for request/response runtime calls (open/close/turns/responds).
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Covers the hello response and the trailing `runtime.ready` event.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// Bounded app-exit drain: generous for a transcript flush, short enough to
/// never block quitting on a wedged runtime (kill escalation follows).
const HOST_SHUTDOWN: ShutdownConfig = ShutdownConfig {
    response_timeout: Duration::from_secs(5),
    exit_timeout: Duration::from_secs(5),
};

/// Destination for translated wire message lines. Production emits Tauri
/// `wire:message` events; tests capture into a Vec. Shared behind `Arc` so
/// the pump thread and the host see one sink.
pub trait WireSink: Send + Sync + 'static {
    fn emit(&self, session_id: &str, message: String);
}

/// Production sink: `wire:message` over the Tauri event bridge. The host is
/// `.manage`d before the app exists, so the handle arrives later via
/// `install_app` (the first command handler installs it).
#[derive(Default)]
struct AppEventSink {
    app: Mutex<Option<AppHandle>>,
}

impl AppEventSink {
    fn install(&self, app: &AppHandle) {
        *lock(&self.app) = Some(app.clone());
    }
}

impl WireSink for AppEventSink {
    fn emit(&self, session_id: &str, message: String) {
        let guard = lock(&self.app);
        match guard.as_ref() {
            Some(app) => crate::wire_events::emit_wire_message(app, session_id, message),
            // Unreachable in practice (the runtime only starts from commands,
            // which install the handle first); never lose the line silently.
            None => eprintln!(
                "[runtime] dropping wire line for `{session_id}`: app handle not installed yet"
            ),
        }
    }
}

/// Host emit target: the Tauri bridge in production, an injected sink in tests.
enum Sink {
    App(AppEventSink),
    Custom(Arc<dyn WireSink>),
}

impl Sink {
    fn emit(&self, session_id: &str, message: String) {
        match self {
            Self::App(sink) => sink.emit(session_id, message),
            Self::Custom(sink) => sink.emit(session_id, message),
        }
    }

    fn install_app(&self, app: &AppHandle) {
        if let Self::App(sink) = self {
            sink.install(app);
        }
    }
}

/// One supervisor generation: the child, its control channel, and its pump.
struct RuntimeGeneration {
    id: u64,
    supervisor: Arc<RuntimeSupervisor>,
    control_tx: mpsc::Sender<ControlMessage>,
    pump: Option<JoinHandle<()>>,
}

impl RuntimeGeneration {
    /// Join a self-terminated pump (rebuild path). Bounded by the pump's poll
    /// tick: the pump exits on its own once the supervisor is terminal.
    fn join_pump(mut self) {
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
    }

    /// Ask the pump to stop and join it (host shutdown path).
    fn stop_pump(mut self) {
        let _ = self.control_tx.send(ControlMessage::Stop);
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
    }
}

/// Tauri state singleton owning the desktop semantics of the source runtime.
pub struct RuntimeHost {
    shared: Arc<HostShared>,
    generation: Mutex<Option<RuntimeGeneration>>,
    runtime_info: Mutex<Option<RuntimeInfo>>,
}

impl Default for RuntimeHost {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeHost {
    /// Production host: wire lines are emitted as Tauri `wire:message` events
    /// once `install_app` delivers the handle.
    pub fn new() -> Self {
        let data_root =
            crate::runtime_check::kimi_code_home_dir().unwrap_or_else(|_| std::env::temp_dir());
        Self::with_parts(Sink::App(AppEventSink::default()), data_root)
    }

    /// Test host: wire lines go to the injected sink and the hello data root
    /// is a temp dir, so tests never touch the real `~/.kimi-code`.
    pub fn with_sink(sink: Arc<dyn WireSink>) -> Self {
        Self::with_parts(Sink::Custom(sink), std::env::temp_dir())
    }

    fn with_parts(sink: Sink, data_root: PathBuf) -> Self {
        Self {
            shared: Arc::new(HostShared {
                sink,
                sessions: Mutex::new(HashMap::new()),
                translator: Mutex::new(WireTranslator::new()),
                session_ops: Mutex::new(HashMap::new()),
                control_tx: Mutex::new(None),
                deferred: Mutex::new(Vec::new()),
                next_generation: AtomicU64::new(1),
                shutting_down: AtomicBool::new(false),
                data_root,
            }),
            generation: Mutex::new(None),
            runtime_info: Mutex::new(None),
        }
    }

    /// Install the app handle for the production emit path; idempotent.
    pub fn install_app(&self, app: &AppHandle) {
        self.shared.sink.install_app(app);
    }

    /// Handshake snapshot of the live generation (capabilities, versions).
    pub fn runtime_info(&self) -> Option<RuntimeInfo> {
        lock(&self.runtime_info).clone()
    }

    /// Lazily start (or rebuild) the runtime and return its supervisor.
    ///
    /// Ready generation -> reused. Failed/Stopped generation -> torn down
    /// (its pump marks every session error first) and replaced: artifact
    /// readiness gate, spawn, pinned-commit handshake, Node-version gate,
    /// then a new event pump. Sessions re-open lazily on their next use.
    pub fn ensure_started(&self) -> Result<Arc<RuntimeSupervisor>, String> {
        if self.shared.shutting_down.load(Ordering::SeqCst) {
            return Err("runtime host is shutting down".to_string());
        }
        // Held across the whole start/rebuild so concurrent callers cannot
        // spawn two runtimes (acp `connect_ops` serialization pattern).
        let mut guard = lock(&self.generation);
        if let Some(generation) = guard.as_ref() {
            match generation.supervisor.state() {
                SupervisorState::Ready => return Ok(Arc::clone(&generation.supervisor)),
                // A generation is only installed after its handshake, so this
                // is unreachable; fail noisily instead of rebuilding under a
                // healthy start.
                SupervisorState::Handshaking => {
                    return Err("runtime supervisor is mid-handshake; retry".to_string())
                }
                SupervisorState::NotStarted
                | SupervisorState::Stopping
                | SupervisorState::Stopped
                | SupervisorState::Failed => {}
            }
        }

        // Tear down the previous generation: drop the live control sender so
        // new control messages defer, then join the pump — on a Failed
        // supervisor it marks every session error before exiting, and the
        // join keeps that ahead of the new generation.
        lock(&self.shared.control_tx).take();
        if let Some(old) = guard.take() {
            old.join_pump();
        }

        let resolved = resolve_spawn_config();
        readiness::check_artifact(&resolved.entry)
            .map_err(|err| format!("runtime artifact not ready: {err}"))?;
        let supervisor = Arc::new(RuntimeSupervisor::new(resolved.config));
        supervisor
            .start()
            .map_err(|err| format!("runtime spawn failed: {err}"))?;
        let info = supervisor
            .handshake(&self.handshake_config())
            .map_err(|err| format!("runtime handshake failed: {err}"))?;
        // Dropping the uninstalled supervisor kills the child on the way out.
        validate_node_version(&info)?;
        let events = supervisor
            .take_event_receiver()
            .ok_or_else(|| "runtime event receiver already taken".to_string())?;
        let (control_tx, pump) =
            event_pump::spawn(Arc::clone(&self.shared), Arc::clone(&supervisor), events);
        *lock(&self.shared.control_tx) = Some(control_tx.clone());
        *lock(&self.runtime_info) = Some(info);
        *guard = Some(RuntimeGeneration {
            id: self.shared.next_generation.fetch_add(1, Ordering::SeqCst),
            supervisor: Arc::clone(&supervisor),
            control_tx,
            pump: Some(pump),
        });
        Ok(supervisor)
    }

    /// Best-effort, bounded shutdown for app exit (idempotent; also `Drop`).
    pub fn shutdown(&self) {
        self.shared.shutting_down.store(true, Ordering::SeqCst);
        lock(&self.shared.control_tx).take();
        let generation = lock(&self.generation).take();
        if let Some(generation) = generation {
            // Drain first so final events still reach the pump, then stop it.
            if let Err(err) = generation.supervisor.shutdown(&HOST_SHUTDOWN) {
                eprintln!("[runtime] shutdown drain failed: {err}");
            }
            generation.stop_pump();
        }
        *lock(&self.runtime_info) = None;
    }

    /// Open (or re-attach) a session under a frontend lease. Verbatim acp
    /// `connect_leased` semantics: an empty lease is rejected; a live,
    /// current-generation session simply takes the newest lease.
    pub fn connect_leased(&self, session_id: &str, connection_id: &str) -> Result<(), String> {
        if connection_id.trim().is_empty() {
            return Err("Missing connection id".to_string());
        }
        let op = self.session_op_lock(session_id);
        let _op_guard = lock(&op);
        let supervisor = self.ensure_started()?;
        let generation_id = self.current_generation_id()?;
        {
            let mut sessions = lock(&self.shared.sessions);
            if let Some(slot) = sessions.get_mut(session_id) {
                if slot_serves_connect(slot, generation_id) {
                    slot.connection_id = Some(connection_id.to_string());
                    return Ok(());
                }
            }
        }
        let client = RuntimeClient::new(&supervisor);
        client
            .session_open(session_id, CALL_TIMEOUT)
            .map_err(|err| format!("runtime session.open failed: {err}"))?;
        let mut sessions = lock(&self.shared.sessions);
        let slot = sessions.entry(session_id.to_string()).or_default();
        slot.open = true;
        slot.generation = generation_id;
        slot.connection_id = Some(connection_id.to_string());
        slot.status = SessionStatusProjection::connected(now_ms());
        Ok(())
    }

    /// Close a session, but only when the lease matches the current holder —
    /// a stale frontend must not disconnect a session a newer connection owns
    /// (acp `disconnect_leased` parity: mismatch or never-opened is a no-op).
    pub fn disconnect_leased(&self, session_id: &str, connection_id: &str) -> Result<(), String> {
        let op = self.session_op_lock(session_id);
        let _op_guard = lock(&op);
        if !lease_allows_disconnect(lock(&self.shared.sessions).get(session_id), connection_id) {
            return Ok(());
        }
        // Best-effort close on the current generation only: disconnect must
        // not resurrect a failed runtime just to say goodbye.
        let supervisor = {
            let guard = lock(&self.generation);
            guard
                .as_ref()
                .filter(|generation| generation.supervisor.state() == SupervisorState::Ready)
                .map(|generation| Arc::clone(&generation.supervisor))
        };
        if let Some(supervisor) = supervisor {
            let client = RuntimeClient::new(&supervisor);
            if let Err(err) = client.session_close(session_id, CALL_TIMEOUT) {
                eprintln!("[runtime] session.close for `{session_id}` during disconnect: {err}");
            }
        }
        lock(&self.shared.sessions).remove(session_id);
        post_control(
            &self.shared,
            ControlMessage::ForgetSession {
                session_id: session_id.to_string(),
            },
        );
        Ok(())
    }

    /// Start a turn. Registers the desktop-minted request id (busy check per
    /// acp `handle_prompt`), queues the synthesized `TurnBegin` BEFORE the
    /// request reaches the runtime, and synthesizes a `turn.failed` wire
    /// sequence when the runtime rejects the start (no terminal event exists
    /// for a turn that never began).
    pub fn start_turn(&self, params: TurnStartParams) -> Result<TurnStartResult, String> {
        let session_id = params.session_id.clone();
        let request_id = params.request_id.clone();
        let supervisor = self.ensure_session_live(&session_id)?;
        {
            let mut sessions = lock(&self.shared.sessions);
            let slot = sessions.get_mut(&session_id).ok_or_else(|| {
                format!("Runtime session `{session_id}` is not connected; call wire_connect first")
            })?;
            if !slot.in_flight.is_empty() {
                return Err(
                    "Session is busy; wait for completion before sending a new prompt.".to_string(),
                );
            }
            slot.in_flight.insert(request_id.clone());
        }
        let user_input = serde_json::to_value(&params.input)
            .map_err(|err| format!("turn input not serializable: {err}"))?;
        post_control(
            &self.shared,
            ControlMessage::EmitWire {
                session_id: session_id.clone(),
                message: synthesize_turn_begin(&request_id, user_input),
            },
        );
        let client = RuntimeClient::new(&supervisor);
        match client.turn_start(&params, CALL_TIMEOUT) {
            Ok(result) => Ok(result),
            Err(err) => {
                if let Some(slot) = lock(&self.shared.sessions).get_mut(&session_id) {
                    slot.in_flight.remove(&request_id);
                }
                post_control(
                    &self.shared,
                    ControlMessage::Synthesize {
                        session_id: session_id.clone(),
                        event: "turn.failed".to_string(),
                        payload: turn_failed_payload(&request_id, &err),
                    },
                );
                Err(format!("runtime turn.start failed: {err}"))
            }
        }
    }

    /// Cancel one in-flight turn (or every in-flight turn when `request_id`
    /// is `None`). Returns the cancelled request ids; an idle session is a
    /// no-op (acp `handle_cancel` parity).
    pub fn cancel_turn(
        &self,
        session_id: &str,
        request_id: Option<&str>,
    ) -> Result<Vec<String>, String> {
        let supervisor = self.ensure_session_live(session_id)?;
        let targets: Vec<String> = {
            let sessions = lock(&self.shared.sessions);
            sessions
                .get(session_id)
                .map(|slot| {
                    slot.in_flight
                        .iter()
                        .filter(|id| request_id.map_or(true, |want| id.as_str() == want))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default()
        };
        if let Some(want) = request_id {
            if targets.is_empty() {
                return Err(format!(
                    "No in-flight turn `{want}` for runtime session `{session_id}`"
                ));
            }
        }
        let mut cancelled = Vec::new();
        for id in targets {
            let client = RuntimeClient::new(&supervisor);
            client
                .turn_cancel(
                    &TurnCancelParams {
                        session_id: session_id.to_string(),
                        request_id: id.clone(),
                    },
                    CALL_TIMEOUT,
                )
                .map_err(|err| format!("runtime turn.cancel failed: {err}"))?;
            if let Some(slot) = lock(&self.shared.sessions).get_mut(session_id) {
                slot.in_flight.remove(&id);
            }
            cancelled.push(id);
        }
        Ok(cancelled)
    }

    /// Answer a pending approval and queue the `ApprovalRequestResolved` echo
    /// (runtime-v1 has no resolution event). A stale/duplicate approval id is
    /// tolerated as a no-op, matching acp `handle_permission_response`.
    pub fn respond_approval(&self, params: ApprovalRespondParams) -> Result<(), String> {
        let session_id = params.session_id.clone();
        let approval_id = params.approval_id.clone();
        let supervisor = self.ensure_session_live(&session_id)?;
        let known = lock(&self.shared.sessions)
            .get_mut(&session_id)
            .is_some_and(|slot| slot.pending_approvals.remove(&approval_id));
        if !known {
            return Ok(());
        }
        let client = RuntimeClient::new(&supervisor);
        client
            .approval_respond(&params, CALL_TIMEOUT)
            .map_err(|err| format!("runtime approval.respond failed: {err}"))?;
        let decision = match params.decision {
            ApprovalDecision::Approved => "approved",
            ApprovalDecision::Rejected => "rejected",
            ApprovalDecision::Cancelled => "cancelled",
        };
        post_control(
            &self.shared,
            ControlMessage::EmitWire {
                session_id,
                message: synthesize_approval_resolved(&approval_id, decision),
            },
        );
        Ok(())
    }

    /// Answer a pending question. Unlike approvals, an unknown question id is
    /// an error — the acp desktop hangs the turn otherwise
    /// (`handle_permission_response` question branch).
    pub fn respond_question(&self, params: QuestionRespondParams) -> Result<(), String> {
        let session_id = params.session_id.clone();
        let question_id = params.question_id.clone();
        let supervisor = self.ensure_session_live(&session_id)?;
        let known = lock(&self.shared.sessions)
            .get_mut(&session_id)
            .is_some_and(|slot| slot.pending_questions.remove(&question_id));
        if !known {
            return Err(format!(
                "No pending runtime request for question response id `{question_id}`"
            ));
        }
        let client = RuntimeClient::new(&supervisor);
        client
            .question_respond(&params, CALL_TIMEOUT)
            .map_err(|err| format!("runtime question.respond failed: {err}"))?;
        Ok(())
    }

    /// Ready supervisor + live session: rebuilds a failed runtime and
    /// re-opens the session when it belongs to an older generation (lazy
    /// recovery); a never-connected session is rejected (acp `send` parity).
    fn ensure_session_live(&self, session_id: &str) -> Result<Arc<RuntimeSupervisor>, String> {
        let op = self.session_op_lock(session_id);
        let _op_guard = lock(&op);
        let supervisor = self.ensure_started()?;
        let generation_id = self.current_generation_id()?;
        let needs_reopen = {
            let sessions = lock(&self.shared.sessions);
            match sessions.get(session_id) {
                Some(slot) if slot.open && slot.generation == generation_id => false,
                Some(slot) if slot.open => true,
                _ => {
                    return Err(format!(
                        "Runtime session `{session_id}` is not connected; call wire_connect first"
                    ))
                }
            }
        };
        if needs_reopen {
            let client = RuntimeClient::new(&supervisor);
            client
                .session_open(session_id, CALL_TIMEOUT)
                .map_err(|err| format!("runtime session.open (recovery) failed: {err}"))?;
            if let Some(slot) = lock(&self.shared.sessions).get_mut(session_id) {
                slot.generation = generation_id;
                slot.status = SessionStatusProjection::connected(now_ms());
            }
        }
        Ok(supervisor)
    }

    fn current_generation_id(&self) -> Result<u64, String> {
        lock(&self.generation)
            .as_ref()
            .map(|generation| generation.id)
            .ok_or_else(|| "runtime is not started".to_string())
    }

    fn session_op_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut ops = lock(&self.shared.session_ops);
        Arc::clone(
            ops.entry(session_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    }

    fn handshake_config(&self) -> HandshakeConfig {
        HandshakeConfig {
            hello: HelloParams::new(
                env!("CARGO_PKG_VERSION"),
                self.shared.data_root.to_string_lossy(),
                std::env::consts::OS,
                std::env::consts::ARCH,
                "en-US",
            ),
            expected_commit: Some(EXPECTED_KIMI_COMMIT.to_string()),
            timeout: HANDSHAKE_TIMEOUT,
        }
    }
}

impl Drop for RuntimeHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}
