//! Config/provider-family Tauri commands over the source runtime (M4 wave 1).
//!
//! The pre-cutover adapters shelled out to an installed `kimi` CLI; every
//! command here now drives the bundled source runtime through the typed
//! [`RuntimeClient`]:
//!
//! - structured global-config writes fan out one `config.update` per
//!   camelCase config domain (`defaultModel`, `thinking`, `defaultPlanMode`,
//!   `experimental`, `secondaryModel`) with `target: "user"`, mirroring the
//!   SDK v2 `setConfig` fan-out; hot-applied, no worker restart.
//! - raw `config.toml` / `mcp.json` saves keep the whole-file write (editor
//!   fidelity, comments preserved) plus a supervisor rebuild: the live
//!   generation is drained via `runtime.shutdown`, a fresh child re-reads the
//!   file at startup, and previously-open sessions are re-opened eagerly so
//!   the frontend reconnect is fast.
//! - provider catalog/imports come from the runtime process (models.dev with
//!   a 10s fetch timeout and the bundled snapshot fallback; first call may be
//!   slow), and the managed-usage panel reads the runtime's `usage.get`.
//!
//! Read-only local commands (`get_global_config`, `get_config_toml`,
//! `get_mcp_config`, `get_providers_overview`, `fetch_usage_stats`) are
//! untouched: the engine is the single writer, the desktop reads the file.

use crate::global_config;
use crate::runtime::client::{
    ConfigTarget, ConfigUpdateParams, ProvidersImportCatalogConfig, ProvidersImportRegistryConfig,
    RuntimeClient,
};
use crate::runtime::host::RuntimeHost;
use crate::runtime::protocol::RuntimeInfo;
use crate::runtime::supervisor::{RuntimeError, RuntimeSupervisor, ShutdownConfig};
use crate::runtime_check;
use crate::security::validate_mcp_config_json;
use crate::session_config::{
    agent_runtime_capabilities_to_value, session_config_state_to_value, AgentRuntimeCapabilities,
    AuthMethodSummary, SessionConfigChoice, SessionConfigOption, SessionConfigState,
    SessionConfigStatus,
};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

const DEFAULT_MCP_JSON: &str = "{\n  \"mcpServers\": {}\n}\n";

/// Bound for runtime config/session calls, matching the host `CALL_TIMEOUT`.
const CONFIG_CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Catalog reads may hit the runtime-side models.dev fetch (bounded at 10s by
/// the runtime, then the bundled snapshot fallback); leave headroom on the
/// wire timeout so the first cold call is not a false failure.
const CATALOG_CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// Provider imports fetch remote registries and write config; generous bound.
const IMPORT_CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Supervisor teardown for the config-rebuild path (host `HOST_SHUTDOWN`):
/// short enough to never block on a wedged runtime, long enough to drain.
const REBUILD_SHUTDOWN: ShutdownConfig = ShutdownConfig {
    response_timeout: Duration::from_secs(5),
    exit_timeout: Duration::from_secs(5),
};

fn kimi_config_path(file_name: &str) -> Result<PathBuf, String> {
    Ok(runtime_check::kimi_code_home_dir()?.join(file_name))
}

fn read_kimi_config_file(file_name: &str, default_content: &str) -> Result<Value, String> {
    let path = kimi_config_path(file_name)?;
    let content = if path.exists() {
        fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?
    } else {
        default_content.to_string()
    };

    Ok(json!({
        "content": content,
        "path": path.to_string_lossy(),
    }))
}

fn write_kimi_config_file(file_name: &str, content: &str) -> Result<Value, String> {
    let path = kimi_config_path(file_name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    Ok(json!({
        "success": true,
        "error": Value::Null,
    }))
}

fn validate_toml(content: &str) -> Result<(), String> {
    toml::from_str::<toml::Value>(content)
        .map(|_| ())
        .map_err(|e| format!("Invalid TOML: {}", e))
}

fn validate_json(content: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(content).map_err(|e| format!("Invalid JSON: {}", e))
}

fn validate_mcp_config(content: &str) -> Result<(), String> {
    let value = validate_json(content)?;
    validate_mcp_config_json(&value)
}

// ---------------------------------------------------------------------------
// Local reads (engine is the single writer; desktop reads the file)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_global_config() -> Result<Value, String> {
    global_config::get_global_config()
}

#[tauri::command]
pub fn get_config_toml() -> Result<Value, String> {
    read_kimi_config_file("config.toml", "")
}

#[tauri::command]
pub fn get_providers_overview() -> Result<Value, String> {
    crate::provider_config::get_providers_overview()
}

#[tauri::command]
pub fn get_mcp_config() -> Result<Value, String> {
    read_kimi_config_file("mcp.json", DEFAULT_MCP_JSON)
}

#[tauri::command]
pub async fn fetch_usage_stats(range: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || crate::usage_stats::fetch_usage_stats(&range))
        .await
        .map_err(|e| format!("Failed to join usage stats fetch: {e}"))?
}

