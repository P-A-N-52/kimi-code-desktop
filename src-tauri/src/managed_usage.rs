//! Fetch Kimi Code managed platform usage (Weekly / 5h quotas) via `/usages`.
//!
//! Mirrors MoonshotAI/kimi-code OAuth + managed-usage:
//! - read/refresh `~/.kimi-code/credentials/kimi-code.json`
//! - GET `https://api.kimi.com/coding/v1/usages`

use crate::runtime_check::kimi_code_home_dir;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";
const DEFAULT_OAUTH_HOST: &str = "https://auth.kimi.com";
const OAUTH_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
const CREDENTIALS_NAME: &str = "kimi-code";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MIN_REFRESH_THRESHOLD_SECS: i64 = 300;

#[derive(Clone, Debug)]
struct TokenBundle {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    scope: String,
    token_type: String,
    expires_in: i64,
}

pub fn fetch_managed_usage() -> Value {
    match fetch_managed_usage_inner() {
        Ok(payload) => json!({
            "kind": "ok",
            "payload": payload,
        }),
        Err(message) => json!({
            "kind": "error",
            "message": message,
        }),
    }
}

fn fetch_managed_usage_inner() -> Result<Value, String> {
    let access_token = ensure_fresh_access_token(false)?;
    let url = usage_url();
    match http_get_json(&url, &access_token) {
        Ok(body) => Ok(body),
        Err(err) if is_auth_error(&err) => {
            // Access token may have been rejected mid-flight — force refresh once.
            let refreshed = ensure_fresh_access_token(true)?;
            http_get_json(&url, &refreshed)
        }
        Err(err) => Err(err),
    }
}

fn is_auth_error(message: &str) -> bool {
    message.to_ascii_lowercase().contains("authorization failed")
        || message.contains("HTTP 401")
}

fn usage_url() -> String {
    std::env::var("KIMI_CODE_BASE_URL")
        .ok()
        .map(|base| {
            let trimmed = base.trim_end_matches('/');
            format!("{trimmed}/usages")
        })
        .unwrap_or_else(|| DEFAULT_USAGE_URL.to_string())
}

fn oauth_host() -> String {
    std::env::var("KIMI_CODE_OAUTH_HOST")
        .or_else(|_| std::env::var("KIMI_OAUTH_HOST"))
        .ok()
        .map(|host| host.trim_end_matches('/').to_string())
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| DEFAULT_OAUTH_HOST.to_string())
}

fn credentials_path() -> Result<PathBuf, String> {
    Ok(kimi_code_home_dir()?
        .join("credentials")
        .join(format!("{CREDENTIALS_NAME}.json")))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn refresh_threshold(expires_in: i64) -> i64 {
    if expires_in > 0 {
        MIN_REFRESH_THRESHOLD_SECS.max(expires_in / 2)
    } else {
        MIN_REFRESH_THRESHOLD_SECS
    }
}

fn should_refresh(token: &TokenBundle, force: bool) -> bool {
    if force {
        return true;
    }
    if token.expires_at <= 0 {
        return false;
    }
    let remaining = token.expires_at - now_unix();
    remaining < refresh_threshold(token.expires_in)
}

fn ensure_fresh_access_token(force: bool) -> Result<String, String> {
    let path = credentials_path()?;
    let token = load_token_bundle(&path)?;
    if !should_refresh(&token, force) {
        return Ok(token.access_token);
    }
    if token.refresh_token.is_empty() {
        return Err(
            "Kimi Code login expired (no refresh token). Run `kimi login` in a terminal."
                .to_string(),
        );
    }

    // Best-effort peer coordination (CLI skips cross-process lock on Windows too):
    // re-read before refreshing in case another process already rotated tokens.
    let latest = load_token_bundle(&path).unwrap_or_else(|_| token.clone());
    if !should_refresh(&latest, force) {
        return Ok(latest.access_token);
    }
    if force
        && (latest.refresh_token != token.refresh_token
            || latest.access_token != token.access_token
            || latest.expires_at != token.expires_at)
    {
        return Ok(latest.access_token);
    }

    let refreshed = refresh_access_token(&latest.refresh_token)?;
    save_token_bundle(&path, &refreshed)?;
    Ok(refreshed.access_token)
}

fn load_token_bundle(path: &Path) -> Result<TokenBundle, String> {
    if !path.is_file() {
        return Err(
            "No Kimi Code credentials found. Run `kimi login` in a terminal, then try again."
                .to_string(),
        );
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read credentials: {e}"))?;
    // PowerShell / editors may write UTF-8 BOM; serde_json rejects it.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content.as_str());
    let value: Value = serde_json::from_str(content)
        .map_err(|e| format!("Invalid credentials file: {e}"))?;
    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            "Kimi Code credentials are missing an access token. Run `kimi login`."
                .to_string()
        })?
        .to_string();
    let refresh_token = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let expires_at = value
        .get("expires_at")
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("expires_at")
                .and_then(Value::as_u64)
                .map(|v| v as i64)
        })
        .unwrap_or(0);
    let expires_in = value
        .get("expires_in")
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("expires_in")
                .and_then(Value::as_u64)
                .map(|v| v as i64)
        })
        .unwrap_or(0);
    let scope = value
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let token_type = value
        .get("token_type")
        .and_then(Value::as_str)
        .unwrap_or("Bearer")
        .to_string();
    Ok(TokenBundle {
        access_token,
        refresh_token,
        expires_at,
        scope,
        token_type,
        expires_in,
    })
}

