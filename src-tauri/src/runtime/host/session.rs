//! Session-table model shared by the host and its event pump.
//!
//! Split out of `host.rs` to keep each file under the 600-line module
//! budget. Owns the per-session projection (`SessionSlot`), the ACP-verbatim
//! lease helpers, the pump control channel types, and the desktop-originated
//! `turn.failed` payload synthesis.

use super::Sink;
use crate::runtime::supervisor::RuntimeError;
use crate::runtime::translate::WireTranslator;
use crate::wire_events::{RuntimeStatus, WorkerStatusView};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// Poison-tolerant mutex acquisition, mirroring the supervisor's helper.
pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Last projected `session.status` for one session (drives `wire_status`).
pub(super) struct SessionStatusProjection {
    pub state: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub updated_at_ms: u64,
    /// Host-local monotonic counter, bumped per projected status.
    pub seq: u64,
}

impl Default for SessionStatusProjection {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            reason: None,
            detail: None,
            updated_at_ms: 0,
            seq: 0,
        }
    }
}

impl SessionStatusProjection {
    pub(super) fn connected(updated_at_ms: u64) -> Self {
        Self {
            state: "idle".to_string(),
            reason: Some("runtime_connected".to_string()),
            detail: None,
            updated_at_ms,
            seq: 0,
        }
    }
}

/// Desktop-side projection of one runtime session.
#[derive(Default)]
pub(super) struct SessionSlot {
    /// Current frontend lease (the `wire_connect` connection id).
    pub connection_id: Option<String>,
    /// Explicitly opened via `session.open`; false for slots observed only
    /// from runtime events (replay bursts, post-rebuild traffic).
    pub open: bool,
    /// Runtime generation the session was opened on; a mismatch forces a
    /// re-open (lazy recovery after a fail-closed rebuild).
    pub generation: u64,
    pub status: SessionStatusProjection,
    /// In-flight desktop-minted turn ids (`turn.start` accepted, no terminal).
    pub in_flight: HashSet<String>,
    pub pending_approvals: HashSet<String>,
    pub pending_questions: HashSet<String>,
    /// Last raw `session.config` payload (config-state cache).
    pub config_snapshot: Option<Value>,
}

/// acp `connect_with_lease` parity: an already-open, current-generation,
/// non-error slot serves a connect without a fresh `session.open`.
pub(super) fn slot_serves_connect(slot: &SessionSlot, generation: u64) -> bool {
    slot.open && slot.generation == generation && slot.status.state != "error"
}

/// acp `disconnect_leased` parity: only the current lease holder may close.
pub(super) fn lease_allows_disconnect(slot: Option<&SessionSlot>, connection_id: &str) -> bool {
    slot.is_some_and(|slot| slot.open && slot.connection_id.as_deref() == Some(connection_id))
}

/// Command-side message for the pump thread. All wire emission — including
/// desktop-originated lines — funnels through these so the pump stays the
/// single, order-preserving emit point.
pub(super) enum ControlMessage {
    /// Pre-built wire line (synthesized `TurnBegin` / `ApprovalRequestResolved`).
    EmitWire { session_id: String, message: String },
    /// Desktop-originated fact in runtime-v1 event shape (e.g. `turn.failed`
    /// for a rejected `turn.start`); routed through the translator so the
    /// per-session wire seq stays consistent with runtime-originated lines.
    Synthesize {
        session_id: String,
        event: String,
        payload: Value,
    },
    /// Drop translator state for a removed session.
    ForgetSession { session_id: String },
    /// Pump exits (host shutdown).
    Stop,
}

/// Everything the pump thread shares with the host.
pub(super) struct HostShared {
    pub sink: Sink,
    pub sessions: Mutex<HashMap<String, SessionSlot>>,
    pub translator: Mutex<WireTranslator>,
    /// Per-session op serialization (connect/open/turn sequences), the acp
    /// `connect_ops` pattern on std mutexes.
    pub session_ops: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Live generation's control channel; `None` during a rebuild window.
    pub control_tx: Mutex<Option<mpsc::Sender<ControlMessage>>>,
    /// Control messages posted while no pump was alive; the next generation's
    /// pump drains them before anything newer.
    pub deferred: Mutex<Vec<ControlMessage>>,
    pub next_generation: AtomicU64,
    pub shutting_down: AtomicBool,
    /// Hello `dataRoot` (the `~/.kimi-code` data dir in production).
    pub data_root: PathBuf,
}

/// Post a control message to the live pump; falls back to the deferred queue
/// when the send fails or no generation is installed (mid-rebuild window).
pub(super) fn post_control(shared: &HostShared, message: ControlMessage) {
    let mut message = Some(message);
    {
        let guard = lock(&shared.control_tx);
        if let (Some(tx), Some(msg)) = (guard.as_ref(), message.take()) {
            match tx.send(msg) {
                Ok(()) => return,
                Err(mpsc::SendError(returned)) => message = Some(returned),
            }
        }
    }
    if let Some(message) = message {
        lock(&shared.deferred).push(message);
    }
}