// ---------------------------------------------------------------------------
// Structured global-config writes (`config.update` per domain)
// ---------------------------------------------------------------------------

/// Map the frontend `update_global_config` fields onto the runtime config
/// domains (`configUpdateParamsSchema`): one `(domain, patch)` per provided
/// field, mirroring the SDK v2 `setConfig` fan-out. Domain names and patch
/// shapes follow the agent-core-v2 config sections (`defaultModel`,
/// `thinking`, `defaultPlanMode`, `experimental` flag ids verbatim,
/// `secondaryModel` camelCase). Each domain patch is a per-domain deep merge,
/// so multiple entries for one domain compose.
fn global_config_domain_patches(
    default_model: Option<&str>,
    default_thinking: Option<bool>,
    thinking_effort: Option<&str>,
    default_plan_mode: Option<bool>,
    secondary_model: Option<&str>,
    secondary_default_effort: Option<&str>,
    secondary_model_experiment_enabled: Option<bool>,
) -> Vec<(&'static str, Value)> {
    let mut patches = Vec::new();
    if let Some(model) = default_model {
        patches.push(("defaultModel", json!(model)));
    }
    if let Some(enabled) = default_thinking {
        patches.push(("thinking", json!({ "enabled": enabled })));
    }
    if let Some(effort) = thinking_effort {
        patches.push(("thinking", json!({ "effort": effort })));
    }
    if let Some(plan_mode) = default_plan_mode {
        patches.push(("defaultPlanMode", json!(plan_mode)));
    }
    if let Some(enabled) = secondary_model_experiment_enabled {
        patches.push(("experimental", json!({ "secondary-model": enabled })));
    }
    if let Some(model) = secondary_model {
        patches.push(("secondaryModel", json!({ "model": model })));
    }
    if let Some(effort) = secondary_default_effort {
        patches.push(("secondaryModel", json!({ "defaultEffort": effort })));
    }
    patches
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri exposes these as stable named IPC fields.
pub async fn update_global_config(
    app: tauri::AppHandle,
    default_model: Option<String>,
    default_thinking: Option<bool>,
    thinking_effort: Option<String>,
    default_plan_mode: Option<bool>,
    secondary_model: Option<String>,
    secondary_default_effort: Option<String>,
    secondary_model_experiment_enabled: Option<bool>,
    _restart_running_sessions: Option<bool>,
    _force_restart_busy_sessions: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        // Structured fields hot-apply through the engine; no worker restart.
        // `restart_running_sessions` / `force_restart_busy_sessions` are
        // accepted for signature parity but are no-ops (M4 decision).
        for (domain, patch) in global_config_domain_patches(
            default_model.as_deref(),
            default_thinking,
            thinking_effort.as_deref(),
            default_plan_mode,
            secondary_model.as_deref(),
            secondary_default_effort.as_deref(),
            secondary_model_experiment_enabled,
        ) {
            client
                .config_update(
                    &ConfigUpdateParams {
                        domain: domain.to_string(),
                        patch,
                        target: Some(ConfigTarget::User),
                    },
                    CONFIG_CALL_TIMEOUT,
                )
                .map_err(|err| runtime_error_message("config.update", err))?;
        }
        // Re-read the local file for the response `config` field (the engine
        // is the writer; the desktop is a reader).
        let config = global_config::get_global_config()?;
        Ok(json!({
            "config": config,
            "restarted_session_ids": Value::Null,
            "skipped_busy_session_ids": Value::Null,
        }))
    })
    .await
    .map_err(|e| format!("Failed to join update_global_config: {e}"))?
}

