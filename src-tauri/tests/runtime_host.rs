//! Integration tests for the M4 `RuntimeHost` against the deterministic node
//! fixture worker (`tests/fixtures/runtime-fixture-worker.mjs`), injected via
//! the `KIMI_RUNTIME_ENTRY` override.
//!
//! Every test skips with a note when `node` is not on PATH; the fixture is
//! pure node stdlib and never touches the network or `~/.kimi-code` (the
//! host's hello data root is a temp dir under `with_sink`). Env-mutating
//! tests serialize on a static lock and restore the env on drop.
//!
//! Fixture limitation: the worker implements no `session.open` / `turn.start`
//! business logic (they answer `method_not_found`), so leased-connect success
//! and happy-path turns are covered by the host unit tests / later waves;
//! here the rejection paths prove the plumbing.

use app_lib::runtime::client::{
    ApprovalDecision, ApprovalRespondParams, QuestionRespondParams, QuestionResult, RuntimeClient,
};
use app_lib::runtime::host::{RuntimeHost, WireSink, EXPECTED_KIMI_COMMIT};
use app_lib::runtime::supervisor::SupervisorState;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const WAIT_TIMEOUT: Duration = Duration::from_secs(15);

/// Serializes env-mutating tests inside this binary.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn node_on_path() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Returns false (after noting why) when the test cannot run.
fn node_or_skip(test: &str) -> bool {
    if node_on_path() {
        return true;
    }
    eprintln!("skipping {test}: `node` was not found on PATH");
    false
}

fn fixture_entry() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("runtime-fixture-worker.mjs")
        .to_string_lossy()
        .into_owned()
}

/// Sets env vars for the test duration and restores them on drop.
struct EnvGuard {
    saved: Vec<(String, Option<String>)>,
    _lock: MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn set(vars: &[(&str, &str)]) -> Self {
        let lock = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut saved = Vec::new();
        for (key, value) in vars {
            saved.push((key.to_string(), std::env::var(key).ok()));
            std::env::set_var(key, value);
        }
        Self { saved, _lock: lock }
    }

