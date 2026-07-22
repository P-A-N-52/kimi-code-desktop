//! In-app Kimi Code OAuth device-code login (RFC 8628).
//!
//! Mirrors MoonshotAI/kimi-code `packages/oauth`:
//! - `POST {oauth_host}/api/oauth/device_authorization`
//! - `POST {oauth_host}/api/oauth/token` with `urn:ietf:params:oauth:grant-type:device_code`
//! - Persist tokens to `~/.kimi-code/credentials/kimi-code.json`

use crate::managed_usage::{
    credentials_generation, credentials_path, oauth_host, save_token_bundle_if_generation,
    TokenBundle, OAUTH_CLIENT_ID,
};
use crate::runtime_check::kimi_code_home_dir;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEVICE_CODE_TIMEOUT_SECS: i64 = 15 * 60;

static NEXT_LOGIN_ID: AtomicU64 = AtomicU64::new(1);
static SESSIONS: Mutex<Option<HashMap<String, LoginSession>>> = Mutex::new(None);

#[derive(Clone, Debug)]
struct LoginSession {
    device_code: String,
    interval: u64,
    started_at: i64,
    cancelled: bool,
}

fn with_sessions<R>(f: impl FnOnce(&mut HashMap<String, LoginSession>) -> R) -> R {
    let mut guard = SESSIONS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_login_id() -> String {
    format!("login-{}", NEXT_LOGIN_ID.fetch_add(1, Ordering::Relaxed))
}

/// Start a device-code login. Does not open a browser — the UI may call `open_external`.
pub fn start_kimi_login() -> Result<Value, String> {
    let auth = request_device_authorization()?;
    let login_id = new_login_id();
    let interval = auth.interval.max(1);
    with_sessions(|sessions| {
        sessions.insert(
            login_id.clone(),
            LoginSession {
                device_code: auth.device_code,
                interval,
                started_at: now_unix(),
                cancelled: false,
            },
        );
    });
    Ok(json!({
        "loginId": login_id,
        "userCode": auth.user_code,
        "verificationUri": auth.verification_uri,
        "verificationUriComplete": auth.verification_uri_complete,
        "expiresIn": auth.expires_in,
        "interval": interval,
    }))
}

/// Poll once for the given login session. On success, writes CLI credentials.
pub fn poll_kimi_login(login_id: &str) -> Result<Value, String> {
    if login_id.trim().is_empty() {
        return Err("Missing loginId".to_string());
    }

    let session = with_sessions(|sessions| sessions.get(login_id).cloned());
    let Some(session) = session else {
        return Ok(json!({
            "kind": "error",
            "message": "Login session not found. Start login again.",
        }));
    };
    if session.cancelled {
        with_sessions(|sessions| {
            sessions.remove(login_id);
        });
        return Ok(json!({ "kind": "cancelled" }));
    }
    if now_unix() - session.started_at >= DEVICE_CODE_TIMEOUT_SECS {
        with_sessions(|sessions| {
            sessions.remove(login_id);
        });
        return Ok(json!({
            "kind": "error",
            "message": "Login timed out. Please try again.",
        }));
    }

    let credential_generation = credentials_generation();
    let result = poll_device_token(&session.device_code)?;
    match result {
        DevicePollResult::Success(token) => {
            let path = credentials_path()?;
            if !save_token_bundle_if_generation(&path, &token, credential_generation)? {
                with_sessions(|sessions| {
                    sessions.remove(login_id);
                });
                return Ok(json!({ "kind": "cancelled" }));
            }
            tighten_credentials_permissions(&path);
            with_sessions(|sessions| {
                sessions.remove(login_id);
            });
            Ok(json!({ "kind": "success" }))
        }
        DevicePollResult::Pending { error_code } => {
            let mut interval = session.interval;
            if error_code == "slow_down" {
                interval = interval.saturating_add(5);
                with_sessions(|sessions| {
                    if let Some(entry) = sessions.get_mut(login_id) {
                        entry.interval = interval;
                    }
                });
            }
            Ok(json!({
                "kind": "pending",
                "errorCode": error_code,
                "interval": interval,
            }))
        }
        DevicePollResult::Expired => {
            with_sessions(|sessions| {
                sessions.remove(login_id);
            });
            Ok(json!({ "kind": "expired" }))
        }
        DevicePollResult::Denied { description } => {
            with_sessions(|sessions| {
                sessions.remove(login_id);
            });
            Ok(json!({
                "kind": "denied",
                "message": if description.is_empty() {
                    "Authorization denied.".to_string()
                } else {
                    description
                },
            }))
        }
    }
}

pub fn cancel_kimi_login(login_id: &str) -> Result<Value, String> {
    if login_id.trim().is_empty() {
        return Ok(json!({ "success": true }));
    }
    with_sessions(|sessions| {
        if let Some(entry) = sessions.get_mut(login_id) {
            entry.cancelled = true;
        } else {
            sessions.remove(login_id);
        }
    });
    Ok(json!({ "success": true }))
}

struct DeviceAuthorization {
    user_code: String,
    device_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    expires_in: Option<i64>,
    interval: u64,
}

enum DevicePollResult {
    Success(TokenBundle),
    Pending { error_code: String },
    Expired,
    Denied { description: String },
}

fn request_device_authorization() -> Result<DeviceAuthorization, String> {
    let url = format!("{}/api/oauth/device_authorization", oauth_host());
    let form = [("client_id", OAUTH_CLIENT_ID)];
    let (status, value) = post_form(&url, &form)?;
    if status != 200 {
        let detail = oauth_error_detail(&value);
        return Err(format!("Device authorization failed (HTTP {status}): {detail}"));
    }

    let user_code = required_string(&value, "user_code")?;
    let device_code = required_string(&value, "device_code")?;
    let verification_uri_complete = required_string(&value, "verification_uri_complete")?;
    let verification_uri = value
        .get("verification_uri")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let expires_in = value
        .get("expires_in")
        .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|n| n as i64)))
        .filter(|n| *n > 0);
    let interval = value
        .get("interval")
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n as u64)))
        .unwrap_or(5)
        .max(1);

    Ok(DeviceAuthorization {
        user_code,
        device_code,
        verification_uri,
        verification_uri_complete,
        expires_in,
        interval,
    })
}