// ---------------------------------------------------------------------------
// Raw file writes (whole-file write + supervisor rebuild)
// ---------------------------------------------------------------------------

/// Sessions to report as restarted, plus busy-session skips (always empty on
/// the M4 rebuild path — every open session restarts).
struct RestartSummary {
    restarted: Vec<String>,
    skipped: Vec<String>,
}

/// Rebuild the runtime after a raw config write: drain the live generation
/// (`runtime.shutdown`, bounded), let the next `ensure_started` spawn a fresh
/// child that re-reads `config.toml` / `mcp.json` at startup, then re-open
/// every previously-open session so the frontend reconnect is fast.
///
/// This uses the supervisor's graceful drain, NOT `RuntimeHost::shutdown` —
/// that is the app-exit path and permanently marks the host as shutting down.
/// The supervisor's state lands on `Stopped` after the drain, which is
/// exactly the state `ensure_started` rebuilds from; the event pump self-exits
/// on `Stopped` (see `runtime/host/event_pump.rs`).
fn rebuild_runtime_after_config(app: &tauri::AppHandle) -> Result<RestartSummary, String> {
    let host = app.state::<RuntimeHost>();
    host.install_app(app);
    let open_ids: Vec<String> = host
        .list_workers()
        .into_iter()
        .map(|worker| worker.session_id)
        .collect();
    let supervisor = host.ensure_started()?;
    supervisor
        .shutdown(&REBUILD_SHUTDOWN)
        .map_err(|err| format!("runtime shutdown before config reload failed: {err}"))?;
    let restarted = host.ensure_started()?;
    reopen_sessions(&restarted, &open_ids);
    Ok(RestartSummary {
        restarted: open_ids,
        skipped: Vec::new(),
    })
}

/// Best-effort eager `session.open` on the rebuilt generation. A failure is
/// logged, not fatal: the frontend reconnect path (`connect_leased`) re-opens
/// sessions lazily on its next use regardless.
fn reopen_sessions(supervisor: &RuntimeSupervisor, session_ids: &[String]) {
    let client = RuntimeClient::new(supervisor);
    for session_id in session_ids {
        if let Err(err) = client.session_open(session_id, CONFIG_CALL_TIMEOUT) {
            eprintln!(
                "[config] failed to re-open session `{session_id}` after config reload: {err}"
            );
        }
    }
}

fn restarted_field(ids: &[String]) -> Value {
    if ids.is_empty() {
        Value::Null
    } else {
        json!(ids)
    }
}

#[tauri::command]
pub async fn update_config_toml(app: tauri::AppHandle, content: String) -> Result<Value, String> {
    validate_toml(&content)?;
    write_kimi_config_file("config.toml", &content)?;
    let summary = tauri::async_runtime::spawn_blocking(move || rebuild_runtime_after_config(&app))
        .await
        .map_err(|e| format!("Failed to join config reload task: {e}"))??;
    Ok(json!({
        "success": true,
        "error": Value::Null,
        "restarted_session_ids": restarted_field(&summary.restarted),
        "skipped_busy_session_ids": restarted_field(&summary.skipped),
    }))
}

#[tauri::command]
pub async fn update_mcp_config(app: tauri::AppHandle, content: String) -> Result<Value, String> {
    validate_mcp_config(&content)?;
    write_kimi_config_file("mcp.json", &content)?;
    let summary = tauri::async_runtime::spawn_blocking(move || rebuild_runtime_after_config(&app))
        .await
        .map_err(|e| format!("Failed to join config reload task: {e}"))??;
    Ok(json!({
        "success": true,
        "error": Value::Null,
        "restarted_session_ids": restarted_field(&summary.restarted),
        "skipped_busy_session_ids": restarted_field(&summary.skipped),
    }))
}

