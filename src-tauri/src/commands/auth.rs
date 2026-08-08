//! Auth-family Tauri commands over the source runtime (M4 wave 1).
//!
//! The six commands replace the pre-cutover adapters that talked to an
//! external `kimi` CLI / device-code endpoints:
//!
//! - `open_kimi_login` is deliberately removed: terminal login no longer
//!   exists with the built-in runtime, so it returns an explicit actionable
//!   error pointing at the in-panel login.
//! - the other five drive the runtime `auth.*` family (`auth.startLogin` /
//!   `auth.getFlow` / `auth.cancelLogin` / `auth.status` / `auth.logout`)
//!   through the typed [`RuntimeClient`] and map the runtime-v1 snake_case
//!   DTOs onto the ACP-era camelCase shapes the frontend still consumes
//!   (`src/lib/tauri-api.ts`).
//!
//! Flow-state ownership: the runtime's klient `oauthService` holds the single
//! active flow; this module only remembers the *login id* it minted, so a poll
//! for a stale or superseded id keeps the ACP-era "session not found"
//! semantics. The runtime retains a terminal flow snapshot for five minutes
//! (engine `TERMINAL_RETENTION_MS`), which keeps the frontend poll window
//! covering success/expired/denied/cancelled results.

use crate::runtime::client::{
    AuthLogoutResult, AuthProviderParams, AuthStatusResult, OAuthFlowSnapshot, OAuthFlowStart,
    OAuthFlowStatus, RuntimeClient,
};
use crate::runtime::host::RuntimeHost;
use crate::runtime::supervisor::RuntimeError;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// Bounded runtime call budget, matching the host's `CALL_TIMEOUT` for
/// request/response calls (open/close/turns/responds).
const AUTH_CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Product decision (M4 plan): terminal login is gone with the built-in
/// runtime; the in-panel login is the only supported path.
const TERMINAL_LOGIN_REMOVED_MESSAGE: &str = "终端登录已随内置运行时移除，请使用面板内登录。";

/// The login id this module most recently minted via `start_kimi_login`.
/// The runtime owns the actual flow; this slot only reproduces the ACP-era
/// "unknown session" result for stale or superseded ids.
static CURRENT_LOGIN_ID: Mutex<Option<String>> = Mutex::new(None);

/// `open_kimi_login` — no runtime equivalent. Terminal login was removed with
/// the built-in runtime, so the command fails with an actionable message
/// instead of faking a launcher.
#[tauri::command]
pub fn open_kimi_login() -> Result<Value, String> {
    Err(TERMINAL_LOGIN_REMOVED_MESSAGE.to_string())
}

/// Start a device-code login flow on the runtime. The already-authenticated
/// fast path maps onto the same DTO: the frontend requires a `userCode` to
/// render the code, so a resolved token surfaces as an empty-code start and
/// the panel reports the incomplete response rather than faking a code.
#[tauri::command]
pub async fn start_kimi_login(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let flow = client
            .auth_start_login(&AuthProviderParams::default(), AUTH_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("auth.startLogin", err))?;
        set_current_login_id(&flow);
        Ok(map_start_flow(&flow))
    })
    .await
    .map_err(|e| format!("Failed to join start_kimi_login: {e}"))?
}

/// Poll the active runtime flow. A missing/empty login id and an unknown id
/// keep the ACP-era shapes (`Err("Missing loginId")` and the "session not
/// found" error kind); a live flow maps by its status.
#[tauri::command]
pub async fn poll_kimi_login(login_id: String, app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        if login_id.trim().is_empty() {
            return Err("Missing loginId".to_string());
        }
        if !is_current_login_id(&login_id) {
            return Ok(map_poll_snapshot(None));
        }
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let snapshot = client
            .auth_get_flow(&AuthProviderParams::default(), AUTH_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("auth.getFlow", err))?;
        Ok(map_poll_snapshot(snapshot.as_ref()))
    })
    .await
    .map_err(|e| format!("Failed to join poll_kimi_login: {e}"))?
}

