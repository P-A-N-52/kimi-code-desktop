//! The runtime event pump: the single point where runtime-v1 event frames
//! and desktop-originated control messages become wire lines.
//!
//! One pump thread per supervisor generation. It consumes the supervisor's
//! event stream, projects the session table (`session.status` -> status,
//! `approval/question.requested` -> pending tables, `session.config` ->
//! snapshot, turn terminals -> in-flight removal), translates via the shared
//! [`WireTranslator`], and emits through the host sink. Command-side lines
//! arrive over the control channel and are drained ahead of each event, so a
//! synthesized `TurnBegin` always precedes its turn's first runtime event.
//!
//! Terminal handling: a `Failed` supervisor marks every session error
//! (synthesized `turn.failed` per in-flight turn, then `session.status`
//! error — the same translate -> emit path as real events) before the pump
//! exits; the next `ensure_started` joins this thread before rebuilding.

use super::session::{lock, now_ms, ControlMessage, HostShared};
use crate::runtime::protocol::EventFrame;
use crate::runtime::supervisor::{RuntimeSupervisor, SupervisorState};
use serde_json::{json, Value};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Idle tick; bounds Stop/fail-closed detection and control-message latency.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Spawn the pump for one generation. Returns the control channel sender
/// (installed by the host) and the thread handle.
pub(super) fn spawn(
    shared: Arc<HostShared>,
    supervisor: Arc<RuntimeSupervisor>,
    events: mpsc::Receiver<EventFrame>,
) -> (mpsc::Sender<ControlMessage>, JoinHandle<()>) {
    let (control_tx, control_rx) = mpsc::channel();
    let handle = thread::spawn(move || run(&shared, &supervisor, &events, &control_rx));
    (control_tx, handle)
}

#[derive(PartialEq, Eq)]
enum Flow {
    Continue,
    Stop,
}