// ---------------------------------------------------------------------------
// Provider catalog / imports (runtime process, models.dev + snapshot)
// ---------------------------------------------------------------------------

/// The catalog now comes from inside the runtime process: a models.dev fetch
/// with a 10s timeout and the bundled offline snapshot as fallback. The first
/// call can be slow (network fetch before the fallback); the UI keeps its
/// loading state.
#[tauri::command]
pub async fn list_provider_catalog(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let result = client
            .providers_catalog_list(CATALOG_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("providers.catalog.list", err))?;
        Ok(json!(result
            .providers
            .iter()
            .map(|provider| json!({
                "id": provider.id,
                "name": provider.name,
                "modelCount": provider.model_count,
            }))
            .collect::<Vec<_>>()))
    })
    .await
    .map_err(|e| format!("Failed to join provider catalog task: {e}"))?
}

#[tauri::command]
pub async fn get_provider_catalog_entry(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<Value, String> {
    let provider_id = validate_required(&provider_id, "Provider ID")?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let entry = client
            .providers_catalog_get(&provider_id, CATALOG_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("providers.catalog.get", err))?;
        Ok(json!({
            "providerId": entry.provider_id,
            "name": entry.name,
            "models": entry.models.iter().map(|model| json!({
                "id": model.id,
                "name": model.name,
                "maxContextTokens": model.max_context_tokens,
            })).collect::<Vec<_>>(),
        }))
    })
    .await
    .map_err(|e| format!("Failed to join provider catalog task: {e}"))?
}

/// Import a models.dev directory entry as a configured provider. An explicit
/// `defaultModel` is validated against the entry by the runtime and applied
/// as the global default alias — the same semantics as the CLI's
/// `provider catalog add --default-model`. Structured rejections
/// (`catalog_entry_not_found`, `catalog_import_invalid`,
/// `provider_oauth_managed`) surface code + message, which the frontend
/// dialog renders as a displayable error.
#[tauri::command]
pub async fn import_provider_from_catalog(
    app: tauri::AppHandle,
    provider_id: String,
    api_key: String,
    default_model: Option<String>,
    base_url: Option<String>,
) -> Result<Value, String> {
    let provider_id = validate_required(&provider_id, "Provider ID")?;
    let api_key = validate_required(&api_key, "API key")?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let config = ProvidersImportCatalogConfig {
            api_key,
            default_model,
            base_url,
        };
        client
            .providers_import_catalog(&provider_id, &config, IMPORT_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("providers.import", err))?;
        Ok(provider_import_result())
    })
    .await
    .map_err(|e| format!("Failed to join provider import task: {e}"))?
}

/// Import a custom registry `api.json` document. The registry token travels
/// in the import config (the runtime never logs it); the runtime classifies
/// failures as `registry_auth_required` / `registry_unavailable` /
/// `registry_invalid`, surfaced code + message.
#[tauri::command]
pub async fn import_provider_registry(
    app: tauri::AppHandle,
    registry_url: String,
    api_key: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        let config = ProvidersImportRegistryConfig {
            api_key: Some(api_key),
        };
        client
            .providers_import_registry(&registry_url, Some(&config), IMPORT_CALL_TIMEOUT)
            .map_err(|err| runtime_error_message("providers.import", err))?;
        Ok(provider_import_result())
    })
    .await
    .map_err(|e| format!("Failed to join provider import task: {e}"))?
}

/// Imports write config but do not touch live sessions: `restarted_session_ids`
/// is null so the frontend skips the reconnect flow.
fn provider_import_result() -> Value {
    json!({
        "success": true,
        "restarted_session_ids": Value::Null,
        "skipped_busy_session_ids": Value::Null,
    })
}

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

// ---------------------------------------------------------------------------
// Version / capabilities / session-config / usage (handshake cache + host)
// ---------------------------------------------------------------------------