/// Cancel the active runtime flow. The result keeps the ACP-era `{success:
/// true}` shape; the frontend ignores it and stops polling.
#[tauri::command]
pub async fn cancel_kimi_login(login_id: String, app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        if login_id.trim().is_empty() {
            return Ok(map_cancel_result());
        }
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        client
            .auth_cancel_login(&AuthProviderParams::default(), AUTH_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("auth.cancelLogin", err))?;
        Ok(map_cancel_result())
    })
    .await
    .map_err(|e| format!("Failed to join cancel_kimi_login: {e}"))?
}

/// `auth.status.loggedIn` -> `{present}`.
#[tauri::command]
pub async fn kimi_credentials_status(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let status = client
            .auth_status(&AuthProviderParams::default(), AUTH_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("auth.status", err))?;
        Ok(map_credentials_status(&status))
    })
    .await
    .map_err(|e| format!("Failed to join kimi_credentials_status: {e}"))?
}

/// `auth.logout.logged_out` -> `{success, present: false}`.
#[tauri::command]
pub async fn logout_kimi(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let result = client
            .auth_logout(&AuthProviderParams::default(), AUTH_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("auth.logout", err))?;
        Ok(map_logout_result(&result))
    })
    .await
    .map_err(|e| format!("Failed to join logout_kimi: {e}"))?
}

// ---------------------------------------------------------------------------
// DTO mapping (pure functions, unit-tested below)
// ---------------------------------------------------------------------------

/// `authStartLoginResultSchema` -> ACP-era `start_kimi_login` DTO
/// (`KimiLoginStart`): `flow_id->loginId`, `user_code->userCode`,
/// `verification_uri->verificationUri`,
/// `verification_uri_complete->verificationUriComplete`,
/// `expires_in->expiresIn` (M3 parity comment).
fn map_start_flow(flow: &OAuthFlowStart) -> Value {
    match flow {
        OAuthFlowStart::Pending {
            flow_id,
            verification_uri,
            verification_uri_complete,
            user_code,
            expires_in,
            interval,
            ..
        } => json!({
            "loginId": flow_id,
            "userCode": user_code,
            "verificationUri": verification_uri,
            "verificationUriComplete": verification_uri_complete,
            "expiresIn": expires_in,
            "interval": interval,
        }),
        OAuthFlowStart::Authenticated { flow_id, .. } => json!({
            "loginId": flow_id,
            "userCode": "",
            "verificationUri": "",
            "verificationUriComplete": "",
            "expiresIn": Value::Null,
            "interval": 5,
        }),
    }
}

/// `authGetFlowResultSchema` (nullable) -> ACP-era `poll_kimi_login` DTO
/// (`KimiLoginPollResult`): `authenticated->success`, `pending->pending`,
/// `denied->error{message}`, `expired->expired`, `cancelled->cancelled`;
/// no flow keeps the "session not found" error kind.
fn map_poll_snapshot(snapshot: Option<&OAuthFlowSnapshot>) -> Value {
    let Some(snapshot) = snapshot else {
        return json!({
            "kind": "error",
            "message": "Login session not found. Start login again.",
        });
    };
    match snapshot.status {
        OAuthFlowStatus::Authenticated => json!({ "kind": "success" }),
        OAuthFlowStatus::Pending => json!({
            "kind": "pending",
            "interval": snapshot.interval,
        }),
        OAuthFlowStatus::Denied => json!({
            "kind": "error",
            "message": denied_message(snapshot.error_message.as_deref()),
        }),
        OAuthFlowStatus::Expired => json!({ "kind": "expired" }),
        OAuthFlowStatus::Cancelled => json!({ "kind": "cancelled" }),
    }
}

/// `authCancelLoginResultSchema` -> ACP-era `{success: true}` shape.
fn map_cancel_result() -> Value {
    json!({ "success": true })
}

/// `authStatusResultSchema` -> ACP-era `kimi_credentials_status` DTO.
fn map_credentials_status(status: &AuthStatusResult) -> Value {
    json!({ "present": status.logged_in })
}

/// `authLogoutResultSchema` -> ACP-era `logout_kimi` DTO.
fn map_logout_result(result: &AuthLogoutResult) -> Value {
    json!({
        "success": result.logged_out,
        "present": false,
    })
}

