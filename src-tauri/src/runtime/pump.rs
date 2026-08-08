//! Internal plumbing of the runtime supervisor: the stdout/stderr pump
//! threads, response routing into the pending table, and the fail-closed
//! fault path. Everything here is crate-private; the public surface lives in
//! `supervisor.rs`.

use super::codec::{FrameDecoder, FrameReadError};
use super::protocol::{EventFrame, OutputFrame, ResponseFrame, EVENT_READY};
use super::supervisor::{RuntimeError, Shared, SupervisorState};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{ChildStderr, ChildStdout, ExitStatus};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Bounded window of settled request ids used to classify late/duplicate
/// responses, mirroring the runtime's recent-request-id window.
const SETTLED_ID_WINDOW: usize = 4096;

pub(crate) type PendingResult = Result<Value, RuntimeError>;
pub(crate) type PendingTable = HashMap<String, mpsc::Sender<PendingResult>>;

/// Poison-tolerant mutex acquisition: a poisoned lock still yields its data.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Why a request id left the pending table; decides how a late response
/// for that id is classified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SettledKind {
    /// A response was already delivered — a second one is a duplicate.
    Completed,
    /// The caller gave up waiting — a late response is dropped quietly.
    TimedOut,
    /// The supervisor faulted — a late response is dropped quietly.
    Faulted,
}

/// Bounded FIFO record of settled request ids.
#[derive(Default)]
pub(crate) struct SettledIds {
    kinds: HashMap<String, SettledKind>,
    order: VecDeque<String>,
}

impl SettledIds {
    pub(crate) fn record(&mut self, id: String, kind: SettledKind) {
        if self.kinds.insert(id.clone(), kind).is_none() {
            self.order.push_back(id);
        }
        while self.order.len() > SETTLED_ID_WINDOW {
            if let Some(oldest) = self.order.pop_front() {
                self.kinds.remove(&oldest);
            }
        }
    }

    fn kind(&self, id: &str) -> Option<SettledKind> {
        self.kinds.get(id).copied()
    }
}

/// Route a response to its pending request. Unknown/duplicate ids are
/// contract violations and fail the runtime closed.
fn route_response(shared: &Shared, response: ResponseFrame) -> Result<(), RuntimeError> {
    let (id, outcome) = match response {
        ResponseFrame::Ok { id, result } => (id, Ok(result)),
        ResponseFrame::Err { id, error } => (id, Err(RuntimeError::Rejected(error))),
    };
    let sender = lock(&shared.pending).remove(&id);
    match sender {
        Some(tx) => {
            lock(&shared.settled).record(id, SettledKind::Completed);
            // A timed-out caller dropped its receiver; delivery failure is benign.
            let _ = tx.send(outcome);
            Ok(())
        }
        None => match lock(&shared.settled).kind(&id) {
            Some(SettledKind::TimedOut | SettledKind::Faulted) => Ok(()),
            Some(SettledKind::Completed) => Err(RuntimeError::DuplicateResponseId(id)),
            None => Err(RuntimeError::UnknownResponseId(id)),
        },
    }
}

/// stdout pump: decode frames, route responses to the pending table and
/// events to the sink, reap the child at EOF, and fail closed on any
/// protocol fault or on an exit the supervisor did not ask for.
pub(crate) fn run_stdout_pump(shared: Arc<Shared>, stdout: ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let decoder = FrameDecoder::new(shared.options.max_frame_bytes);
    let mut fatal: Option<RuntimeError> = None;
    loop {
        match decoder.read_frame(&mut reader) {
            Ok(Some(OutputFrame::Response(response))) => {
                if let Err(err) = route_response(&shared, response) {
                    fatal = Some(err);
                    break;
                }
            }
            Ok(Some(OutputFrame::Event(event))) => {
                if matches!(&event, EventFrame::Runtime { event, .. } if event == EVENT_READY) {
                    *lock(&shared.ready.0) = true;
                    shared.ready.1.notify_all();
                }
                // Events are droppable until a consumer takes the receiver.
                let _ = shared.events_tx.send(event);
            }
            Ok(None) => break,
            Err(FrameReadError::Fault(fault)) => {
                fatal = Some(RuntimeError::Protocol(fault));
                break;
            }
            Err(FrameReadError::Io(err)) => {
                fatal = Some(RuntimeError::Io(format!(
                    "runtime stdout read failed: {err}"
                )));
                break;
            }
        }
    }
    // A protocol fault fails closed BEFORE the reap: fail_closed kills the
    // child, so the `wait` below cannot block on a still-running process.
    if let Some(err) = &fatal {
        fail_closed(&shared, err.clone());
    }
    // Reap the child so the exit status is always recorded.
    let status = {
        let mut child_guard = lock(&shared.child);
        child_guard.as_mut().and_then(|child| child.wait().ok())
    };
    if let Some(status) = status {
        *lock(&shared.exit.0) = Some(status);
        shared.exit.1.notify_all();
    }
    if fatal.is_none() {
        let code = status.and_then(|s| s.code());
        if matches!(
            *lock(&shared.state),
            SupervisorState::Handshaking | SupervisorState::Ready
        ) {
            fail_closed(&shared, RuntimeError::UnexpectedExit { code });
        } else {
            // Expected shutdown path: no response can arrive after EOF, so
            // any still-pending request is dead.
            settle_all_pending(shared.as_ref(), RuntimeError::UnexpectedExit { code });
        }
    }
}

/// stderr pump: diagnostics only, never faults the supervisor.
pub(crate) fn run_stderr_pump(shared: Arc<Shared>, stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let trimmed = line.trim_end_matches(['\r', '\n']);
                let mut ring = lock(&shared.stderr_ring);
                if ring.len() >= shared.options.stderr_ring_lines {
                    ring.pop_front();
                }
                ring.push_back(trimmed.to_string());
            }
        }
    }
}