fn run(
    shared: &HostShared,
    supervisor: &Arc<RuntimeSupervisor>,
    events: &mpsc::Receiver<EventFrame>,
    control_rx: &mpsc::Receiver<ControlMessage>,
) {
    // Deferred messages predate this generation; they go first.
    let deferred = std::mem::take(&mut *lock(&shared.deferred));
    for message in deferred {
        if handle_control(shared, message) == Flow::Stop {
            return;
        }
    }
    loop {
        if drain_control(shared, control_rx) == Flow::Stop {
            return;
        }
        match events.recv_timeout(POLL_INTERVAL) {
            Ok(frame) => {
                // Control queued before the runtime produced this frame must
                // win (TurnBegin ordering), even when the pump was parked in
                // `recv_timeout` while both arrived.
                if drain_control(shared, control_rx) == Flow::Stop {
                    return;
                }
                handle_event(shared, &frame);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => match supervisor.state() {
                SupervisorState::Failed => {
                    fail_all_sessions(shared, supervisor);
                    drain_control(shared, control_rx);
                    return;
                }
                // Stopped is the host-shutdown path; sessions were closed by
                // the drain, so only queued control lines still go out.
                SupervisorState::Stopped => {
                    drain_control(shared, control_rx);
                    return;
                }
                _ => {}
            },
            // The host dropped the supervisor mid-rebuild; nothing more can
            // arrive. Any later control message defers to the next generation.
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Emit every queued control message; `Stop` ends the pump after the rest of
/// the queue is flushed (no line is lost behind a Stop).
fn drain_control(shared: &HostShared, control_rx: &mpsc::Receiver<ControlMessage>) -> Flow {
    while let Ok(message) = control_rx.try_recv() {
        let stop = matches!(message, ControlMessage::Stop);
        if !stop {
            handle_control(shared, message);
        }
        if stop {
            while let Ok(rest) = control_rx.try_recv() {
                handle_control(shared, rest);
            }
            return Flow::Stop;
        }
    }
    Flow::Continue
}

fn handle_control(shared: &HostShared, message: ControlMessage) -> Flow {
    match message {
        ControlMessage::EmitWire {
            session_id,
            message,
        } => {
            shared.sink.emit(&session_id, message);
            Flow::Continue
        }
        // Desktop-originated facts wear the runtime-v1 event shape so they
        // flow through the same projection + translation as real events.
        ControlMessage::Synthesize {
            session_id,
            event,
            payload,
        } => {
            handle_event(
                shared,
                &EventFrame::Session {
                    session_id,
                    seq: 0,
                    event,
                    payload,
                },
            );
            Flow::Continue
        }
        ControlMessage::ForgetSession { session_id } => {
            lock(&shared.translator).forget_session(&session_id);
            Flow::Continue
        }
        ControlMessage::Stop => Flow::Stop,
    }
}

/// Project one frame into the session table, then translate and emit it.
fn handle_event(shared: &HostShared, frame: &EventFrame) {
    project_frame(shared, frame);
    let lines = lock(&shared.translator).translate(frame);
    match frame {
        EventFrame::Session { session_id, .. } => {
            for line in lines {
                shared.sink.emit(session_id, line);
            }
        }
        EventFrame::Runtime { event, .. } => {
            if lines.is_empty() {
                return;
            }
            // Runtime-scoped notices have no session of their own: broadcast
            // to every open session; with none open, keep them in the log.
            let open: Vec<String> = lock(&shared.sessions)
                .iter()
                .filter(|(_, slot)| slot.open)
                .map(|(session_id, _)| session_id.clone())
                .collect();
            if open.is_empty() {
                for line in &lines {
                    eprintln!("[runtime] `{event}` with no open session: {line}");
                }
            } else {
                for session_id in &open {
                    for line in &lines {
                        shared.sink.emit(session_id, line.clone());
                    }
                }
            }
        }
    }
}

/// Session-table projection. Events for a session the desktop never opened
/// still get an observed slot (`open` stays false): replay bursts and
/// post-rebuild traffic must not lose their status/config projection, and
/// leased operations ignore observed-only slots.
fn project_frame(shared: &HostShared, frame: &EventFrame) {
    let EventFrame::Session {
        session_id,
        event,
        payload,
        ..
    } = frame
    else {
        return;
    };
    let mut sessions = lock(&shared.sessions);
    let slot = sessions.entry(session_id.clone()).or_default();
    match event.as_str() {
        "session.status" => {
            slot.status.state = payload
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("idle")
                .to_string();
            slot.status.reason = payload
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string);
            slot.status.detail = payload
                .get("detail")
                .and_then(Value::as_str)
                .map(str::to_string);
            slot.status.seq += 1;
            slot.status.updated_at_ms = now_ms();
        }
        "approval.requested" => {
            if let Some(id) = payload.get("approvalId").and_then(Value::as_str) {
                slot.pending_approvals.insert(id.to_string());
            }
        }
        "question.requested" => {
            if let Some(id) = payload.get("questionId").and_then(Value::as_str) {
                slot.pending_questions.insert(id.to_string());
            }
        }
        "session.config" => {
            slot.config_snapshot = Some(payload.clone());
        }
        // Turn terminals imply a wire status change (turn.rs emits it with
        // the terminal sequence); mirror it so `wire_status` stays in step
        // with what the UI saw. runtime-v1 has no turn.cancelled: cancelled
        // turns arrive as turn.failed with code `cancelled`.
        "turn.completed" => {
            if let Some(id) = payload.get("requestId").and_then(Value::as_str) {
                slot.in_flight.remove(id);
            }
            slot.status.state = "idle".to_string();
            slot.status.reason = Some("finished".to_string());
            slot.status.detail = None;
            slot.status.seq += 1;
            slot.status.updated_at_ms = now_ms();
        }
        "turn.failed" => {
            if let Some(id) = payload.get("requestId").and_then(Value::as_str) {
                slot.in_flight.remove(id);
            }
            let error = payload.get("error").filter(|error| error.is_object());
            let code = error
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("turn_failed");
            if code == "cancelled" {
                slot.status.state = "idle".to_string();
                slot.status.reason = Some("cancelled".to_string());
                slot.status.detail = None;
            } else {
                slot.status.state = "error".to_string();
                slot.status.reason = Some(code.to_string());
                slot.status.detail = error
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            slot.status.seq += 1;
            slot.status.updated_at_ms = now_ms();
        }
        _ => {}
    }
}

/// Fail-closed: every session with visible state gets a synthesized
/// `turn.failed` per in-flight turn (prompt error) followed by a
/// `session.status` error (status strip + always-visible notice), all through
/// the standard translate -> emit path. Pending tables clear afterwards —
/// the dead runtime cannot serve their responses.
fn fail_all_sessions(shared: &HostShared, supervisor: &RuntimeSupervisor) {
    let fault = supervisor
        .fault()
        .map(|err| err.to_string())
        .unwrap_or_else(|| "runtime failed".to_string());
    let targets: Vec<(String, Vec<String>)> = lock(&shared.sessions)
        .iter()
        .filter(|(_, slot)| slot.status.state != "error" || !slot.in_flight.is_empty())
        .map(|(session_id, slot)| (session_id.clone(), slot.in_flight.iter().cloned().collect()))
        .collect();
    for (session_id, in_flight) in targets {
        for request_id in in_flight {
            handle_event(
                shared,
                &EventFrame::Session {
                    session_id: session_id.clone(),
                    seq: 0,
                    event: "turn.failed".to_string(),
                    payload: json!({
                        "requestId": request_id,
                        "error": {
                            "code": "runtime_failed",
                            "message": fault,
                            "retryable": true,
                        },
                    }),
                },
            );
        }
        handle_event(
            shared,
            &EventFrame::Session {
                session_id: session_id.clone(),
                seq: 0,
                event: "session.status".to_string(),
                payload: json!({
                    "state": "error",
                    "reason": "runtime_failed",
                    "detail": fault,
                }),
            },
        );
    }
    let mut sessions = lock(&shared.sessions);
    for slot in sessions.values_mut() {
        slot.in_flight.clear();
        slot.pending_approvals.clear();
        slot.pending_questions.clear();
    }
}
