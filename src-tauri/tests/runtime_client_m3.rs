//! Integration and serde shape tests for the M3 wave-2 typed client wrappers
//! (`session_replay`, `sessions_fork`, `auth_start_login` /
//! `auth_get_flow` / `auth_cancel_login` / `auth_logout` / `auth_status`,
//! `usage_get` in `runtime/client.rs`).
//!
//! The fixture worker answers the parity methods with a structured
//! `not_implemented` rejection (it advertises the flipped gates but
//! implements no business logic), so a typed wrapper reaching
//! `Rejected(not_implemented)` proves both the method name and the
//! request path; `method_not_found` would surface if the wrapper targeted the
//! wrong name. Result-shape serde coverage for the remaining parity types
//! (`AuthCancelLoginResult`, `AuthLogoutResult`) lives at the bottom; the
//! other parity shapes are pinned in `runtime_client_parity.rs`. The fixture
//! child skips with a note when `node` is not on PATH; it never touches the
//! network or `~/.kimi-code`.

use app_lib::runtime::client::{
    AuthCancelLoginResult, AuthLogoutResult, AuthProviderParams, OAuthFlowStatus, RuntimeClient,
    SessionReplayParams, SessionsForkParams,
};
use app_lib::runtime::protocol::{
    HelloParams, METHOD_AUTH_CANCEL_LOGIN, METHOD_AUTH_GET_FLOW, METHOD_AUTH_LOGOUT,
    METHOD_AUTH_START_LOGIN, METHOD_AUTH_STATUS, METHOD_SESSIONS_FORK, METHOD_SESSION_REPLAY,
    METHOD_USAGE_GET,
};
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

/// Assert a typed call landed on the fixture's parity placeholder and came
/// back `Rejected(not_implemented)` (never `method_not_found`), non-retryable.
fn assert_not_implemented<T: std::fmt::Debug>(result: Result<T, RuntimeError>, method: &str) {
    match result {
        Err(RuntimeError::Rejected(body)) => {
            assert_eq!(body.code, "not_implemented", "{method} error code");
            assert!(!body.retryable, "{method} must be non-retryable");
        }
        other => panic!("{method}: expected Rejected(not_implemented), got {other:?}"),
    }
}

#[test]
fn typed_parity_wrappers_reach_the_fixture_and_reject_not_implemented() {
    if !node_on_path() {
        eprintln!("skipping typed_parity_wrappers: `node` was not found on PATH");
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config());
    supervisor.start().expect("spawn fixture worker");
    supervisor
        .handshake(&handshake_config())
        .expect("handshake");
    let client = RuntimeClient::new(&supervisor);

    assert_not_implemented(
        client.session_replay(
            &SessionReplayParams {
                session_id: "s-1".into(),
                from_seq: Some(40),
                limit: Some(100),
            },
            CALL_TIMEOUT,
        ),
        METHOD_SESSION_REPLAY,
    );
    assert_eq!(supervisor.state(), SupervisorState::Ready);

    assert_not_implemented(
        client.sessions_fork(
            &SessionsForkParams {
                session_id: "s-1".into(),
                new_session_id: Some("s-2".into()),
                title: None,
                turn_index: None,
            },
            CALL_TIMEOUT,
        ),
        METHOD_SESSIONS_FORK,
    );
    assert_eq!(supervisor.state(), SupervisorState::Ready);

    assert_not_implemented(
        client.auth_start_login(&AuthProviderParams::default(), CALL_TIMEOUT),
        METHOD_AUTH_START_LOGIN,
    );
    assert_not_implemented(
        client.auth_get_flow(&AuthProviderParams::default(), CALL_TIMEOUT),
        METHOD_AUTH_GET_FLOW,
    );
    assert_not_implemented(
        client.auth_cancel_login(
            &AuthProviderParams {
                provider: Some("managed:kimi-code".into()),
            },
            CALL_TIMEOUT,
        ),
        METHOD_AUTH_CANCEL_LOGIN,
    );
    assert_not_implemented(
        client.auth_logout(&AuthProviderParams::default(), CALL_TIMEOUT),
        METHOD_AUTH_LOGOUT,
    );
    assert_not_implemented(
        client.auth_status(&AuthProviderParams::default(), CALL_TIMEOUT),
        METHOD_AUTH_STATUS,
    );
    assert_not_implemented(client.usage_get(CALL_TIMEOUT), METHOD_USAGE_GET);
    assert_eq!(supervisor.state(), SupervisorState::Ready);

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("shutdown");
}

// ---------------------------------------------------------------------------
// Pure serde shape tests (no child process)
// ---------------------------------------------------------------------------

#[test]
fn auth_cancel_login_and_logout_results_deserialize() {
    let cancelled: AuthCancelLoginResult =
        serde_json::from_value(json!({"cancelled": false, "status": "cancelled"})).unwrap();
    assert!(!cancelled.cancelled);
    assert_eq!(cancelled.status, OAuthFlowStatus::Cancelled);

    let logout: AuthLogoutResult =
        serde_json::from_value(json!({"logged_out": true, "provider": "managed:kimi-code"}))
            .unwrap();
    assert!(logout.logged_out);
    assert_eq!(logout.provider, "managed:kimi-code");
}

#[test]
fn auth_get_flow_null_and_logged_in_status_deserialize() {
    // `authGetFlowResultSchema` is nullable; the typed wrapper uses
    // `Option<OAuthFlowSnapshot>`.
    let none: Option<app_lib::runtime::client::OAuthFlowSnapshot> =
        serde_json::from_value(json!(null)).unwrap();
    assert!(none.is_none());

    let status: app_lib::runtime::client::AuthStatusResult =
        serde_json::from_value(json!({"loggedIn": false})).unwrap();
    assert!(!status.logged_in);
    assert_eq!(status.provider, None);
}
