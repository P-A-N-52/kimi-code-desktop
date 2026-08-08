//! Integration tests for the M2 runtime supervisor against a deterministic
//! node fixture worker (`tests/fixtures/runtime-fixture-worker.mjs`).
//!
//! Every test skips with a note when `node` is not on PATH; the fixture is
//! pure node stdlib and never touches the network or `~/.kimi-code`.

use app_lib::runtime::protocol::{EventFrame, FaultCode, HelloParams, RUNTIME_PROTOCOL};
use app_lib::runtime::supervisor::{
    HandshakeConfig, RuntimeError, RuntimeSupervisor, ShutdownConfig, SpawnConfig,
    SupervisorOptions, SupervisorState,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Kimi source commit pinned by the migration contract (M0 freeze).
const EXPECTED_COMMIT: &str = "53c832dfdf9566afd59a8b3d54ebd36d3cb03d72";
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const EVENT_TIMEOUT: Duration = Duration::from_secs(5);

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

fn fixture_config(extra_env: &[(&str, &str)]) -> SpawnConfig {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("runtime-fixture-worker.mjs");
    SpawnConfig {
        program: "node".to_string(),
        args: vec![fixture.to_string_lossy().into_owned()],
        env: extra_env
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
        cwd: None,
    }
}

fn handshake_config() -> HandshakeConfig {
    HandshakeConfig {
        hello: HelloParams::new(
            env!("CARGO_PKG_VERSION"),
            std::env::temp_dir().to_string_lossy().into_owned(),
            std::env::consts::OS,
            std::env::consts::ARCH,
            "en-US",
        ),
        expected_commit: Some(EXPECTED_COMMIT.to_string()),
        timeout: CALL_TIMEOUT,
    }
}

fn recv_event(receiver: &std::sync::mpsc::Receiver<EventFrame>, what: &str) -> EventFrame {
    receiver
        .recv_timeout(EVENT_TIMEOUT)
        .unwrap_or_else(|err| panic!("timed out waiting for {what}: {err}"))
}

#[test]
fn happy_path_handshake_getinfo_scripted_events_and_clean_shutdown() {
    if !node_or_skip("happy_path") {
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config(&[]));
    assert_eq!(supervisor.state(), SupervisorState::NotStarted);
    supervisor.start().expect("spawn fixture worker");
    assert_eq!(supervisor.state(), SupervisorState::Handshaking);

    let info = supervisor
        .handshake(&handshake_config())
        .expect("handshake");
    assert_eq!(info.selected_protocol, RUNTIME_PROTOCOL);
    assert_eq!(info.kimi_source.commit, EXPECTED_COMMIT);
    assert_eq!(info.data_schema_version, 1);
    assert!(info
        .capabilities
        .methods
        .iter()
        .any(|method| method == "fixture.emitScript"));
    assert_eq!(supervisor.state(), SupervisorState::Ready);

    // runtime.getInfo answers with the same runtimeInfo shape.
    let value = supervisor
        .call("runtime.getInfo", json!({}), CALL_TIMEOUT)
        .expect("getInfo");
    assert_eq!(value["selectedProtocol"], json!(RUNTIME_PROTOCOL));

    // The event stream still carries the handshake's runtime.ready first.
    let events = supervisor.take_event_receiver().expect("event receiver");
    match recv_event(&events, "runtime.ready") {
        EventFrame::Runtime { event, .. } => assert_eq!(event, "runtime.ready"),
        other => panic!("expected runtime-scoped runtime.ready, got {other:?}"),
    }

    // fixture.emitScript emits the fixed 8-event session script, then answers.
    let answer = supervisor
        .call(
            "fixture.emitScript",
            json!({"sessionId": "fixture-session", "requestId": "req-happy-1"}),
            CALL_TIMEOUT,
        )
        .expect("emitScript");
    assert_eq!(answer, json!({"emitted": 8}));

    let expected_names = [
        "content.delta",
        "thinking.delta",
        "tool.started",
        "tool.updated",
        "tool.completed",
        "approval.requested",
        "question.requested",
        "turn.completed",
    ];
    let mut payloads: Vec<Value> = Vec::new();
    for (index, name) in expected_names.iter().enumerate() {
        match recv_event(&events, name) {
            EventFrame::Session {
                session_id,
                seq,
                event,
                payload,
            } => {
                assert_eq!(session_id, "fixture-session");
                assert_eq!(seq, (index + 1) as u64, "seq for {name}");
                assert_eq!(&event, name);
                payloads.push(payload);
            }
            other => panic!("expected session event {name}, got {other:?}"),
        }
    }
    // Spot-check the ids wave-2 translate keys on.
    assert_eq!(payloads[0]["requestId"], json!("req-happy-1"));
    assert_eq!(payloads[2]["toolCallId"], json!("fixture-tool-1"));
    assert_eq!(payloads[5]["approvalId"], json!("fixture-approval-1"));
    assert_eq!(payloads[6]["questionId"], json!("fixture-question-1"));
    assert_eq!(payloads[7]["requestId"], json!("req-happy-1"));
    assert_eq!(payloads[7]["usage"]["output"], json!(5));

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("clean shutdown");
    assert_eq!(supervisor.state(), SupervisorState::Stopped);
    assert_eq!(supervisor.exit_status().and_then(|s| s.code()), Some(0));
    assert!(supervisor
        .stderr_tail(10)
        .iter()
        .any(|line| line.contains("[runtime-fixture] starting")));
    // A stopped supervisor rejects further calls.
    let err = supervisor
        .call("runtime.getInfo", json!({}), CALL_TIMEOUT)
        .unwrap_err();
    assert!(matches!(err, RuntimeError::InvalidState(_)));
}

#[test]
fn request_before_handshake_is_rejected_without_faulting() {
    if !node_or_skip("request_before_handshake") {
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config(&[]));
    supervisor.start().expect("spawn fixture worker");

    // The runtime rejects a pre-hello request with an error-response; that is
    // not a protocol fault and must not fail the supervisor closed.
    let err = supervisor
        .call("runtime.getInfo", json!({}), CALL_TIMEOUT)
        .unwrap_err();
    match err {
        RuntimeError::Rejected(body) => assert_eq!(body.code, "handshake_required"),
        other => panic!("expected handshake_required rejection, got {other:?}"),
    }
    assert_eq!(supervisor.state(), SupervisorState::Handshaking);

    // hello is still accepted afterwards; the supervisor recovers fully.
    supervisor
        .handshake(&handshake_config())
        .expect("handshake");
    assert_eq!(supervisor.state(), SupervisorState::Ready);
    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("shutdown");
    assert_eq!(supervisor.state(), SupervisorState::Stopped);
}

#[test]
fn invalid_json_line_fails_closed() {
    if !node_or_skip("invalid_json_line") {
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config(&[(
        "KIMI_RUNTIME_FIXTURE_RAW_STDOUT",
        "this is not json",
    )]));
    supervisor.start().expect("spawn fixture worker");
    let err = supervisor.handshake(&handshake_config()).unwrap_err();
    assert!(
        matches!(err, RuntimeError::Protocol(ref fault) if fault.code == FaultCode::InvalidJson),
        "expected invalid_json fault, got {err:?}"
    );
    assert_eq!(supervisor.state(), SupervisorState::Failed);
    match supervisor.fault() {
        Some(RuntimeError::Protocol(fault)) => assert_eq!(fault.code, FaultCode::InvalidJson),
        other => panic!("expected recorded invalid_json fault, got {other:?}"),
    }
    let err = supervisor
        .call("runtime.getInfo", json!({}), CALL_TIMEOUT)
        .unwrap_err();
    assert!(matches!(err, RuntimeError::InvalidState(_)));
}

#[test]
fn oversized_frame_fails_closed() {
    if !node_or_skip("oversized_frame") {
        return;
    }
    let options = SupervisorOptions {
        max_frame_bytes: 64 * 1024,
        ..SupervisorOptions::default()
    };
    let supervisor = RuntimeSupervisor::with_options(
        fixture_config(&[("KIMI_RUNTIME_FIXTURE_HUGE_BYTES", "131072")]),
        options,
    );
    supervisor.start().expect("spawn fixture worker");
    let err = supervisor.handshake(&handshake_config()).unwrap_err();
    assert!(
        matches!(err, RuntimeError::Protocol(ref fault) if fault.code == FaultCode::FrameTooLarge),
        "expected frame_too_large fault, got {err:?}"
    );
    assert_eq!(supervisor.state(), SupervisorState::Failed);
}

#[test]
fn duplicate_response_id_fails_closed() {
    if !node_or_skip("duplicate_response_id") {
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config(&[(
        "KIMI_RUNTIME_FIXTURE_DUPLICATE_RESPONSES",
        "1",
    )]));
    supervisor.start().expect("spawn fixture worker");
    let err = supervisor.handshake(&handshake_config()).unwrap_err();
    assert!(
        matches!(err, RuntimeError::DuplicateResponseId(_)),
        "expected duplicate response id fault, got {err:?}"
    );
    assert_eq!(supervisor.state(), SupervisorState::Failed);
    match supervisor.fault() {
        Some(RuntimeError::DuplicateResponseId(id)) => assert!(id.starts_with("req-")),
        other => panic!("expected recorded duplicate fault, got {other:?}"),
    }
}

#[test]
fn handshake_commit_mismatch_fails_readiness() {
    if !node_or_skip("commit_mismatch") {
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config(&[(
        "KIMI_RUNTIME_FIXTURE_COMMIT",
        "0000000000000000000000000000000000000000",
    )]));
    supervisor.start().expect("spawn fixture worker");
    let err = supervisor.handshake(&handshake_config()).unwrap_err();
    assert!(
        matches!(err, RuntimeError::Readiness(_)),
        "expected readiness failure, got {err:?}"
    );
    assert_eq!(supervisor.state(), SupervisorState::Failed);
}

#[test]
fn handshake_protocol_mismatch_fails_readiness() {
    if !node_or_skip("protocol_mismatch") {
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config(&[(
        "KIMI_RUNTIME_FIXTURE_SELECTED_PROTOCOL",
        "runtime-v2",
    )]));
    supervisor.start().expect("spawn fixture worker");
    let err = supervisor.handshake(&handshake_config()).unwrap_err();
    assert!(
        matches!(err, RuntimeError::Readiness(_)),
        "expected readiness failure, got {err:?}"
    );
    assert_eq!(supervisor.state(), SupervisorState::Failed);
}
