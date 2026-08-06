//! Non-interactive bridge to the installed `kimi provider` commands.
//!
//! Kimi Code owns catalog protocol inference, its offline models.dev snapshot,
//! and custom-registry refresh metadata. Desktop intentionally delegates those
//! rules instead of maintaining a second catalog implementation.

use crate::runtime_check;
use serde_json::{json, Value};
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const CATALOG_TIMEOUT: Duration = Duration::from_secs(45);
const IMPORT_TIMEOUT: Duration = Duration::from_secs(90);
const REGISTRY_KEY_ENV: &str = "KIMI_REGISTRY_API_KEY";

fn validate_required(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required."));
    }
    if trimmed.len() > 2048 {
        return Err(format!("{label} is too long."));
    }
    Ok(trimmed.to_string())
}

fn validate_optional_url(value: Option<&str>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 2048 || !(value.starts_with("https://") || value.starts_with("http://")) {
        return Err(format!("{label} must be an http(s) URL."));
    }
    Ok(Some(value.to_string()))
}

fn run_provider_command(
    args: &[String],
    secret: Option<&str>,
    timeout: Duration,
) -> Result<String, String> {
    let program = runtime_check::resolve_kimi_code_cli_program_blocking()?;
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(secret) = secret {
        command.env(REGISTRY_KEY_ENV, secret);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Kimi Code CLI: {error}"))?;
    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Kimi Code CLI stdout.".to_string())?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture Kimi Code CLI stderr.".to_string())?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout_pipe.read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr_pipe.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started_at = Instant::now();
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => {
                let stdout_bytes = stdout_reader
                    .join()
                    .map_err(|_| "Kimi Code CLI stdout reader panicked.".to_string())?
                    .map_err(|error| error.to_string())?;
                let stderr_bytes = stderr_reader
                    .join()
                    .map_err(|_| "Kimi Code CLI stderr reader panicked.".to_string())?
                    .map_err(|error| error.to_string())?;
                let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
                if status.success() {
                    return Ok(stdout);
                }
                let mut stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
                if let Some(secret) = secret.filter(|secret| !secret.is_empty()) {
                    stderr = stderr.replace(secret, "[redacted]");
                }
                if stderr.is_empty() {
                    stderr = "Kimi Code CLI did not provide an error message.".to_string();
                }
                return Err(format!("Provider operation failed: {stderr}"));
            }
            None if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Provider operation timed out.".to_string());
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn parse_json(stdout: &str, operation: &str) -> Result<Value, String> {
    serde_json::from_str(stdout)
        .map_err(|error| format!("Kimi Code returned invalid JSON for {operation}: {error}"))
}

pub fn list_catalog_providers() -> Result<Value, String> {
    let stdout = run_provider_command(
        &[
            "provider".to_string(),
            "catalog".to_string(),
            "list".to_string(),
            "--json".to_string(),
        ],
        None,
        CATALOG_TIMEOUT,
    )?;
    let raw = parse_json(&stdout, "provider catalog")?;
    summarize_catalog_providers(&raw)
}

fn summarize_catalog_providers(raw: &Value) -> Result<Value, String> {
    let entries = raw
        .as_object()
        .ok_or_else(|| "Kimi Code provider catalog must be a JSON object.".to_string())?;
    let mut providers = entries
        .iter()
        .map(|(key, provider)| {
            let id = provider.get("id").and_then(Value::as_str).unwrap_or(key);
            let name = provider.get("name").and_then(Value::as_str).unwrap_or(id);
            let model_count = provider
                .get("models")
                .and_then(Value::as_object)
                .map(|models| models.len())
                .unwrap_or(0);
            json!({ "id": id, "name": name, "modelCount": model_count })
        })
        .collect::<Vec<_>>();
    providers.sort_by(|left, right| {
        left["name"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .cmp(
                &right["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_ascii_lowercase(),
            )
    });
    Ok(json!(providers))
}

pub fn get_catalog_provider(provider_id: &str) -> Result<Value, String> {
    let provider_id = validate_required(provider_id, "Provider ID")?;
    let stdout = run_provider_command(
        &[
            "provider".to_string(),
            "catalog".to_string(),
            "list".to_string(),
            provider_id,
            "--json".to_string(),
        ],
        None,
        CATALOG_TIMEOUT,
    )?;
    parse_json(&stdout, "provider catalog details")
}

pub fn import_catalog_provider(
    provider_id: &str,
    api_key: &str,
    default_model: Option<&str>,
    base_url: Option<&str>,
) -> Result<(), String> {
    let provider_id = validate_required(provider_id, "Provider ID")?;
    let api_key = validate_required(api_key, "API key")?;
    let mut args = vec![
        "provider".to_string(),
        "catalog".to_string(),
        "add".to_string(),
        provider_id,
    ];
    if let Some(default_model) = default_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--default-model".to_string());
        args.push(default_model.to_string());
    }
    if let Some(base_url) = validate_optional_url(base_url, "Base URL")? {
        args.push("--base-url".to_string());
        args.push(base_url);
    }
    run_provider_command(&args, Some(&api_key), IMPORT_TIMEOUT)?;
    Ok(())
}

pub fn import_custom_registry(registry_url: &str, api_key: &str) -> Result<(), String> {
    let registry_url = validate_optional_url(Some(registry_url), "Registry URL")?
        .ok_or_else(|| "Registry URL is required.".to_string())?;
    let api_key = validate_required(api_key, "Registry token")?;
    run_provider_command(
        &["provider".to_string(), "add".to_string(), registry_url],
        Some(&api_key),
        IMPORT_TIMEOUT,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_summary_keeps_only_safe_picker_fields() {
        let raw = json!({
            "openai": {
                "id": "openai",
                "name": "OpenAI",
                "env": ["OPENAI_API_KEY"],
                "models": { "gpt-5": {}, "gpt-5-mini": {} }
            }
        });
        let result = summarize_catalog_providers(&raw).expect("summary");
        assert_eq!(
            result,
            json!([{"id":"openai","name":"OpenAI","modelCount":2}])
        );
        assert!(!result.to_string().contains("OPENAI_API_KEY"));
    }

    #[test]
    fn optional_urls_require_http_or_https() {
        assert!(validate_optional_url(Some("file:///tmp/api.json"), "Registry URL").is_err());
        assert_eq!(
            validate_optional_url(Some("https://example.com/api.json"), "Registry URL")
                .expect("valid"),
            Some("https://example.com/api.json".to_string())
        );
    }
}