/// `get_kimi_cli_version` keeps its name but reads the bundled runtime: the
/// handshake cache's `kimi_source.tag` (`@moonshot-ai/kimi-code@0.33.0`)
/// stripped to the version string. The runtime is started on demand if it is
/// not up; an unresolvable version degrades like the ACP-era probe (error,
/// frontend falls back to the build-time constant).
#[tauri::command]
pub async fn get_kimi_cli_version(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        host.ensure_started()?;
        let info = host.runtime_info().ok_or_else(|| {
            "Unable to resolve Kimi Code runtime version (no handshake cache)".to_string()
        })?;
        Ok(kimi_source_version(&info.kimi_source.tag))
    })
    .await
    .map_err(|e| format!("Failed to join Kimi Code CLI version lookup: {e}"))?
}

/// `@moonshot-ai/kimi-code@0.33.0` -> `0.33.0` (the trailing `@`-suffix).
fn kimi_source_version(tag: &str) -> String {
    tag.rsplit('@').next().unwrap_or(tag).to_string()
}

/// Adapt the runtime handshake `RuntimeInfo` onto the ACP-era
/// `AgentRuntimeCapabilities` DTO the frontend still consumes
/// (`src/lib/acp-capabilities.ts`): `loadSession` follows the runtime `replay`
/// gate, `sessionList` the `sessions` gate, `sessionConfigOptions` the
/// `config` gate; prompt image is always on (attachments ride `turn.start`
/// input parts), audio and the ACP MCP bridge are off; auth methods are the
/// single `login` flow when the runtime reports `auth`.
fn capabilities_from_info(info: &RuntimeInfo, stale: bool) -> AgentRuntimeCapabilities {
    AgentRuntimeCapabilities {
        protocol_version: None,
        agent_name: None,
        agent_version: Some(info.kimi_source.tag.clone()),
        load_session: info.capabilities.replay,
        prompt_image: true,
        prompt_audio: false,
        prompt_embedded_context: false,
        mcp_http: false,
        mcp_sse: false,
        session_list: info.capabilities.sessions,
        session_resume: false,
        session_config_options: info.capabilities.config,
        auth_methods: if info.capabilities.auth {
            vec![AuthMethodSummary {
                id: "login".to_string(),
                name: None,
                description: None,
            }]
        } else {
            Vec::new()
        },
        capabilities_stale: stale,
    }
}

#[tauri::command]
pub async fn get_agent_runtime_capabilities(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        match host.ensure_started() {
            Ok(_) => {
                let info = host
                    .runtime_info()
                    .ok_or_else(|| "runtime did not report handshake info".to_string())?;
                Ok(agent_runtime_capabilities_to_value(
                    &capabilities_from_info(&info, false),
                ))
            }
            Err(err) => match host.runtime_info() {
                // Runtime unreachable but a handshake cache remains: serve the
                // cached capabilities marked stale (frontend disables model
                // controls), mirroring the ACP-era probe-failure fallback.
                Some(info) => Ok(agent_runtime_capabilities_to_value(
                    &capabilities_from_info(&info, true),
                )),
                None => Err(format!("runtime capabilities unavailable: {err}")),
            },
        }
    })
    .await
    .map_err(|e| format!("Failed to join get_agent_runtime_capabilities: {e}"))?
}

/// Translate the runtime's raw `session.config` payload (the wave-1
/// `options` array, ACP-compatible camelCase records) into the frontend
/// `SessionConfigState`; absent/empty options yield `unknown`.
fn session_config_from_snapshot(session_id: &str, payload: &Value) -> SessionConfigState {
    let options = payload
        .get("options")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(parse_config_option).collect::<Vec<_>>())
        .unwrap_or_default();
    if options.is_empty() {
        return SessionConfigState::unknown(session_id);
    }
    SessionConfigState {
        session_id: session_id.to_string(),
        status: SessionConfigStatus::Known,
        options,
    }
}

