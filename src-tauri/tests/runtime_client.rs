//! Integration tests for the M2 typed runtime client (`runtime/client.rs`)
//! against the deterministic node fixture worker
//! (`tests/fixtures/runtime-fixture-worker.mjs`), plus pure serde shape
//! tests for the client's typed params/results.
//!
//! Every test that spawns the fixture skips with a note when `node` is not on
//! PATH; the fixture is pure node stdlib and never touches the network or
//! `~/.kimi-code`.

use app_lib::runtime::client::{
    ApprovalDecision, ApprovalRespondParams, ApprovalScope, ConfigTarget, ConfigUpdateParams,
    ContentPart, EmptyResult, ModelDescriptor, ModelsListResult, PromptInput, ProviderDescriptor,
    ProviderImport, ProvidersImportParams, ProvidersListResult, QuestionMethod, QuestionResult,
    RuntimeClient, SessionDescriptor, SessionsCreateParams, SessionsListParams, SessionsListResult,
    SessionsUpdateParams, ShutdownResult, TurnStartParams, TurnStartResult,
};
use app_lib::runtime::protocol::{HelloParams, RUNTIME_PROTOCOL};
use app_lib::runtime::supervisor::{
    HandshakeConfig, RuntimeError, RuntimeSupervisor, ShutdownConfig, SpawnConfig, SupervisorState,
};
use serde_json::{json, Map};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

/// Kimi source commit pinned by the migration contract (M0 freeze).
const EXPECTED_COMMIT: &str = "53c832dfdf9566afd59a8b3d54ebd36d3cb03d72";
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const SHORT_TIMEOUT: Duration = Duration::from_millis(300);

fn node_on_path() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
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

