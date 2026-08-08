//! Integration and serde shape tests for the M3 wave-2 typed client wrappers
//! (`session_replay`, `sessions_fork`, `auth_start_login` /
//! `auth_get_flow` / `auth_cancel_login` / `auth_logout` / `auth_status`,
//! `usage_get` in `runtime/client.rs`), with the M4 wrapper coverage
//! (`session_set_mode`, `providers_catalog_list` / `providers_catalog_get`,
//! the `providers.import` source channels) appended at the bottom.
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
    AuthCancelLoginResult, AuthLogoutResult, AuthProviderParams, OAuthFlowStatus,
    ProviderCatalogEntry, ProviderCatalogSummary, ProvidersImportCatalogConfig,
    ProvidersImportRegistryConfig, ProvidersImportResult, ProvidersImportSourceParams,
    RuntimeClient, SessionModeKind, SessionPermissionMode, SessionReplayParams,
    SessionSetModeParams, SessionSetModeResult, SessionsForkParams,
};
use app_lib::runtime::protocol::{
    HelloParams, METHOD_AUTH_CANCEL_LOGIN, METHOD_AUTH_GET_FLOW, METHOD_AUTH_LOGOUT,
    METHOD_AUTH_START_LOGIN, METHOD_AUTH_STATUS, METHOD_PROVIDERS_CATALOG_GET,
    METHOD_PROVIDERS_CATALOG_LIST, METHOD_SESSIONS_FORK, METHOD_SESSION_REPLAY,
    METHOD_SESSION_SET_MODE, METHOD_USAGE_GET,
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

// ---------------------------------------------------------------------------
// M4 wrappers: session.setMode, providers.catalog.*, providers.import source
// channels (fixture call path + serde shapes)
// ---------------------------------------------------------------------------

#[test]
fn typed_m4_wrappers_reach_the_fixture_and_reject_not_implemented() {
    if !node_on_path() {
        eprintln!("skipping typed_m4_wrappers: `node` was not found on PATH");
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config());
    supervisor.start().expect("spawn fixture worker");
    supervisor
        .handshake(&handshake_config())
        .expect("handshake");
    let client = RuntimeClient::new(&supervisor);

    assert_not_implemented(
        client.session_set_mode(
            &SessionSetModeParams::Plan {
                session_id: "s-1".into(),
                enabled: true,
            },
            CALL_TIMEOUT,
        ),
        METHOD_SESSION_SET_MODE,
    );
    assert_not_implemented(
        client.session_set_mode(
            &SessionSetModeParams::Permission {
                session_id: "s-1".into(),
                permission_mode: SessionPermissionMode::Auto,
            },
            CALL_TIMEOUT,
        ),
        METHOD_SESSION_SET_MODE,
    );
    assert_not_implemented(
        client.providers_catalog_list(CALL_TIMEOUT),
        METHOD_PROVIDERS_CATALOG_LIST,
    );
    assert_not_implemented(
        client.providers_catalog_get("acme", CALL_TIMEOUT),
        METHOD_PROVIDERS_CATALOG_GET,
    );
    assert_not_implemented(
        client.providers_import_catalog(
            "acme",
            &ProvidersImportCatalogConfig {
                api_key: "key".into(),
                default_model: Some("acme-pro".into()),
                base_url: None,
            },
            CALL_TIMEOUT,
        ),
        "providers.import",
    );
    assert_not_implemented(
        client.providers_import_registry("https://example.test/api.json", None, CALL_TIMEOUT),
        "providers.import",
    );
    assert_eq!(supervisor.state(), SupervisorState::Ready);

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("shutdown");
}

#[test]
fn session_set_mode_params_serialize_as_tagged_union() {
    let plan = SessionSetModeParams::Plan {
        session_id: "s-1".into(),
        enabled: true,
    };
    assert_eq!(plan.session_id(), "s-1");
    assert_eq!(
        serde_json::to_value(&plan).unwrap(),
        json!({"sessionId": "s-1", "mode": "plan", "enabled": true})
    );
    let permission = SessionSetModeParams::Permission {
        session_id: "s-2".into(),
        permission_mode: SessionPermissionMode::Yolo,
    };
    assert_eq!(permission.session_id(), "s-2");
    assert_eq!(
        serde_json::to_value(&permission).unwrap(),
        json!({"sessionId": "s-2", "mode": "permission", "permissionMode": "yolo"})
    );
}

#[test]
fn session_set_mode_result_deserializes_both_arms() {
    let plan: SessionSetModeResult =
        serde_json::from_value(json!({"sessionId": "s-1", "mode": "plan", "planMode": true}))
            .unwrap();
    assert_eq!(plan.mode, SessionModeKind::Plan);
    assert_eq!(plan.plan_mode, Some(true));
    assert_eq!(plan.permission_mode, None);

    let permission: SessionSetModeResult = serde_json::from_value(
        json!({"sessionId": "s-1", "mode": "permission", "permissionMode": "auto"}),
    )
    .unwrap();
    assert_eq!(permission.mode, SessionModeKind::Permission);
    assert_eq!(permission.plan_mode, None);
    assert_eq!(
        permission.permission_mode,
        Some(SessionPermissionMode::Auto)
    );

    // Unknown extra fields flow through (loose schema tolerance).
    let loose: SessionSetModeResult = serde_json::from_value(
        json!({"sessionId": "s-1", "mode": "plan", "planMode": false, "extra": 1}),
    )
    .unwrap();
    assert_eq!(loose.plan_mode, Some(false));
}

#[test]
fn providers_import_source_params_serialize_as_tagged_union() {
    let catalog = ProvidersImportSourceParams::Catalog {
        entry_id: "acme".into(),
        config: ProvidersImportCatalogConfig {
            api_key: "key".into(),
            default_model: Some("acme-pro".into()),
            base_url: None,
        },
    };
    assert_eq!(
        serde_json::to_value(&catalog).unwrap(),
        json!({
            "source": "catalog",
            "entryId": "acme",
            "config": {"apiKey": "key", "defaultModel": "acme-pro"},
        })
    );

    let registry = ProvidersImportSourceParams::Registry {
        registry_url: "https://example.test/api.json".into(),
        config: None,
    };
    assert_eq!(
        serde_json::to_value(&registry).unwrap(),
        json!({"source": "registry", "registryUrl": "https://example.test/api.json"})
    );
    let registry_with_key = ProvidersImportSourceParams::Registry {
        registry_url: "https://example.test/api.json".into(),
        config: Some(ProvidersImportRegistryConfig {
            api_key: Some("key".into()),
        }),
    };
    assert_eq!(
        serde_json::to_value(&registry_with_key).unwrap(),
        json!({
            "source": "registry",
            "registryUrl": "https://example.test/api.json",
            "config": {"apiKey": "key"},
        })
    );
}

#[test]
fn provider_catalog_dtos_deserialize_from_camel_case_wire() {
    let summary: ProviderCatalogSummary =
        serde_json::from_value(json!({"id": "acme", "name": "Acme Co", "modelCount": 2})).unwrap();
    assert_eq!(summary.model_count, 2);

    let entry: ProviderCatalogEntry = serde_json::from_value(json!({
        "providerId": "acme",
        "name": "Acme Co",
        "models": [{"id": "acme-pro", "name": "Acme Pro", "maxContextTokens": 64000}],
    }))
    .unwrap();
    assert_eq!(entry.provider_id, "acme");
    assert_eq!(entry.models.len(), 1);
    assert_eq!(entry.models[0].max_context_tokens, 64000);
}

#[test]
fn providers_import_result_deserializes_all_channels() {
    let result: ProvidersImportResult = serde_json::from_value(json!({
        "providerId": "acme",
        "providers": [{"id": "acme", "type": "openai", "has_api_key": true}],
        "modelsImported": 3,
    }))
    .unwrap();
    assert_eq!(result.provider_id, "acme");
    assert_eq!(result.providers.len(), 1);
    assert_eq!(result.providers[0].id, "acme");
    assert_eq!(result.models_imported, Some(3));

    // The M1 direct channel answers no modelsImported.
    let direct: ProvidersImportResult = serde_json::from_value(json!({
        "providerId": "acme",
        "providers": [],
    }))
    .unwrap();
    assert_eq!(direct.models_imported, None);
}