fn poll_device_token(device_code: &str) -> Result<DevicePollResult, String> {
    let url = format!("{}/api/oauth/token", oauth_host());
    let form = [
        ("client_id", OAUTH_CLIENT_ID),
        ("device_code", device_code),
        (
            "grant_type",
            "urn:ietf:params:oauth:grant-type:device_code",
        ),
    ];
    let (status, value) = post_form(&url, &form)?;

    if status == 200 && value.get("access_token").and_then(Value::as_str).is_some() {
        return Ok(DevicePollResult::Success(token_from_response(&value)?));
    }
    if status >= 500 {
        return Err(format!(
            "Device token polling server error (HTTP {status}): {}",
            oauth_error_detail(&value)
        ));
    }

    let error_code = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown_error")
        .to_string();
    let description = value
        .get("error_description")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| oauth_error_detail(&value));

    match error_code.as_str() {
        "authorization_pending" | "slow_down" => Ok(DevicePollResult::Pending { error_code }),
        "expired_token" => Ok(DevicePollResult::Expired),
        "access_denied" => Ok(DevicePollResult::Denied { description }),
        _ => Err(format!(
            "Device token polling failed (HTTP {status}): {error_code} {description}"
        )),
    }
}

fn token_from_response(value: &Value) -> Result<TokenBundle, String> {
    let access_token = required_string(value, "access_token")?;
    let refresh_token = required_string(value, "refresh_token")?;
    let expires_in = value
        .get("expires_in")
        .and_then(|v| v.as_i64().or_else(|| v.as_u64().map(|n| n as i64)))
        .filter(|n| *n > 0)
        .ok_or_else(|| "OAuth response missing or invalid expires_in".to_string())?;
    Ok(TokenBundle {
        access_token,
        refresh_token,
        expires_at: now_unix() + expires_in,
        scope: value
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        token_type: value
            .get("token_type")
            .and_then(Value::as_str)
            .unwrap_or("Bearer")
            .to_string(),
        expires_in,
    })
}