/// `turn.failed` payload for a turn the runtime never accepted (no runtime
/// terminal event will exist for it). Rejections keep their structured
/// code/message/retryable; fatal supervisor errors map to a retryable
/// `runtime_unavailable`.
pub(super) fn turn_failed_payload(request_id: &str, err: &RuntimeError) -> Value {
    let (code, message, retryable) = match err {
        RuntimeError::Rejected(body) => (body.code.clone(), body.message.clone(), body.retryable),
        fatal => ("runtime_unavailable".to_string(), fatal.to_string(), true),
    };
    json!({
        "requestId": request_id,
        "error": { "code": code, "message": message, "retryable": retryable },
    })
}

/// Read-only projections of the session table for the status/list commands
/// and for tests. Lives here so `host.rs` stays under the line budget.
impl super::RuntimeHost {
    /// `wire_status` projection for one session.
    pub fn session_status(&self, session_id: &str) -> Option<RuntimeStatus> {
        let sessions = lock(&self.shared.sessions);
        let slot = sessions.get(session_id)?;
        Some(RuntimeStatus {
            session_id: session_id.to_string(),
            state: slot.status.state.clone(),
            seq: slot.status.seq,
            worker_id: Some("runtime".to_string()),
            reason: slot.status.reason.clone(),
            detail: slot.status.detail.clone(),
            updated_at: slot.status.updated_at_ms,
        })
    }

    /// `wire_list_workers` projection: open sessions only, sorted by id.
    pub fn list_workers(&self) -> Vec<WorkerStatusView> {
        let sessions = lock(&self.shared.sessions);
        let mut views: Vec<WorkerStatusView> = sessions
            .iter()
            .filter(|(_, slot)| slot.open)
            .map(|(session_id, slot)| WorkerStatusView {
                session_id: session_id.clone(),
                state: slot.status.state.clone(),
                connection_id: slot.connection_id.clone(),
                updated_at: slot.status.updated_at_ms,
            })
            .collect();
        views.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        views
    }

    /// Whether the session was explicitly opened on the live generation.
    pub fn is_session_open(&self, session_id: &str) -> bool {
        lock(&self.shared.sessions)
            .get(session_id)
            .is_some_and(|slot| slot.open)
    }

    /// In-flight turn request ids for one session (sorted, for assertions).
    pub fn in_flight_turns(&self, session_id: &str) -> Vec<String> {
        let sessions = lock(&self.shared.sessions);
        let mut ids: Vec<String> = sessions
            .get(session_id)
            .map(|slot| slot.in_flight.iter().cloned().collect())
            .unwrap_or_default();
        ids.sort();
        ids
    }

    /// Last `session.config` payload observed for the session.
    pub fn session_config_snapshot(&self, session_id: &str) -> Option<Value> {
        lock(&self.shared.sessions)
            .get(session_id)
            .and_then(|slot| slot.config_snapshot.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::protocol::ErrorBody;
    #[test]
    fn turn_failed_payload_maps_rejected_and_fatal_errors() {
        let rejected = turn_failed_payload(
            "req-1",
            &RuntimeError::Rejected(ErrorBody {
                code: "session_busy".to_string(),
                message: "busy".to_string(),
                retryable: false,
                details: None,
            }),
        );
        assert_eq!(rejected["requestId"], json!("req-1"));
        assert_eq!(rejected["error"]["code"], json!("session_busy"));
        assert_eq!(rejected["error"]["retryable"], json!(false));

        let fatal = turn_failed_payload("req-2", &RuntimeError::Timeout("boom"));
        assert_eq!(fatal["error"]["code"], json!("runtime_unavailable"));
        assert_eq!(fatal["error"]["retryable"], json!(true));
        assert!(fatal["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("boom"));
    }

    #[test]
    fn lease_helpers_match_acp_semantics() {
        let mut slot = SessionSlot {
            open: true,
            generation: 2,
            connection_id: Some("conn-1".to_string()),
            ..SessionSlot::default()
        };
        assert!(slot_serves_connect(&slot, 2));
        assert!(!slot_serves_connect(&slot, 3), "stale generation re-opens");
        slot.status.state = "error".to_string();
        assert!(!slot_serves_connect(&slot, 2), "error slot re-opens");
        slot.status.state = "idle".to_string();
        slot.open = false;
        assert!(
            !slot_serves_connect(&slot, 2),
            "observed-only slot re-opens"
        );

        assert!(!lease_allows_disconnect(Some(&slot), "conn-1"));
        slot.open = true;
        assert!(lease_allows_disconnect(Some(&slot), "conn-1"));
        assert!(!lease_allows_disconnect(Some(&slot), "conn-stale"));
        assert!(!lease_allows_disconnect(None, "conn-1"));
    }
}