fn fixture_config() -> SpawnConfig {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("runtime-fixture-worker.mjs");
    SpawnConfig {
        program: "node".to_string(),
        args: vec![fixture.to_string_lossy().into_owned()],
        env: Vec::new(),
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

/// Spawn a fresh fixture, handshake, and return a ready supervisor.
fn started_supervisor() -> RuntimeSupervisor {
    let supervisor = RuntimeSupervisor::new(fixture_config());
    supervisor.start().expect("spawn fixture worker");
    supervisor
        .handshake(&handshake_config())
        .expect("handshake");
    supervisor
}

#[test]
fn typed_get_info_after_handshake() {
    if !node_or_skip("typed_get_info") {
        return;
    }
    let supervisor = started_supervisor();
    let client = RuntimeClient::new(&supervisor);

    let info = client.get_info(CALL_TIMEOUT).expect("typed getInfo");
    assert_eq!(info.selected_protocol, RUNTIME_PROTOCOL);
    assert_eq!(info.kimi_source.commit, EXPECTED_COMMIT);
    assert_eq!(info.data_schema_version, 1);
    // The capability snapshot advertises the fixture's full method set,
    // including the two wave-2 fixture methods.
    for method in [
        "runtime.getInfo",
        "fixture.slowRespond",
        "fixture.neverRespond",
    ] {
        assert!(
            info.capabilities.methods.iter().any(|m| m == method),
            "capability snapshot must advertise {method}"
        );
    }

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("shutdown");
}

#[test]
fn typed_slow_respond_returns_delayed_result() {
    if !node_or_skip("slow_respond") {
        return;
    }
    let supervisor = started_supervisor();
    let client = RuntimeClient::new(&supervisor);

    let started = Instant::now();
    let value = client
        .call("fixture.slowRespond", json!({"delayMs": 50}), CALL_TIMEOUT)
        .expect("slowRespond");
    assert_eq!(value, json!({"delayedMs": 50}));
    assert!(
        started.elapsed() >= Duration::from_millis(40),
        "response returned before the configured delay"
    );

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("shutdown");
}

#[test]
fn never_respond_times_out_without_faulting() {
    if !node_or_skip("never_respond") {
        return;
    }
    let supervisor = started_supervisor();
    let client = RuntimeClient::new(&supervisor);

    let err = client
        .call("fixture.neverRespond", json!({}), SHORT_TIMEOUT)
        .expect_err("neverRespond must time out");
    assert!(
        matches!(err, RuntimeError::Timeout(_)),
        "expected timeout, got {err:?}"
    );
    // A timed-out request is settled as TimedOut, not a protocol fault: the
    // runtime stays alive and usable.
    assert_eq!(supervisor.state(), SupervisorState::Ready);
    let info = client
        .get_info(CALL_TIMEOUT)
        .expect("getInfo after timeout");
    assert_eq!(info.selected_protocol, RUNTIME_PROTOCOL);

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("shutdown");
}

#[test]
fn unknown_method_is_rejected_with_error_body() {
    if !node_or_skip("unknown_method") {
        return;
    }
    let supervisor = started_supervisor();
    let client = RuntimeClient::new(&supervisor);

    let err = client
        .call("fixture.noSuchMethod", json!({}), CALL_TIMEOUT)
        .expect_err("unknown method must be rejected");
    match err {
        RuntimeError::Rejected(body) => {
            assert_eq!(body.code, "method_not_found");
            assert!(!body.retryable);
            assert!(body.message.contains("unknown method"));
            assert_eq!(body.details, None);
        }
        other => panic!("expected Rejected(ErrorBody), got {other:?}"),
    }
    // An error-response is not a protocol fault; the runtime stays ready.
    assert_eq!(supervisor.state(), SupervisorState::Ready);

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("shutdown");
}

#[test]
fn typed_session_scoped_call_reaches_wire_without_faulting() {
    if !node_or_skip("session_scoped_typed_call") {
        return;
    }
    let supervisor = started_supervisor();
    let client = RuntimeClient::new(&supervisor);

    // The fixture does not implement turn.*; the point is that the typed
    // session-scoped call (params serialization + envelope sessionId via
    // `call_with_session`) reaches the wire and surfaces the runtime's
    // rejection instead of a protocol fault.
    let err = client
        .turn_start(
            &TurnStartParams {
                session_id: "s-1".into(),
                request_id: "r-1".into(),
                input: PromptInput::Text("hello".into()),
                model: None,
                plan_mode: None,
            },
            CALL_TIMEOUT,
        )
        .expect_err("turn.start is not implemented by the fixture");
    match err {
        RuntimeError::Rejected(body) => assert_eq!(body.code, "method_not_found"),
        other => panic!("expected Rejected(ErrorBody), got {other:?}"),
    }
    assert_eq!(supervisor.state(), SupervisorState::Ready);

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("shutdown");
}

#[test]
fn typed_shutdown_returns_drain_response() {
    if !node_or_skip("typed_shutdown") {
        return;
    }
    let supervisor = started_supervisor();
    let client = RuntimeClient::new(&supervisor);

    let result = client
        .shutdown(CALL_TIMEOUT)
        .expect("shutdown drain response");
    assert!(result.shutting_down);
    // The fixture exits 0 right after the drain response; orchestrating a
    // second shutdown here would race the child teardown, so the supervisor
    // is simply dropped (its Drop reaps the exited child).
}

// ---------------------------------------------------------------------------
// Pure serde shape tests (no child process)
// ---------------------------------------------------------------------------

#[test]
fn prompt_input_text_and_parts_serialize_per_contract() {
    assert_eq!(
        serde_json::to_value(PromptInput::Text("hi".into())).unwrap(),
        json!("hi")
    );
    let parts = PromptInput::Parts(vec![
        ContentPart::text("hello"),
        ContentPart::image("https://x/y.png", Some("img-1".into())),
        ContentPart::think("hmm"),
    ]);
    assert_eq!(
        serde_json::to_value(parts).unwrap(),
        json!([
            {"type": "text", "text": "hello"},
            {"type": "image_url", "image_url": {"url": "https://x/y.png", "id": "img-1"}},
            {"type": "think", "think": "hmm"},
        ])
    );
}

#[test]
fn sessions_list_params_omit_none_fields() {
    assert_eq!(
        serde_json::to_value(SessionsListParams::default()).unwrap(),
        json!({})
    );
    let params = SessionsListParams {
        cursor: Some("c-1".into()),
        limit: Some(20),
        workspace_id: Some("w-1".into()),
    };
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        json!({"cursor": "c-1", "limit": 20, "workspaceId": "w-1"})
    );
}

#[test]
fn sessions_create_and_update_params_shape() {
    let create = SessionsCreateParams {
        session_id: None,
        cwd: "/tmp/w".into(),
        title: Some("t".into()),
        model: None,
    };
    assert_eq!(
        serde_json::to_value(&create).unwrap(),
        json!({"cwd": "/tmp/w", "title": "t"})
    );
    let update = SessionsUpdateParams {
        session_id: "s-1".into(),
        model: Some("model-x".into()),
        cwd: None,
    };
    assert_eq!(
        serde_json::to_value(&update).unwrap(),
        json!({"sessionId": "s-1", "model": "model-x"})
    );
}

#[test]
fn turn_start_params_shape() {
    let params = TurnStartParams {
        session_id: "s-1".into(),
        request_id: "r-1".into(),
        input: PromptInput::Text("go".into()),
        model: None,
        plan_mode: Some(true),
    };
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        json!({"sessionId": "s-1", "requestId": "r-1", "input": "go", "planMode": true})
    );
}

