//! Integration and serde shape tests for the M3 parity families
//! (`session.replay`, `sessions.fork`, `auth.*`, `usage.get` —
//! `protocol-parity.ts` on the Node side, `runtime/client_types.rs` here).
//!
//! Since wave 3 the fixture worker advertises the flipped capability
//! surface (parity gates on, the full 25-event list) but implements no
//! parity business logic, so calls still surface a structured
//! `not_implemented` rejection, and the typed params/results must
//! serialize/deserialize field-by-field per the TS zod schemas. The fixture
//! child skips with a note when `node` is not on PATH; it never touches the
//! network or `~/.kimi-code`.

use app_lib::runtime::client::{
    AuthProviderParams, AuthStatusResult, OAuthFlowSnapshot, OAuthFlowStart, OAuthFlowStatus,
    RuntimeClient, SessionReplayParams, SessionReplayResult, SessionsForkParams,
};
use app_lib::runtime::protocol::{HelloParams, METHOD_SESSION_REPLAY, METHOD_USAGE_GET};
use app_lib::runtime::supervisor::{
    HandshakeConfig, RuntimeError, RuntimeSupervisor, ShutdownConfig, SpawnConfig, SupervisorState,
};
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

/// Kimi source commit pinned by the migration contract (M0 freeze).
const EXPECTED_COMMIT: &str = "53c832dfdf9566afd59a8b3d54ebd36d3cb03d72";
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

fn node_on_path() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
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

#[test]
fn parity_methods_are_rejected_as_not_implemented_by_the_fixture() {
    if !node_on_path() {
        eprintln!("skipping parity_not_implemented: `node` was not found on PATH");
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config());
    supervisor.start().expect("spawn fixture worker");
    supervisor
        .handshake(&handshake_config())
        .expect("handshake");
    let client = RuntimeClient::new(&supervisor);

    // The fixture advertises the real runtime's post-wave-3 capability
    // surface (parity gates on, full event list) but implements no parity
    // business logic, so a well-formed call surfaces a structured
    // not_implemented rejection (never method_not_found), and the runtime
    // stays ready.
    let info = client.get_info(CALL_TIMEOUT).expect("getInfo");
    for method in [METHOD_SESSION_REPLAY, METHOD_USAGE_GET] {
        assert!(
            info.capabilities.methods.iter().any(|m| m == method),
            "capability snapshot must advertise {method}"
        );
    }
    assert!(info.capabilities.replay);
    assert!(info.capabilities.auth);
    assert!(info.capabilities.usage);
    assert!(info.capabilities.fork);
    assert_eq!(info.capabilities.events.len(), 25);

    let err = client
        .call(
            METHOD_SESSION_REPLAY,
            json!({ "sessionId": "s-1" }),
            CALL_TIMEOUT,
        )
        .expect_err("the fixture implements no parity business logic");
    match err {
        RuntimeError::Rejected(body) => {
            assert_eq!(body.code, "not_implemented");
            assert!(!body.retryable);
        }
        other => panic!("expected Rejected(ErrorBody), got {other:?}"),
    }
    assert_eq!(supervisor.state(), SupervisorState::Ready);

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("shutdown");
}

// ---------------------------------------------------------------------------
// Pure serde shape tests (no child process)
// ---------------------------------------------------------------------------

#[test]
fn session_replay_params_and_result_shape() {
    assert_eq!(
        serde_json::to_value(SessionReplayParams {
            session_id: "s-1".into(),
            from_seq: None,
            limit: None,
        })
        .unwrap(),
        json!({"sessionId": "s-1"})
    );
    assert_eq!(
        serde_json::to_value(SessionReplayParams {
            session_id: "s-1".into(),
            from_seq: Some(40),
            limit: Some(100),
        })
        .unwrap(),
        json!({"sessionId": "s-1", "fromSeq": 40, "limit": 100})
    );
    let result: SessionReplayResult = serde_json::from_value(json!({
        "sessionId": "s-1",
        "events": 128,
        "fromSeq": 1,
        "toSeq": 128,
        "truncated": false,
    }))
    .unwrap();
    assert_eq!(result.events, 128);
    assert_eq!(result.to_seq, 128);
    assert!(!result.truncated);
}