fn save_token_bundle(path: &Path, token: &TokenBundle) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create credentials dir: {e}"))?;
    }
    // Preserve any extra fields the CLI wrote (e.g. obtained_at) so we don't
    // thin the credential file down to a subset ACP/CLI might still expect.
    let mut payload = if path.is_file() {
        match fs::read_to_string(path) {
            Ok(content) => {
                let content = content.strip_prefix('\u{feff}').unwrap_or(content.as_str());
                serde_json::from_str::<Value>(content)
                    .ok()
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default()
            }
            Err(_) => Default::default(),
        }
    } else {
        Default::default()
    };
    payload.insert("access_token".to_string(), json!(token.access_token));
    payload.insert("refresh_token".to_string(), json!(token.refresh_token));
    payload.insert("expires_at".to_string(), json!(token.expires_at));
    payload.insert("scope".to_string(), json!(token.scope));
    payload.insert("token_type".to_string(), json!(token.token_type));
    payload.insert("expires_in".to_string(), json!(token.expires_in));
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&Value::Object(payload))
            .map_err(|e| format!("Failed to serialize credentials: {e}"))?
    );

    let tmp = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        now_unix()
    ));
    {
        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("Failed to write credentials temp file: {e}"))?;
        file.write_all(body.as_bytes())
            .map_err(|e| format!("Failed to write credentials temp file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Failed to sync credentials temp file: {e}"))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to replace credentials file: {e}")
    })?;
    Ok(())
}

fn refresh_access_token(refresh_token: &str) -> Result<TokenBundle, String> {
    let url = format!("{}/api/oauth/token", oauth_host());
    let form = [
        ("client_id", OAUTH_CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ];

    let response = ureq::post(&url)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("Accept", "application/json")
        .timeout(REQUEST_TIMEOUT)
        .send_form(&form)
        .map_err(|err| match err {
            ureq::Error::Status(401 | 403, resp) => {
                let hint = read_error_body(resp);
                if hint.is_empty() {
                    "Kimi Code login expired. Run `kimi login` in a terminal.".to_string()
                } else {
                    format!("Kimi Code login expired ({hint}). Run `kimi login`.")
                }
            }
            ureq::Error::Status(code, resp) => {
                let hint = read_error_body(resp);
                if hint.is_empty() {
                    format!("Token refresh failed: HTTP {code}")
                } else {
                    format!("Token refresh failed: HTTP {code} ({hint})")
                }
            }
            other => format!("Token refresh failed: {other}"),
        })?;

    let mut body = String::new();
    response
        .into_reader()
        .take(1_048_576)
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed to read refresh response: {e}"))?;
    let value: Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid refresh JSON: {e}"))?;

    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Token refresh response missing access_token".to_string())?
        .to_string();
    let new_refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Token refresh response missing refresh_token".to_string())?
        .to_string();
    let expires_in = value
        .get("expires_in")
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("expires_in")
                .and_then(Value::as_u64)
                .map(|v| v as i64)
        })
        .filter(|v| *v > 0)
        .ok_or_else(|| "Token refresh response missing expires_in".to_string())?;

    Ok(TokenBundle {
        access_token,
        refresh_token: new_refresh,
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

fn http_get_json(url: &str, access_token: &str) -> Result<Value, String> {
    let response = ureq::get(url)
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("Accept", "application/json")
        .timeout(REQUEST_TIMEOUT)
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(401, _) => {
                "Authorization failed. Run `kimi login` to refresh credentials.".to_string()
            }
            ureq::Error::Status(404, _) => {
                "Usage endpoint not available for this account.".to_string()
            }
            ureq::Error::Status(code, resp) => {
                let hint = read_error_body(resp);
                if hint.is_empty() {
                    format!("Failed to fetch usage: HTTP {code}")
                } else {
                    format!("Failed to fetch usage: HTTP {code} ({hint})")
                }
            }
            other => format!("Failed to fetch usage: {other}"),
        })?;

    let mut body = String::new();
    response
        .into_reader()
        .take(1_048_576)
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed to read usage response: {e}"))?;

    serde_json::from_str(&body).map_err(|e| format!("Invalid usage JSON: {e}"))
}