    fn remove(&self, key: &str) {
        std::env::remove_var(key);
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

/// Captured wire sink: every emitted line, in order, tagged by session.
#[derive(Default)]
struct CaptureSink {
    lines: Mutex<Vec<(String, String)>>,
}

impl WireSink for CaptureSink {
    fn emit(&self, session_id: &str, message: String) {
        lock(&self.lines).push((session_id.to_string(), message));
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl CaptureSink {
    fn snapshot(&self) -> Vec<(String, String)> {
        lock(&self.lines).clone()
    }

    /// Poll until at least `count` lines arrived; panics with context on timeout.
    fn wait_for(&self, count: usize, what: &str) -> Vec<(String, String)> {
        let deadline = Instant::now() + WAIT_TIMEOUT;
        loop {
            let lines = self.snapshot();
            if lines.len() >= count {
                return lines;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {count} wire lines ({what}); got {}",
                lines.len()
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

fn parsed(lines: &[(String, String)]) -> Vec<Value> {
    lines
        .iter()
        .map(|(_, line)| serde_json::from_str(line).expect("wire line is json"))
        .collect()
}

#[test]
fn ensure_started_handshakes_caches_info_and_shutdown_drains() {
    if !node_or_skip("runtime_host ensure_started") {
        return;
    }
    let entry = fixture_entry();
    let _env = EnvGuard::set(&[("KIMI_RUNTIME_ENTRY", &entry)]);
    let sink = Arc::new(CaptureSink::default());
    let host = RuntimeHost::with_sink(Arc::clone(&sink) as Arc<dyn WireSink>);

    let supervisor = host.ensure_started().expect("ensure_started");
    assert_eq!(supervisor.state(), SupervisorState::Ready);
    // A second call reuses the ready generation.
    let again = host.ensure_started().expect("ensure_started again");
    assert!(Arc::ptr_eq(&supervisor, &again));

    let info = host.runtime_info().expect("handshake info cached");
    assert_eq!(info.kimi_source.commit, EXPECTED_KIMI_COMMIT);
    assert_eq!(info.selected_protocol, "runtime-v1");
    assert!(info
        .capabilities
        .methods
        .iter()
        .any(|method| method == "fixture.emitScript"));
    // The handshake's trailing runtime.ready produced no wire lines.
    assert!(sink.snapshot().is_empty());

    host.shutdown();
    assert_eq!(supervisor.state(), SupervisorState::Stopped);
    assert_eq!(supervisor.exit_status().and_then(|s| s.code()), Some(0));
    assert!(host.runtime_info().is_none());
    let err = host.ensure_started().err().expect("ensure_started fails");
    assert!(err.contains("shutting down"), "{err}");
}

#[test]
fn pump_translates_fixture_script_into_wire_lines() {
    if !node_or_skip("runtime_host pump translate") {
        return;
    }
    let entry = fixture_entry();
    let _env = EnvGuard::set(&[("KIMI_RUNTIME_ENTRY", &entry)]);
    let sink = Arc::new(CaptureSink::default());
    let host = RuntimeHost::with_sink(Arc::clone(&sink) as Arc<dyn WireSink>);
    let supervisor = host.ensure_started().expect("ensure_started");

    let client = RuntimeClient::new(&supervisor);
    let answer = client
        .call(
            "fixture.emitScript",
            json!({"sessionId": "host-session", "requestId": "req-host-1"}),
            CALL_TIMEOUT,
        )
        .expect("emitScript");
    assert_eq!(answer, json!({"emitted": 8}));

    let lines = sink.wait_for(10, "fixture script wire");
    assert!(lines
        .iter()
        .all(|(session_id, _)| session_id == "host-session"));
    let wire = parsed(&lines[..10]);

    // content.delta / thinking.delta -> ContentPart text + think.
    assert_eq!(wire[0]["params"]["type"], json!("ContentPart"));
    assert_eq!(wire[0]["params"]["payload"]["type"], json!("text"));
    assert_eq!(
        wire[0]["params"]["payload"]["text"],
        json!("fixture content delta")
    );
    assert_eq!(wire[1]["params"]["payload"]["type"], json!("think"));
    // tool.started -> ToolCall; tool.updated -> ToolCallPart; tool.completed -> ToolResult.
    assert_eq!(wire[2]["params"]["type"], json!("ToolCall"));
    assert_eq!(
        wire[2]["params"]["payload"]["function"]["name"],
        json!("fixture_tool")
    );
    assert_eq!(wire[3]["params"]["type"], json!("ToolCallPart"));
    assert_eq!(wire[4]["params"]["type"], json!("ToolResult"));
    // approval/question reverse requests arrive as JSON-RPC requests.
    assert_eq!(wire[5]["method"], json!("request"));
    assert_eq!(wire[5]["params"]["type"], json!("ApprovalRequest"));
    assert_eq!(wire[5]["id"], json!("fixture-approval-1"));
    assert_eq!(wire[6]["params"]["type"], json!("QuestionRequest"));
    assert_eq!(wire[6]["id"], json!("fixture-question-1"));
    // turn.completed -> prompt result, terminal idle status, usage snapshot.
    assert_eq!(wire[7]["id"], json!("req-host-1"));
    assert_eq!(wire[7]["result"]["status"], json!("finished"));
    assert_eq!(wire[8]["method"], json!("session_status"));
    assert_eq!(wire[8]["params"]["state"], json!("idle"));
    assert_eq!(wire[8]["params"]["reason"], json!("finished"));
    assert_eq!(wire[8]["params"]["prompt_request_id"], json!("req-host-1"));
    assert_eq!(wire[9]["params"]["type"], json!("StatusUpdate"));
    assert_eq!(
        wire[9]["params"]["payload"]["token_usage"]["output"],
        json!(5)
    );

    // Session-table projection: the observed (never opened) session reports
    // its projected status; the terminal event left nothing in flight.
    let status = host
        .session_status("host-session")
        .expect("status projection");
    assert_eq!(status.state, "idle");
    assert!(status.seq > 0);
    assert!(!host.is_session_open("host-session"));
    assert!(host.in_flight_turns("host-session").is_empty());

    // acp `send` parity: leased operations on a never-connected session are
    // rejected before any pending-table handling.
    let err = host
        .respond_approval(ApprovalRespondParams {
            session_id: "host-session".to_string(),
            approval_id: "fixture-approval-1".to_string(),
            decision: ApprovalDecision::Approved,
            scope: None,
            feedback: None,
            selected_label: None,
        })
        .unwrap_err();
    assert!(err.contains("not connected"), "{err}");
    let err = host
        .respond_question(QuestionRespondParams {
            session_id: "host-session".to_string(),
            question_id: "fixture-question-1".to_string(),
            result: QuestionResult::Skip,
        })
        .unwrap_err();
    assert!(err.contains("not connected"), "{err}");

    host.shutdown();
}

#[test]
fn fail_closed_marks_sessions_error_and_recovers_lazily() {
    if !node_or_skip("runtime_host fail-closed") {
        return;
    }
    let entry = fixture_entry();
    let _env = EnvGuard::set(&[("KIMI_RUNTIME_ENTRY", &entry)]);
    let sink = Arc::new(CaptureSink::default());
    let host = RuntimeHost::with_sink(Arc::clone(&sink) as Arc<dyn WireSink>);
    let supervisor = host.ensure_started().expect("ensure_started");

    let client = RuntimeClient::new(&supervisor);
    client
        .call(
            "fixture.emitScript",
            json!({"sessionId": "doomed", "requestId": "req-doomed-1"}),
            CALL_TIMEOUT,
        )
        .expect("emitScript");
    let baseline = sink.wait_for(10, "doomed session wire").len();

    // Unexpected exit: the fixture shuts down behind the supervisor's back
    // (a direct runtime.shutdown call leaves the supervisor in Ready, so the
    // exit is detected as unexpected and fails the runtime closed).
    client
        .call("runtime.shutdown", json!({}), CALL_TIMEOUT)
        .expect("fixture shutdown call");
    let lines = sink.wait_for(baseline + 2, "fail-closed synthesis");
    let wire = parsed(&lines[baseline..]);
    assert_eq!(wire[0]["method"], json!("session_status"));
    assert_eq!(wire[0]["params"]["state"], json!("error"));
    assert_eq!(wire[0]["params"]["reason"], json!("runtime_failed"));
    assert_eq!(wire[1]["params"]["type"], json!("SessionNotice"));
    assert!(
        wire[1]["params"]["payload"]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("exited unexpectedly"),
        "notice text: {}",
        wire[1]["params"]["payload"]["text"]
    );
    let status = host.session_status("doomed").expect("error projection");
    assert_eq!(status.state, "error");
    assert_eq!(supervisor.state(), SupervisorState::Failed);

    // The next call lazily rebuilds the runtime; events flow again.
    let rebuilt = host.ensure_started().expect("lazy rebuild");
    assert_eq!(rebuilt.state(), SupervisorState::Ready);
    assert!(!Arc::ptr_eq(&supervisor, &rebuilt));
    assert!(host.runtime_info().is_some());

    let before = sink.snapshot().len();
    let client = RuntimeClient::new(&rebuilt);
    client
        .call(
            "fixture.emitScript",
            json!({"sessionId": "reborn", "requestId": "req-reborn-1"}),
            CALL_TIMEOUT,
        )
        .expect("emitScript after rebuild");
    let lines = sink.wait_for(before + 10, "post-rebuild wire");
    assert!(lines[before..]
        .iter()
        .all(|(session_id, _)| session_id == "reborn"));

    host.shutdown();
    assert_eq!(rebuilt.state(), SupervisorState::Stopped);
}

#[test]
fn pre_handshake_fault_does_not_poison_the_next_attempt() {
    if !node_or_skip("runtime_host pre-handshake fault") {
        return;
    }
    let entry = fixture_entry();
    let env = EnvGuard::set(&[
        ("KIMI_RUNTIME_ENTRY", &entry),
        ("KIMI_RUNTIME_FIXTURE_RAW_STDOUT", "this is not json"),
    ]);
    let host = RuntimeHost::with_sink(Arc::new(CaptureSink::default()));

    let err = host.ensure_started().err().expect("ensure_started fails");
    assert!(err.contains("invalid_json"), "{err}");
    assert!(host.runtime_info().is_none());

    // Cleaning the fault lets the next lazy attempt start cleanly.
    env.remove("KIMI_RUNTIME_FIXTURE_RAW_STDOUT");
    let supervisor = host.ensure_started().expect("clean retry starts");
    assert_eq!(supervisor.state(), SupervisorState::Ready);
    host.shutdown();
}

#[test]
fn missing_entry_fails_readiness_without_spawning() {
    if !node_or_skip("runtime_host missing entry") {
        return;
    }
    let missing = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("no-such-worker.mjs")
        .to_string_lossy()
        .into_owned();
    let _env = EnvGuard::set(&[("KIMI_RUNTIME_ENTRY", &missing)]);
    let host = RuntimeHost::with_sink(Arc::new(CaptureSink::default()));

    let err = host.ensure_started().err().expect("ensure_started fails");
    assert!(err.contains("artifact_missing"), "{err}");
    assert!(host.runtime_info().is_none());
}

#[test]
fn commit_mismatch_fails_the_handshake() {
    if !node_or_skip("runtime_host commit mismatch") {
        return;
    }
    let entry = fixture_entry();
    let _env = EnvGuard::set(&[
        ("KIMI_RUNTIME_ENTRY", &entry),
        (
            "KIMI_RUNTIME_FIXTURE_COMMIT",
            "0000000000000000000000000000000000000000",
        ),
    ]);
    let host = RuntimeHost::with_sink(Arc::new(CaptureSink::default()));

    let err = host.ensure_started().err().expect("ensure_started fails");
    assert!(err.contains("does not match pinned"), "{err}");
    assert!(host.runtime_info().is_none());
}

#[test]
fn connect_lease_validation_and_session_open_rejection() {
    if !node_or_skip("runtime_host connect lease") {
        return;
    }
    let entry = fixture_entry();
    let _env = EnvGuard::set(&[("KIMI_RUNTIME_ENTRY", &entry)]);
    let host = RuntimeHost::with_sink(Arc::new(CaptureSink::default()));

    // Empty lease is rejected before any IO (acp verbatim).
    let err = host.connect_leased("s1", "  ").unwrap_err();
    assert_eq!(err, "Missing connection id");

    // The fixture implements no session.open: the structured rejection
    // surfaces and no slot is installed.
    let err = host.connect_leased("s1", "conn-1").unwrap_err();
    assert!(err.contains("session.open"), "{err}");
    assert!(err.contains("method_not_found"), "{err}");
    assert!(!host.is_session_open("s1"));

    // Disconnect with an unknown lease is a no-op (acp parity).
    host.disconnect_leased("s1", "conn-1")
        .expect("no-op disconnect");
    host.disconnect_leased("s1", "conn-stale")
        .expect("stale-lease disconnect is a no-op");

    host.shutdown();
}