fn parse_config_option(raw: &Value) -> SessionConfigOption {
    SessionConfigOption {
        id: raw
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        option_type: raw
            .get("optionType")
            .or_else(|| raw.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        label: raw.get("label").and_then(Value::as_str).map(str::to_string),
        current_value: raw
            .get("currentValue")
            .or_else(|| raw.get("current_value"))
            .cloned(),
        options: raw.get("options").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .map(|item| SessionConfigChoice {
                    value: item.get("value").cloned().unwrap_or_else(|| item.clone()),
                    label: item
                        .get("label")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
                .collect()
        }),
    }
}

/// `get_session_config_state` reads the host's per-session config snapshot
/// (projected from `session.config` events by the pump); the type stays
/// borrowed from `crate::session_config` (the M4 session-config model).
#[tauri::command]
pub fn get_session_config_state(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Value, String> {
    let host = app.state::<RuntimeHost>();
    host.install_app(&app);
    let state = host
        .session_config_snapshot(&session_id)
        .map(|payload| session_config_from_snapshot(&session_id, &payload))
        .unwrap_or_else(|| SessionConfigState::unknown(&session_id));
    Ok(session_config_state_to_value(&state))
}

/// `fetch_managed_usage` reads the runtime's `usage.get` (the raw platform
/// quota body) and wraps it in the existing `{kind, payload}` / `{kind,
/// error}` DTO the frontend quota panel consumes.
#[tauri::command]
pub async fn fetch_managed_usage(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let supervisor = host.ensure_started()?;
        let client = RuntimeClient::new(&supervisor);
        Ok(usage_result_value(client.usage_get(CONFIG_CALL_TIMEOUT)))
    })
    .await
    .map_err(|e| format!("Failed to join managed usage fetch: {e}"))?
}

fn usage_result_value(result: Result<Value, RuntimeError>) -> Value {
    match result {
        Ok(payload) => json!({ "kind": "ok", "payload": payload }),
        Err(err) => json!({ "kind": "error", "message": runtime_error_message("usage.get", err) }),
    }
}

// ---------------------------------------------------------------------------
// Runtime readiness
// ---------------------------------------------------------------------------

/// Full source-runtime readiness gate; the DTO and pipeline live in
/// `runtime_check.rs` (the retained config checks + the three-stage
/// artifact/probe gate), so the frontend overlay needs no changes.
#[tauri::command]
pub async fn check_runtime_readiness() -> Result<runtime_check::RuntimeReadiness, String> {
    tauri::async_runtime::spawn_blocking(runtime_check::check_source_runtime_readiness)
        .await
        .map_err(|e| format!("Failed to join runtime readiness check: {e}"))
}

// ---------------------------------------------------------------------------
// Command-level error mapping (mirrors commands/auth.rs)
// ---------------------------------------------------------------------------

