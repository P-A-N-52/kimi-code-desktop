//! Safe, non-secret summary of Kimi Code provider configuration for Desktop UI.
//!
//! Never returns api keys, tokens, or other credential material.

use crate::managed_usage;
use crate::runtime_check;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const SECRET_FIELD_NAMES: &[&str] = &[
    "api_key",
    "api-key",
    "access_token",
    "refresh_token",
    "secret",
    "token",
    "password",
    "authorization",
];

#[derive(Clone, Debug, Default)]
struct AcpAuthState {
    last_failure_at_ms: Option<u64>,
    last_failure_message: Option<String>,
}

static ACP_AUTH_STATE: Mutex<AcpAuthState> = Mutex::new(AcpAuthState {
    last_failure_at_ms: None,
    last_failure_message: None,
});

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn sanitize_auth_message(message: &str) -> String {
    let mut sanitized = message.trim().to_string();
    if sanitized.is_empty() {
        return "ACP authentication failed.".to_string();
    }
    let tokens: Vec<String> = sanitized.split_whitespace().map(str::to_string).collect();
    for token in tokens {
        if looks_like_secret(&token) {
            sanitized = sanitized.replace(&token, "[redacted]");
        }
    }
    sanitized
}

fn looks_like_secret(value: &str) -> bool {
    let trimmed = value.trim_matches(|ch: char| "\"'`.,;:".contains(ch));
    if trimmed.len() < 16 {
        return false;
    }
    trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

pub fn record_acp_auth_failure(message: &str) {
    let sanitized = sanitize_auth_message(message);
    if let Ok(mut state) = ACP_AUTH_STATE.lock() {
        state.last_failure_at_ms = Some(now_ms());
        state.last_failure_message = Some(sanitized);
    }
}

pub fn clear_acp_auth_failure() {
    if let Ok(mut state) = ACP_AUTH_STATE.lock() {
        *state = AcpAuthState::default();
    }
}

fn acp_auth_snapshot() -> Value {
    let state = ACP_AUTH_STATE
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    let status = if state.last_failure_at_ms.is_some() {
        "failed"
    } else {
        "unknown"
    };
    json!({
        "status": status,
        "lastFailureAtMs": state.last_failure_at_ms,
        "lastFailureMessage": state.last_failure_message,
    })
}

pub fn get_providers_overview() -> Result<Value, String> {
    let path = runtime_check::kimi_code_config_path()?;
    let path_string = path.to_string_lossy().to_string();
    let parsed = load_config_toml(&path)?;
    let default_model = parsed
        .get("default_model")
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();

    let mut structure_issues = Vec::new();
    if default_model.is_empty() {
        structure_issues.push("Missing top-level default_model.".to_string());
    }

    let providers_table = parsed
        .get("providers")
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();
    let models_table = parsed
        .get("models")
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default();

    if providers_table.is_empty() {
        structure_issues.push("No [providers] entries found.".to_string());
    }
    if models_table.is_empty() {
        structure_issues.push("No [models] entries found.".to_string());
    }
    if !default_model.is_empty() && !models_table.contains_key(&default_model) {
        structure_issues.push(format!(
            "default_model '{default_model}' is not defined under [models]."
        ));
    }

    let mut models_by_provider: HashMap<String, Vec<Value>> = HashMap::new();
    for (alias, model_table) in &models_table {
        let model_entry = model_table
            .as_table()
            .map(|table| {
                build_model_binding_summary(alias, table, &default_model, &providers_table)
            })
            .unwrap_or_else(|| {
                json!({
                    "alias": alias,
                    "upstreamModel": "",
                    "isDefault": alias == default_model.as_str(),
                    "capabilities": [],
                    "supportEfforts": Value::Null,
                    "maxContextSize": 0,
                    "issues": ["Model entry must be a TOML table."],
                })
            });

        if let Some(issues) = model_entry.get("issues").and_then(Value::as_array) {
            for issue in issues {
                if let Some(text) = issue.as_str() {
                    structure_issues.push(format!("{alias}: {text}"));
                }
            }
        }

        let provider_name = model_table
            .as_table()
            .and_then(|table| table.get("provider"))
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(alias.as_str())
            .to_string();
        models_by_provider
            .entry(provider_name)
            .or_default()
            .push(model_entry);
    }

    let referenced_providers: HashSet<String> = models_by_provider.keys().cloned().collect();
    let mut providers = Vec::new();
    for (name, provider_table) in &providers_table {
        let summary = build_provider_summary(name, provider_table, models_by_provider.get(name));
        if let Some(issues) = summary.get("issues").and_then(Value::as_array) {
            for issue in issues {
                if let Some(text) = issue.as_str() {
                    structure_issues.push(format!("provider '{name}': {text}"));
                }
            }
        }
        providers.push(summary);
    }

    for name in &referenced_providers {
        if !providers_table.contains_key(name) {
            structure_issues.push(format!("Model references missing provider '{name}'."));
            providers.push(json!({
                "name": name,
                "providerType": "",
                "baseUrl": Value::Null,
                "credentialStatus": "not_configured",
                "credentialHint": "Provider section missing from config.",
                "models": models_by_provider.get(name).cloned().unwrap_or_default(),
                "issues": ["Provider section is missing from config.toml."],
            }));
        }
    }

    providers.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(right.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    for models in models_by_provider.values_mut() {
        models.sort_by(|left, right| {
            left.get("alias")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(right.get("alias").and_then(Value::as_str).unwrap_or(""))
        });
    }

    let mut orphan_providers = Vec::new();
    for name in providers_table.keys() {
        if !referenced_providers.contains(name) {
            orphan_providers.push(name.clone());
        }
    }
    if !orphan_providers.is_empty() {
        structure_issues.push(format!(
            "Providers without model bindings: {}.",
            orphan_providers.join(", ")
        ));
    }

    structure_issues.sort();
    structure_issues.dedup();

    Ok(json!({
        "configPath": path_string,
        "defaultModel": default_model,
        "structureValid": structure_issues.is_empty(),
        "structureIssues": structure_issues,
        "providers": providers,
        "kimiAccountCredentialsPresent": managed_usage::credentials_present(),
        "acpAuth": acp_auth_snapshot(),
    }))
}

fn load_config_toml(path: &std::path::Path) -> Result<toml::Value, String> {
    if !path.exists() {
        return Ok(toml::Value::Table(toml::map::Map::new()));
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    content
        .parse::<toml::Value>()
        .map_err(|e| format!("Invalid Kimi config TOML: {e}"))
}

fn build_provider_summary(
    name: &str,
    provider_table: &toml::Value,
    models: Option<&Vec<Value>>,
) -> Value {
    let table = provider_table.as_table();
    let provider_type = table
        .and_then(|value| value.get("type"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("")
        .to_string();
    let base_url = table
        .and_then(|value| value.get("base_url"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let (credential_status, credential_hint) = resolve_credential_status(table, &provider_type);

    let mut issues = Vec::new();
    if provider_type.is_empty() {
        issues.push("Missing provider type.".to_string());
    }

    json!({
        "name": name,
        "providerType": provider_type,
        "baseUrl": base_url,
        "credentialStatus": credential_status,
        "credentialHint": credential_hint,
        "models": models.cloned().unwrap_or_default(),
        "issues": issues,
    })
}

fn resolve_credential_status(
    table: Option<&toml::map::Map<String, toml::Value>>,
    provider_type: &str,
) -> (String, String) {
    let lowered_type = provider_type.trim().to_ascii_lowercase();
    let kimi_login_present = managed_usage::credentials_present();

    if lowered_type == "kimi" && kimi_login_present {
        return (
            "configured".to_string(),
            "Kimi account credentials present (kimi login).".to_string(),
        );
    }

    if let Some(table) = table {
        if let Some(env_name) = read_non_empty_string(table, "api_key_env") {
            let env_present = std::env::var(&env_name)
                .ok()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
            if env_present {
                return (
                    "configured".to_string(),
                    format!("Environment variable {env_name} is set."),
                );
            }
            return (
                "not_configured".to_string(),
                format!("Expected environment variable {env_name} is not set."),
            );
        }

        if read_non_empty_string(table, "api_key").is_some() {
            return (
                "configured".to_string(),
                "api_key is set in config.toml.".to_string(),
            );
        }
    }

    if lowered_type == "kimi" {
        return (
            "not_configured".to_string(),
            "Sign in via Kimi login or set provider credentials in config.toml.".to_string(),
        );
    }

    (
        "not_configured".to_string(),
        "No api_key configured for this provider.".to_string(),
    )
}

fn read_non_empty_string(table: &toml::map::Map<String, toml::Value>, key: &str) -> Option<String> {
    table
        .get(key)
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn build_model_binding_summary(
    alias: &str,
    model_table: &toml::map::Map<String, toml::Value>,
    default_model: &str,
    providers_table: &toml::map::Map<String, toml::Value>,
) -> Value {
    let provider_name = model_table
        .get("provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(alias)
        .to_string();
    let upstream_model = model_table
        .get("model")
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let max_context_size = model_table
        .get("max_context_size")
        .and_then(toml::Value::as_integer)
        .unwrap_or(0)
        .max(0) as u64;
    let capabilities = model_table
        .get("capabilities")
        .and_then(toml::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty());
    let support_efforts = model_table
        .get("support_efforts")
        .and_then(toml::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty());

    let mut issues = Vec::new();
    if upstream_model.is_empty() {
        issues.push("Missing upstream model id.".to_string());
    }
    if !providers_table.contains_key(&provider_name) {
        issues.push(format!("Provider '{provider_name}' is not defined."));
    }

    let mut entry = json!({
        "alias": alias,
        "upstreamModel": upstream_model,
        "provider": provider_name,
        "isDefault": alias == default_model,
        "maxContextSize": max_context_size,
        "issues": issues,
    });
    if let Some(caps) = capabilities {
        entry
            .as_object_mut()
            .expect("model entry object")
            .insert("capabilities".to_string(), json!(caps));
    }
    if let Some(efforts) = support_efforts {
        entry
            .as_object_mut()
            .expect("model entry object")
            .insert("supportEfforts".to_string(), json!(efforts));
    }
    entry
}

/// Strip secret-like fields before any config content could be logged from this module.
#[allow(dead_code)]
pub fn redact_secret_fields(value: &mut toml::Value) {
    match value {
        toml::Value::Table(table) => {
            let keys: Vec<String> = table.keys().cloned().collect();
            for key in keys {
                if is_secret_field_name(&key) {
                    table.insert(key, toml::Value::String("[redacted]".to_string()));
                    continue;
                }
                if let Some(nested) = table.get_mut(&key) {
                    redact_secret_fields(nested);
                }
            }
        }
        toml::Value::Array(items) => {
            for item in items {
                redact_secret_fields(item);
            }
        }
        _ => {}
    }
}

fn is_secret_field_name(name: &str) -> bool {
    let lowered = name.trim().to_ascii_lowercase();
    SECRET_FIELD_NAMES
        .iter()
        .any(|candidate| lowered.contains(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn write_config(dir: &Path, content: &str) {
        fs::write(dir.join("config.toml"), content).expect("config written");
    }

    #[test]
    fn overview_never_returns_api_key_material() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_env::lock::set_kimi_code_home(dir.path());
        write_config(
            dir.path(),
            r#"default_model = "demo"

[providers.demo]
type = "openai"
base_url = "https://api.example.com/v1"
api_key = "super-secret-key-value"

[models.demo]
provider = "demo"
model = "gpt-test"
max_context_size = 128000
capabilities = ["thinking"]
"#,
        );

        let overview = get_providers_overview().expect("overview loads");
        let serialized = overview.to_string();
        assert!(!serialized.contains("super-secret-key-value"));
        assert_eq!(
            overview["providers"][0]["credentialStatus"].as_str(),
            Some("configured")
        );
        assert!(overview["providers"][0]["credentialHint"]
            .as_str()
            .unwrap()
            .contains("api_key"));
    }

    #[test]
    fn overview_reports_missing_provider_reference() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _home = crate::test_env::lock::set_kimi_code_home(dir.path());
        write_config(
            dir.path(),
            r#"default_model = "demo"

[models.demo]
provider = "missing"
model = "gpt-test"
"#,
        );

        let overview = get_providers_overview().expect("overview loads");
        assert_eq!(overview["structureValid"], false);
        let issues = overview["structureIssues"]
            .as_array()
            .expect("issues array");
        assert!(issues
            .iter()
            .any(|issue| issue.as_str().unwrap_or("").contains("missing provider")));
    }

    #[test]
    fn sanitize_auth_message_redacts_long_tokens() {
        let sanitized = sanitize_auth_message(
            "authenticate failed: token sk-abcdefghijklmnopqrstuvwxyz1234567890 rejected",
        );
        assert!(!sanitized.contains("sk-abcdefghijklmnopqrstuvwxyz1234567890"));
        assert!(sanitized.contains("[redacted]"));
    }

    #[test]
    fn acp_auth_failure_snapshot_is_recorded_and_cleared() {
        clear_acp_auth_failure();
        record_acp_auth_failure("Kimi Code rejected the configured provider credentials.");
        let overview = get_providers_overview().expect("overview loads");
        assert_eq!(overview["acpAuth"]["status"], "failed");
        assert!(overview["acpAuth"]["lastFailureMessage"]
            .as_str()
            .unwrap_or("")
            .contains("rejected"));
        clear_acp_auth_failure();
        let cleared = get_providers_overview().expect("overview loads");
        assert_eq!(cleared["acpAuth"]["status"], "unknown");
    }
}