fn read_error_body(resp: ureq::Response) -> String {
    let mut body = String::new();
    let _ = resp.into_reader().take(4096).read_to_string(&mut body);
    body.trim().chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::lock::set_kimi_code_home;
    use tempfile::tempdir;

    #[test]
    fn missing_credentials_returns_error_payload() {
        let dir = tempdir().unwrap();
        let _guard = set_kimi_code_home(dir.path());
        let result = fetch_managed_usage();
        assert_eq!(result["kind"], "error");
        assert!(
            result["message"]
                .as_str()
                .unwrap_or("")
                .to_ascii_lowercase()
                .contains("credential"),
            "message={}",
            result["message"]
        );
    }

    #[test]
    fn loads_fresh_access_token_without_refresh() {
        let dir = tempdir().unwrap();
        let _guard = set_kimi_code_home(dir.path());
        let creds_dir = dir.path().join("credentials");
        fs::create_dir_all(&creds_dir).unwrap();
        let path = creds_dir.join("kimi-code.json");
        let future = now_unix() + 3600;
        let payload = json!({
            "access_token": "tok-fresh",
            "refresh_token": "rt-1",
            "expires_at": future,
            "scope": "kimi-code",
            "token_type": "Bearer",
            "expires_in": 900,
        });
        fs::write(&path, serde_json::to_string_pretty(&payload).unwrap()).unwrap();
        assert_eq!(ensure_fresh_access_token(false).unwrap(), "tok-fresh");
    }

    #[test]
    fn should_refresh_when_expired() {
        let token = TokenBundle {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: now_unix() - 10,
            scope: "kimi-code".into(),
            token_type: "Bearer".into(),
            expires_in: 900,
        };
        assert!(should_refresh(&token, false));
    }

    #[test]
    fn loads_credentials_with_utf8_bom() {
        let dir = tempdir().unwrap();
        let _guard = set_kimi_code_home(dir.path());
        let creds_dir = dir.path().join("credentials");
        fs::create_dir_all(&creds_dir).unwrap();
        let path = creds_dir.join("kimi-code.json");
        let future = now_unix() + 3600;
        let payload = json!({
            "access_token": "tok-bom",
            "refresh_token": "rt-1",
            "expires_at": future,
            "scope": "kimi-code",
            "token_type": "Bearer",
            "expires_in": 900,
        });
        let body = format!("\u{feff}{}\n", serde_json::to_string_pretty(&payload).unwrap());
        fs::write(&path, body).unwrap();
        assert_eq!(ensure_fresh_access_token(false).unwrap(), "tok-bom");
    }

    #[test]
    fn save_roundtrip_preserves_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("kimi-code.json");
        let token = TokenBundle {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: 123,
            scope: "kimi-code".into(),
            token_type: "Bearer".into(),
            expires_in: 900,
        };
        save_token_bundle(&path, &token).unwrap();
        let loaded = load_token_bundle(&path).unwrap();
        assert_eq!(loaded.access_token, "a");
        assert_eq!(loaded.refresh_token, "r");
        assert_eq!(loaded.expires_at, 123);
        assert_eq!(loaded.expires_in, 900);
    }

    #[test]
    fn save_preserves_unknown_credential_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("kimi-code.json");
        fs::write(
            &path,
            r#"{
  "access_token": "old",
  "refresh_token": "old-r",
  "expires_at": 1,
  "scope": "kimi-code",
  "token_type": "Bearer",
  "expires_in": 900,
  "obtained_at": 42,
  "extra": "keep-me"
}
"#,
        )
        .unwrap();
        let token = TokenBundle {
            access_token: "new".into(),
            refresh_token: "new-r".into(),
            expires_at: 99,
            scope: "kimi-code".into(),
            token_type: "Bearer".into(),
            expires_in: 900,
        };
        save_token_bundle(&path, &token).unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["access_token"], "new");
        assert_eq!(value["refresh_token"], "new-r");
        assert_eq!(value["expires_at"], 99);
        assert_eq!(value["obtained_at"], 42);
        assert_eq!(value["extra"], "keep-me");
    }
}