/// A runtime `Rejected` (well-formed `ok: false`) surfaces its code and
/// message, which the frontend tolerates as a displayable error; fatal
/// failures (protocol, io, timeout, unexpected exit) surface as an operation
/// failure.
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
    use crate::runtime::protocol::{KimiSourceInfo, RuntimeCapabilities};
    use crate::runtime::supervisor::RuntimeError;
    use crate::session_config::SessionConfigStatus;

    fn runtime_info() -> RuntimeInfo {
        RuntimeInfo {
            selected_protocol: "runtime-v1".to_string(),
            runtime_version: "0.0.0-test".to_string(),
            kimi_source: KimiSourceInfo {
                tag: "@moonshot-ai/kimi-code@0.33.0".to_string(),
                commit: "abc".to_string(),
            },
            node_version: "24.15.0".to_string(),
            capabilities: RuntimeCapabilities {
                methods: Vec::new(),
                sessions: true,
                turns: true,
                config: true,
                replay: true,
                auth: true,
                usage: true,
                fork: true,
                events: Vec::new(),
            },
            data_schema_version: 1,
        }
    }

    #[test]
    fn global_config_patches_follow_runtime_domains() {
        let patches = global_config_domain_patches(
            Some("kimi-code/kimi-for-coding"),
            Some(true),
            Some("high"),
            Some(false),
            Some("secondary-probe"),
            Some("low"),
            Some(true),
        );
        assert_eq!(
            patches,
            vec![
                ("defaultModel", json!("kimi-code/kimi-for-coding")),
                ("thinking", json!({ "enabled": true })),
                ("thinking", json!({ "effort": "high" })),
                ("defaultPlanMode", json!(false)),
                ("experimental", json!({ "secondary-model": true })),
                ("secondaryModel", json!({ "model": "secondary-probe" })),
                ("secondaryModel", json!({ "defaultEffort": "low" })),
            ]
        );
    }

    #[test]
    fn global_config_patches_skip_unset_fields() {
        assert_eq!(
            global_config_domain_patches(None, None, None, None, None, None, None),
            vec![]
        );
    }

    #[test]
    fn capabilities_map_runtime_gates_onto_frontend_dto() {
        let caps = capabilities_from_info(&runtime_info(), false);
        assert!(caps.load_session);
        assert!(caps.session_list);
        assert!(caps.session_config_options);
        assert!(caps.prompt_image);
        assert!(!caps.prompt_audio);
        assert!(!caps.mcp_http);
        assert!(!caps.mcp_sse);
        assert_eq!(
            caps.agent_version.as_deref(),
            Some("@moonshot-ai/kimi-code@0.33.0")
        );
        assert_eq!(caps.auth_methods.len(), 1);
        assert_eq!(caps.auth_methods[0].id, "login");
        assert!(!caps.capabilities_stale);
    }

    #[test]
    fn capabilities_mark_stale_when_runtime_unreachable_with_cache() {
        assert!(capabilities_from_info(&runtime_info(), true).capabilities_stale);
    }

    #[test]
    fn kimi_source_tag_strips_to_version_string() {
        assert_eq!(
            kimi_source_version("@moonshot-ai/kimi-code@0.33.0"),
            "0.33.0"
        );
        assert_eq!(kimi_source_version("0.33.0"), "0.33.0");
    }

    #[test]
    fn session_config_snapshot_maps_options_to_known_state() {
        let payload = json!({
            "options": [
                { "id": "model", "optionType": "enum", "label": "Model",
                  "currentValue": "kimi-k2", "options": [{ "value": "kimi-k2", "label": "K2" }] },
                { "id": "thinking", "type": "enum", "currentValue": "high" },
            ]
        });
        let state = session_config_from_snapshot("sess-1", &payload);
        assert_eq!(state.session_id, "sess-1");
        assert_eq!(state.status, SessionConfigStatus::Known);
        assert_eq!(state.options.len(), 2);
        assert_eq!(
            state.option_by_id("model").unwrap().current_value,
            Some(json!("kimi-k2"))
        );
        assert_eq!(state.option_by_id("thinking").unwrap().option_type, "enum");
    }

    #[test]
    fn session_config_snapshot_without_options_is_unknown() {
        let state = session_config_from_snapshot("sess-1", &json!({ "model": "kimi-k2" }));
        assert_eq!(state.status, SessionConfigStatus::Unknown);
        assert!(state.options.is_empty());
    }

    #[test]
    fn usage_result_wraps_ok_and_error_kinds() {
        assert_eq!(
            usage_result_value(Ok(json!({ "used": 12 }))),
            json!({ "kind": "ok", "payload": { "used": 12 } })
        );
        let err = usage_result_value(Err(RuntimeError::Io("pipe closed".to_string())));
        assert_eq!(err["kind"], "error");
        assert!(err["message"]
            .as_str()
            .unwrap()
            .contains("usage.get failed"));
    }

    #[test]
    fn import_result_skips_session_restart() {
        let value = provider_import_result();
        assert_eq!(value["success"], true);
        assert_eq!(value["restarted_session_ids"], Value::Null);
        assert_eq!(value["skipped_busy_session_ids"], Value::Null);
    }

    #[test]
    fn required_input_validation_matches_cli_parity() {
        assert!(validate_required("  ", "Provider ID").is_err());
        assert_eq!(
            validate_required(" openai ", "Provider ID").unwrap(),
            "openai"
        );
        assert!(validate_required(&"x".repeat(2049), "Provider ID").is_err());
    }

    #[test]
    fn update_mcp_config_rejects_temp_command_paths() {
        use crate::security::validate_mcp_config_json;

        let dir = tempfile::TempDir::new().expect("tempdir");
        let exe = dir.path().join("evil.exe");
        std::fs::write(&exe, b"fake").expect("write fake exe");
        let config = serde_json::json!({
            "mcpServers": {
                "bad": { "command": exe.to_string_lossy() }
            }
        });
        assert!(validate_mcp_config_json(&config).is_err());
    }
}