/// Denied-flows carry a runtime `error_message`; fall back to the ACP-era
/// default when absent.
fn denied_message(error_message: Option<&str>) -> String {
    error_message
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "Authorization denied.".to_string())
}

/// Extract the flow id regardless of the start arm; used to remember the
/// login id this module minted.
fn flow_id_of(flow: &OAuthFlowStart) -> &str {
    match flow {
        OAuthFlowStart::Pending { flow_id, .. } | OAuthFlowStart::Authenticated { flow_id, .. } => {
            flow_id
        }
    }
}

fn set_current_login_id(flow: &OAuthFlowStart) {
    *CURRENT_LOGIN_ID
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(flow_id_of(flow).to_string());
}

fn is_current_login_id(login_id: &str) -> bool {
    CURRENT_LOGIN_ID
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_deref()
        == Some(login_id)
}

/// Command-level error mapping: a runtime `Rejected` (well-formed `ok: false`,
/// e.g. `unauthorized`) surfaces its code and message verbatim, which the
/// frontend tolerates as a displayable error; fatal failures (protocol, io,
/// timeout, unexpected exit, readiness) surface as an operation failure.
fn runtime_error_message(operation: &str, err: RuntimeError) -> String {
    match err {
        RuntimeError::Rejected(body) => {
            format!("{operation} rejected: {}: {}", body.code, body.message)
        }
        other => format!("{operation} failed: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::protocol::{ErrorBody, FaultCode, ProtocolFault};

    fn pending_flow() -> OAuthFlowStart {
        OAuthFlowStart::Pending {
            flow_id: "oauth_flow_1".to_string(),
            provider: "kimi-code".to_string(),
            verification_uri: "https://auth.kimi.com/device".to_string(),
            verification_uri_complete: "https://auth.kimi.com/device?user_code=ABCD-EFGH"
                .to_string(),
            user_code: "ABCD-EFGH".to_string(),
            expires_in: 900.0,
            interval: 5.0,
            expires_at: "2026-08-07T00:00:00.000Z".to_string(),
        }
    }

    fn authenticated_flow() -> OAuthFlowStart {
        OAuthFlowStart::Authenticated {
            flow_id: "oauth_flow_2".to_string(),
            provider: "kimi-code".to_string(),
        }
    }

    fn snapshot(status: OAuthFlowStatus, error_message: Option<&str>) -> OAuthFlowSnapshot {
        OAuthFlowSnapshot {
            flow_id: "oauth_flow_1".to_string(),
            provider: "kimi-code".to_string(),
            status,
            verification_uri: "https://auth.kimi.com/device".to_string(),
            verification_uri_complete: "https://auth.kimi.com/device?user_code=ABCD-EFGH"
                .to_string(),
            user_code: "ABCD-EFGH".to_string(),
            expires_in: 900.0,
            expires_at: "2026-08-07T00:00:00.000Z".to_string(),
            interval: 5.0,
            resolved_at: None,
            error_message: error_message.map(str::to_string),
        }
    }

    #[test]
    fn start_pending_maps_to_frontend_dto() {
        let value = map_start_flow(&pending_flow());
        assert_eq!(value["loginId"], "oauth_flow_1");
        assert_eq!(value["userCode"], "ABCD-EFGH");
        assert_eq!(value["verificationUri"], "https://auth.kimi.com/device");
        assert_eq!(
            value["verificationUriComplete"],
            "https://auth.kimi.com/device?user_code=ABCD-EFGH"
        );
        assert_eq!(value["expiresIn"], 900.0);
        assert_eq!(value["interval"], 5.0);
    }

    #[test]
    fn start_authenticated_maps_to_frontend_dto() {
        let value = map_start_flow(&authenticated_flow());
        assert_eq!(value["loginId"], "oauth_flow_2");
        assert_eq!(value["userCode"], "");
        assert_eq!(value["verificationUri"], "");
        assert_eq!(value["verificationUriComplete"], "");
        assert_eq!(value["expiresIn"], Value::Null);
        assert_eq!(value["interval"], 5);
    }

    #[test]
    fn poll_no_flow_returns_session_not_found() {
        let value = map_poll_snapshot(None);
        assert_eq!(value["kind"], "error");
        assert_eq!(
            value["message"],
            "Login session not found. Start login again."
        );
    }

    #[test]
    fn poll_pending_maps_to_pending_with_interval() {
        let value = map_poll_snapshot(Some(&snapshot(OAuthFlowStatus::Pending, None)));
        assert_eq!(value["kind"], "pending");
        assert_eq!(value["interval"], 5.0);
    }

    #[test]
    fn poll_authenticated_maps_to_success() {
        let value = map_poll_snapshot(Some(&snapshot(OAuthFlowStatus::Authenticated, None)));
        assert_eq!(value["kind"], "success");
    }

    #[test]
    fn poll_denied_maps_to_error_with_runtime_message() {
        let value = map_poll_snapshot(Some(&snapshot(
            OAuthFlowStatus::Denied,
            Some("User did not authorize the device."),
        )));
        assert_eq!(value["kind"], "error");
        assert_eq!(value["message"], "User did not authorize the device.");
    }

    #[test]
    fn poll_denied_without_message_uses_default() {
        let value = map_poll_snapshot(Some(&snapshot(OAuthFlowStatus::Denied, None)));
        assert_eq!(value["kind"], "error");
        assert_eq!(value["message"], "Authorization denied.");
    }

    #[test]
    fn poll_expired_maps_to_expired() {
        let value = map_poll_snapshot(Some(&snapshot(OAuthFlowStatus::Expired, None)));
        assert_eq!(value["kind"], "expired");
    }

    #[test]
    fn poll_cancelled_maps_to_cancelled() {
        let value = map_poll_snapshot(Some(&snapshot(OAuthFlowStatus::Cancelled, None)));
        assert_eq!(value["kind"], "cancelled");
    }

    #[test]
    fn credentials_status_maps_logged_in() {
        assert_eq!(
            map_credentials_status(&AuthStatusResult {
                logged_in: true,
                provider: None,
            })["present"],
            true
        );
        assert_eq!(
            map_credentials_status(&AuthStatusResult {
                logged_in: false,
                provider: None,
            })["present"],
            false
        );
    }

    #[test]
    fn logout_maps_to_frontend_shape() {
        let value = map_logout_result(&AuthLogoutResult {
            logged_out: true,
            provider: "kimi-code".to_string(),
        });
        assert_eq!(value["success"], true);
        assert_eq!(value["present"], false);
    }

    #[test]
    fn cancel_maps_to_success_shape() {
        assert_eq!(map_cancel_result()["success"], true);
    }

    #[test]
    fn rejected_error_surfaces_code_and_message() {
        let err = RuntimeError::Rejected(ErrorBody {
            code: "unauthorized".to_string(),
            message: "Missing OAuth credentials.".to_string(),
            retryable: false,
            details: None,
        });
        let message = runtime_error_message("auth.status", err);
        assert!(message.contains("auth.status rejected"));
        assert!(message.contains("unauthorized"));
        assert!(message.contains("Missing OAuth credentials."));
    }

    #[test]
    fn fatal_error_surfaces_operation_failure() {
        let err = RuntimeError::Io("pipe closed".to_string());
        let message = runtime_error_message("auth.logout", err);
        assert!(message.contains("auth.logout failed"));
        assert!(message.contains("pipe closed"));
    }

    #[test]
    fn protocol_fault_maps_to_operation_failure() {
        let err = RuntimeError::Protocol(ProtocolFault::new(
            FaultCode::InvalidEnvelope,
            "result schema mismatch".to_string(),
        ));
        let message = runtime_error_message("auth.getFlow", err);
        assert!(message.contains("auth.getFlow failed"));
        assert!(message.contains("protocol fault"));
    }

    #[test]
    fn flow_id_of_reads_both_arms() {
        assert_eq!(flow_id_of(&pending_flow()), "oauth_flow_1");
        assert_eq!(flow_id_of(&authenticated_flow()), "oauth_flow_2");
    }
}