fn post_form(url: &str, form: &[(&str, &str)]) -> Result<(u16, Value), String> {
    let mut request = ureq::post(url)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("Accept", "application/json")
        .timeout(REQUEST_TIMEOUT);
    for (name, value) in device_headers() {
        request = request.set(&name, &value);
    }

    let response = match request.send_form(form) {
        Ok(resp) => resp,
        Err(ureq::Error::Status(code, resp)) => {
            let body = read_body(resp);
            let value = serde_json::from_str(&body).unwrap_or(Value::Null);
            return Ok((code, value));
        }
        Err(other) => return Err(format!("OAuth request failed: {other}")),
    };

    let status = response.status();
    let body = read_body(response);
    let value = if body.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&body).unwrap_or(Value::Null)
    };
    Ok((status, value))
}

fn read_body(resp: ureq::Response) -> String {
    let mut body = String::new();
    let _ = resp.into_reader().take(1_048_576).read_to_string(&mut body);
    body
}

fn oauth_error_detail(value: &Value) -> String {
    value
        .get("error_description")
        .and_then(Value::as_str)
        .or_else(|| value.get("error").and_then(Value::as_str))
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or("unknown")
        .chars()
        .take(200)
        .collect()
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("OAuth response missing {key}"))
}

fn device_headers() -> Vec<(String, String)> {
    let home = match kimi_code_home_dir() {
        Ok(path) => path,
        Err(_) => return Vec::new(),
    };
    let device_id = ensure_device_id(&home);
    let version = env!("CARGO_PKG_VERSION");
    let hostname = hostname_ascii();
    let model = device_model_ascii();
    let os_version = std::env::consts::OS.to_string();
    vec![
        ("X-Msh-Platform".to_string(), "kimi_code_desktop".to_string()),
        ("X-Msh-Version".to_string(), version.to_string()),
        ("X-Msh-Device-Name".to_string(), hostname),
        ("X-Msh-Device-Model".to_string(), model),
        ("X-Msh-Os-Version".to_string(), ascii_header(&os_version)),
        ("X-Msh-Device-Id".to_string(), device_id),
    ]
}

fn ensure_device_id(home: &std::path::Path) -> String {
    let path = home.join("device_id");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let id = format!(
        "{:x}",
        md5::compute(format!("kimi-desktop-{}-{}", std::process::id(), now_unix()).as_bytes())
    );
    // Format as UUID-like for readability (not cryptographic).
    let uuidish = if id.len() >= 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &id[0..8],
            &id[8..12],
            &id[12..16],
            &id[16..20],
            &id[20..32]
        )
    } else {
        id.clone()
    };
    let _ = fs::create_dir_all(home);
    let _ = fs::write(&path, format!("{uuidish}\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        let _ = fs::set_permissions(home, fs::Permissions::from_mode(0o700));
    }
    uuidish
}

fn hostname_ascii() -> String {
    hostname_from_env()
        .map(|h| ascii_header(&h))
        .unwrap_or_else(|| "unknown".to_string())
}

fn hostname_from_env() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

fn device_model_ascii() -> String {
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    ascii_header(&format!("{os} {arch}"))
}

fn ascii_header(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|c| ('\u{0020}'..='\u{007E}').contains(c))
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

fn tighten_credentials_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        if let Some(parent) = path.parent() {
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let _ = path; // Windows: ACL tightening is best-effort / OS-default.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::lock::set_kimi_code_home;
    use tempfile::tempdir;

    #[test]
    fn cancel_unknown_login_is_ok() {
        let result = cancel_kimi_login("missing").unwrap();
        assert_eq!(result["success"], true);
    }

    #[test]
    fn poll_missing_session_returns_error_kind() {
        let result = poll_kimi_login("missing-login").unwrap();
        assert_eq!(result["kind"], "error");
    }

    #[test]
    fn device_id_persists_under_kimi_code_home() {
        let dir = tempdir().unwrap();
        let _guard = set_kimi_code_home(dir.path());
        let first = ensure_device_id(dir.path());
        let second = ensure_device_id(dir.path());
        assert_eq!(first, second);
        assert!(dir.path().join("device_id").is_file());
    }

    #[test]
    fn token_from_response_requires_fields() {
        let value = json!({
            "access_token": "a",
            "refresh_token": "r",
            "expires_in": 900,
            "scope": "kimi-code",
            "token_type": "Bearer"
        });
        let token = token_from_response(&value).unwrap();
        assert_eq!(token.access_token, "a");
        assert_eq!(token.refresh_token, "r");
        assert_eq!(token.expires_in, 900);
        assert!(token.expires_at > now_unix());
    }
}