#[test]
fn sessions_fork_params_shape() {
    assert_eq!(
        serde_json::to_value(SessionsForkParams {
            session_id: "s-1".into(),
            new_session_id: None,
            title: None,
            turn_index: Some(3),
        })
        .unwrap(),
        json!({"sessionId": "s-1", "turnIndex": 3})
    );
    assert_eq!(
        serde_json::to_value(SessionsForkParams {
            session_id: "s-1".into(),
            new_session_id: Some("s-2".into()),
            title: Some("fork".into()),
            turn_index: None,
        })
        .unwrap(),
        json!({"sessionId": "s-1", "newSessionId": "s-2", "title": "fork"})
    );
}

#[test]
fn auth_provider_params_omit_none() {
    assert_eq!(
        serde_json::to_value(AuthProviderParams::default()).unwrap(),
        json!({})
    );
    assert_eq!(
        serde_json::to_value(AuthProviderParams {
            provider: Some("kimi-code".into()),
        })
        .unwrap(),
        json!({"provider": "kimi-code"})
    );
}

#[test]
fn oauth_flow_start_deserializes_per_klient_union() {
    let pending: OAuthFlowStart = serde_json::from_value(json!({
        "flow_id": "f-1",
        "provider": "kimi-code",
        "status": "pending",
        "verification_uri": "https://example.com/device",
        "verification_uri_complete": "https://example.com/device?user_code=ABCD",
        "user_code": "ABCD",
        "expires_in": 900,
        "interval": 5,
        "expires_at": "2026-08-07T00:15:00Z",
    }))
    .unwrap();
    match pending {
        OAuthFlowStart::Pending {
            user_code,
            expires_in,
            interval,
            ..
        } => {
            assert_eq!(user_code, "ABCD");
            assert_eq!(expires_in, 900.0);
            assert_eq!(interval, 5.0);
        }
        other => panic!("expected Pending, got {other:?}"),
    }

    let authenticated: OAuthFlowStart = serde_json::from_value(json!({
        "flow_id": "f-1",
        "provider": "kimi-code",
        "status": "authenticated",
    }))
    .unwrap();
    assert!(matches!(
        authenticated,
        OAuthFlowStart::Authenticated { .. }
    ));
}

#[test]
fn oauth_flow_snapshot_and_status_results_deserialize() {
    let snapshot: Option<OAuthFlowSnapshot> = serde_json::from_value(json!(null)).unwrap();
    assert!(snapshot.is_none());
    let snapshot: Option<OAuthFlowSnapshot> = serde_json::from_value(json!({
        "flow_id": "f-1",
        "provider": "kimi-code",
        "status": "denied",
        "verification_uri": "https://example.com/device",
        "verification_uri_complete": "https://example.com/device?user_code=ABCD",
        "user_code": "ABCD",
        "expires_in": 900,
        "expires_at": "2026-08-07T00:15:00Z",
        "interval": 5,
        "error_message": "denied by user",
    }))
    .unwrap();
    let snapshot = snapshot.expect("snapshot");
    assert_eq!(snapshot.status, OAuthFlowStatus::Denied);
    assert_eq!(snapshot.error_message.as_deref(), Some("denied by user"));
    assert_eq!(snapshot.resolved_at, None);

    // klient keeps `loggedIn` camelCase even though flow fields are snake_case.
    let status: AuthStatusResult =
        serde_json::from_value(json!({"loggedIn": true, "provider": "kimi-code"})).unwrap();
    assert!(status.logged_in);
    assert_eq!(status.provider.as_deref(), Some("kimi-code"));
}