#[test]
fn approval_respond_params_shape() {
    let params = ApprovalRespondParams {
        session_id: "s-1".into(),
        approval_id: "a-1".into(),
        decision: ApprovalDecision::Approved,
        scope: Some(ApprovalScope::Session),
        feedback: None,
        selected_label: Some("Run".into()),
    };
    assert_eq!(
        serde_json::to_value(&params).unwrap(),
        json!({
            "sessionId": "s-1",
            "approvalId": "a-1",
            "decision": "approved",
            "scope": "session",
            "selectedLabel": "Run",
        })
    );
}

#[test]
fn question_result_shapes() {
    assert_eq!(
        serde_json::to_value(QuestionResult::Skip).unwrap(),
        json!(null)
    );
    let mut answers = Map::new();
    answers.insert("q1".into(), json!("yes"));
    assert_eq!(
        serde_json::to_value(QuestionResult::Answers(answers.clone())).unwrap(),
        json!({"q1": "yes"})
    );
    assert_eq!(
        serde_json::to_value(QuestionResult::WithMethod {
            answers,
            method: Some(QuestionMethod::Enter),
        })
        .unwrap(),
        json!({"answers": {"q1": "yes"}, "method": "enter"})
    );
}

#[test]
fn config_update_and_providers_import_params_shape() {
    let config = ConfigUpdateParams {
        domain: "model".into(),
        patch: json!({"provider": "x"}),
        target: Some(ConfigTarget::User),
    };
    assert_eq!(
        serde_json::to_value(&config).unwrap(),
        json!({"domain": "model", "patch": {"provider": "x"}, "target": "user"})
    );
    let providers = ProvidersImportParams {
        providers: vec![ProviderImport {
            id: "openai".into(),
        }],
    };
    assert_eq!(
        serde_json::to_value(&providers).unwrap(),
        json!({"providers": [{"id": "openai"}]})
    );
}

#[test]
fn session_descriptor_deserializes_loose() {
    let descriptor: SessionDescriptor = serde_json::from_value(json!({
        "sessionId": "s-1",
        "workspaceId": "w-1",
        "cwd": "/tmp/w",
        "title": null,
        "model": "model-x",
        "archived": false,
        "createdAt": 1234,
        "updatedAt": "2026-08-07T00:00:00Z",
        "extra": {"anything": true},
    }))
    .unwrap();
    assert_eq!(descriptor.session_id, "s-1");
    assert_eq!(descriptor.title, None);
    assert_eq!(descriptor.created_at, Some(json!(1234)));
    assert_eq!(descriptor.updated_at, Some(json!("2026-08-07T00:00:00Z")));
}

#[test]
fn turn_and_shutdown_results_deserialize() {
    let result: TurnStartResult =
        serde_json::from_value(json!({"requestId": "r-1", "turnId": 7})).unwrap();
    assert_eq!(result.request_id, "r-1");
    assert_eq!(result.turn_id, 7.0);
    let result: ShutdownResult = serde_json::from_value(json!({"shuttingDown": true})).unwrap();
    assert!(result.shutting_down);
}

#[test]
fn list_and_catalog_results_deserialize() {
    let result: SessionsListResult = serde_json::from_value(json!({
        "sessions": [{"sessionId": "s-1"}],
        "nextCursor": "c-2",
    }))
    .unwrap();
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.next_cursor.as_deref(), Some("c-2"));

    let result: ModelsListResult =
        serde_json::from_value(json!({"models": [{"id": "kimi", "provider": "moonshot"}]}))
            .unwrap();
    assert_eq!(result.models[0].provider.as_deref(), Some("moonshot"));

    let result: ProvidersListResult =
        serde_json::from_value(json!({"providers": [{"id": "moonshot"}]})).unwrap();
    assert_eq!(result.providers[0].id, "moonshot");
}

#[test]
fn empty_results_deserialize_from_empty_object() {
    let result: EmptyResult = serde_json::from_value(json!({})).unwrap();
    assert_eq!(result, EmptyResult {});
}

#[test]
fn model_and_provider_descriptors_tolerate_absent_optionals() {
    let model: ModelDescriptor = serde_json::from_value(json!({"id": "kimi"})).unwrap();
    assert_eq!(model.name, None);
    let provider: ProviderDescriptor = serde_json::from_value(json!({"id": "moonshot"})).unwrap();
    assert_eq!(provider.name, None);
}