/// Settle every pending request with `err` and forget their ids as faulted.
fn settle_all_pending(shared: &Shared, err: RuntimeError) {
    let senders: Vec<(String, mpsc::Sender<PendingResult>)> =
        lock(&shared.pending).drain().collect();
    let mut settled = lock(&shared.settled);
    for (id, tx) in senders {
        let _ = tx.send(Err(err.clone()));
        settled.record(id, SettledKind::Faulted);
    }
}

/// Fail closed, first fault wins: record the fault, move to `Failed`, kill
/// the child, close stdin, and settle all pending requests with the fault.
pub(crate) fn fail_closed(shared: &Shared, err: RuntimeError) {
    {
        let mut state = lock(&shared.state);
        if matches!(*state, SupervisorState::Failed | SupervisorState::Stopped) {
            return;
        }
        *state = SupervisorState::Failed;
    }
    *lock(&shared.fault) = Some(err.clone());
    // Wake a handshake blocked in `await_ready` so it observes the state.
    shared.ready.1.notify_all();
    kill_child(shared);
    drop(lock(&shared.stdin).take());
    settle_all_pending(shared, err);
}

/// Record a fault and move to `Failed` without touching anything else; used
/// by the shutdown path, which already owns the surrounding teardown.
pub(crate) fn record_fault_if_live(shared: &Shared, err: RuntimeError) {
    let mut state = lock(&shared.state);
    if matches!(*state, SupervisorState::Failed | SupervisorState::Stopped) {
        return;
    }
    *state = SupervisorState::Failed;
    drop(state);
    *lock(&shared.fault) = Some(err);
}

pub(crate) fn kill_child(shared: &Shared) {
    if let Some(child) = lock(&shared.child).as_mut() {
        let _ = child.kill();
    }
}

/// Wait for the pump to record the exit status, up to `timeout`.
pub(crate) fn await_exit(shared: &Shared, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    let mut guard = lock(&shared.exit.0);
    loop {
        if guard.is_some() {
            return *guard;
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let (next, _) = shared
            .exit
            .1
            .wait_timeout(guard, deadline - now)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard = next;
    }
}

#[cfg(test)]
mod tests {
    use super::super::supervisor::SupervisorOptions;
    use super::*;
    use std::process::ChildStdin;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Condvar, Mutex};

    fn bare_shared() -> Shared {
        let (events_tx, _events_rx) = mpsc::channel();
        Shared {
            state: Mutex::new(SupervisorState::Ready),
            fault: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            settled: Mutex::new(SettledIds::default()),
            stdin: Mutex::new(None::<ChildStdin>),
            child: Mutex::new(None),
            stderr_ring: Mutex::new(VecDeque::new()),
            events_tx,
            ready: (Mutex::new(false), Condvar::new()),
            exit: (Mutex::new(None), Condvar::new()),
            next_request_id: AtomicU64::new(1),
            options: SupervisorOptions::default(),
        }
    }

    #[test]
    fn settled_ids_classify_and_evict() {
        let mut ids = SettledIds::default();
        ids.record("a".to_string(), SettledKind::Completed);
        ids.record("b".to_string(), SettledKind::TimedOut);
        assert_eq!(ids.kind("a"), Some(SettledKind::Completed));
        assert_eq!(ids.kind("b"), Some(SettledKind::TimedOut));
        assert_eq!(ids.kind("c"), None);
        for index in 0..SETTLED_ID_WINDOW * 2 {
            ids.record(format!("id-{index}"), SettledKind::Faulted);
        }
        assert!(ids.order.len() <= SETTLED_ID_WINDOW);
        assert_eq!(ids.kind("a"), None);
    }

    #[test]
    fn route_response_rejects_duplicate_and_unknown_ids() {
        let shared = bare_shared();
        let (tx, rx) = mpsc::channel();
        lock(&shared.pending).insert("req-1".to_string(), tx);

        // First delivery settles the request.
        route_response(
            &shared,
            ResponseFrame::Ok {
                id: "req-1".to_string(),
                result: Value::Null,
            },
        )
        .unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap().is_ok());

        // A second response for the same id is a duplicate.
        let err = route_response(
            &shared,
            ResponseFrame::Ok {
                id: "req-1".to_string(),
                result: Value::Null,
            },
        )
        .unwrap_err();
        assert!(matches!(err, RuntimeError::DuplicateResponseId(_)));

        // A response for a never-seen id is unknown.
        let err = route_response(
            &shared,
            ResponseFrame::Ok {
                id: "req-ghost".to_string(),
                result: Value::Null,
            },
        )
        .unwrap_err();
        assert!(matches!(err, RuntimeError::UnknownResponseId(_)));
    }

    #[test]
    fn fail_closed_settles_pending_and_is_idempotent() {
        let shared = bare_shared();
        let (tx, rx) = mpsc::channel();
        lock(&shared.pending).insert("req-1".to_string(), tx);

        fail_closed(&shared, RuntimeError::Timeout("boom"));
        assert_eq!(*lock(&shared.state), SupervisorState::Failed);
        assert_eq!(*lock(&shared.fault), Some(RuntimeError::Timeout("boom")));
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Err(RuntimeError::Timeout(_))) => {}
            other => panic!("pending request was not settled with the fault: {other:?}"),
        }

        // First fault wins: a later fail_closed is a no-op.
        fail_closed(&shared, RuntimeError::Timeout("other"));
        assert_eq!(*lock(&shared.fault), Some(RuntimeError::Timeout("boom")));
    }
}
