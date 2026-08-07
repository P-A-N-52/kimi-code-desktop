//! ACP capability and session-config normalization (G0).
//!
//! Two deliberately separate models:
//! - [`AgentRuntimeCapabilities`] — from `initialize` only (version, capability flags, auth summary).
//! - [`SessionConfigState`] — from `session/new`, `session/load`, and `config_option_update` only.
//!
//! ## RPC ownership (G0 decision)
//!
//! `session/set_config_option` MUST be sent on the **per-session wire worker RPC**
//! (`AcpProcessManager` / `AcpWorker::rpc`), the same channel that already owns
//! `session/set_mode`, `session/prompt`, and `session/cancel`. Rationale:
//!
//! 1. Config options are session-scoped; the wire worker is the sole owner of an
//!    authenticated, resumed ACP subprocess bound to one `sessionId`.
//! 2. `AcpDesktopClient` is a shared probe/list/new client — it must not become a
//!    second RPC owner for live session mutations (No-Go in G0 plan).
//! 3. Official Kimi ACP docs list `session/set_mode` as a compatibility alias for
//!    `set_config_option({ configId: "mode" })`; existing plan/permission handlers
//!    already use the wire worker path.
//!
//! `AcpDesktopClient` remains responsible for `session/list`, `session/new`, and
//! `session/close` only.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Summary of an authentication method from `initialize`; never stores secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodSummary {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
}

/// Runtime agent capabilities from the latest successful `initialize`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCapabilities {
    pub protocol_version: Option<u64>,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub load_session: bool,
    pub prompt_image: bool,
    pub prompt_audio: bool,
    pub prompt_embedded_context: bool,
    pub mcp_http: bool,
    pub mcp_sse: bool,
    pub session_list: bool,
    pub session_resume: bool,
    /// Agent advertises unified session config options (0.31+).
    pub session_config_options: bool,
    pub auth_methods: Vec<AuthMethodSummary>,
    /// Set when the latest live CLI probe failed but cached capabilities remain.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub capabilities_stale: bool,
}

impl AgentRuntimeCapabilities {
    /// Human-readable version hint for diagnostics; never used to hard-gate UI.
    pub fn version_hint(&self) -> Option<&str> {
        self.agent_version.as_deref()
    }

    pub fn supports_session_config_options(&self) -> bool {
        self.session_config_options
    }
}

/// One declared session configuration option (model / thinking / mode / future ids).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigOption {
    pub id: String,
    pub option_type: String,
    pub label: Option<String>,
    pub current_value: Option<Value>,
    pub options: Option<Vec<SessionConfigChoice>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigChoice {
    pub value: Value,
    pub label: Option<String>,
}

/// Per-session configuration snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigState {
    pub session_id: String,
    /// `known` when options were returned or refreshed; `unknown` when resume omitted them.
    pub status: SessionConfigStatus,
    pub options: Vec<SessionConfigOption>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionConfigStatus {
    Known,
    Unknown,
}

impl SessionConfigState {
    pub fn unknown(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            status: SessionConfigStatus::Unknown,
            options: Vec::new(),
        }
    }

    pub fn option_by_id(&self, config_id: &str) -> Option<&SessionConfigOption> {
        self.options.iter().find(|opt| opt.id == config_id)
    }

    pub fn has_option(&self, config_id: &str) -> bool {
        self.option_by_id(config_id).is_some()
    }
}

static SESSION_CONFIG_STORE: OnceLock<Mutex<HashMap<String, SessionConfigState>>> = OnceLock::new();

fn session_config_store() -> &'static Mutex<HashMap<String, SessionConfigState>> {
    SESSION_CONFIG_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn persist_session_config_best_effort(session_id: &str, state: &SessionConfigState) {
    if let Err(err) = crate::session_store::persist_session_config(session_id, state) {
        eprintln!("[acp_capabilities] failed to persist session config for {session_id}: {err}");
    }
}

/// Replace or seed config for a session (e.g. after `session/new` or `session/load`).
pub fn set_session_config_from_response(session_id: &str, response: &Value) {
    let mut store = session_config_store().lock().expect("session config store");
    let next = parse_session_config_from_response(session_id, response);
    store.insert(session_id.to_string(), next.clone());
    drop(store);
    persist_session_config_best_effort(session_id, &next);
}

/// Mark a resumed session as unknown when the RPC response omitted `configOptions`.
pub fn mark_session_config_unknown(session_id: &str) {
    let mut store = session_config_store().lock().expect("session config store");
    let next = SessionConfigState::unknown(session_id);
    store.insert(session_id.to_string(), next.clone());
    drop(store);
    persist_session_config_best_effort(session_id, &next);
}

/// Drop cached options when the session wire disconnects or is replaced.
pub fn clear_session_config(session_id: &str) {
    let mut store = session_config_store().lock().expect("session config store");
    store.remove(session_id);
}

pub fn get_session_config(session_id: &str) -> Option<SessionConfigState> {
    session_config_store()
        .lock()
        .expect("session config store")
        .get(session_id)
        .cloned()
}

/// In-memory store first, then session metadata for lazy-connect replay.
pub fn resolve_session_config(session_id: &str) -> Option<SessionConfigState> {
    if let Some(state) = get_session_config(session_id) {
        return Some(state);
    }
    crate::session_store::read_persisted_session_config(session_id)
        .ok()
        .flatten()
}

/// Apply a live `config_option_update` notification; returns the updated state.
pub fn apply_config_option_update(session_id: &str, update: &Value) -> SessionConfigState {
    let mut store = session_config_store().lock().expect("session config store");
    let entry = store
        .entry(session_id.to_string())
        .or_insert_with(|| SessionConfigState::unknown(session_id));
    merge_config_option_update(entry, update);
    let next = entry.clone();
    drop(store);
    persist_session_config_best_effort(session_id, &next);
    next
}

pub fn parse_agent_runtime_capabilities(initialize_result: &Value) -> AgentRuntimeCapabilities {
    let agent_info = initialize_result.get("agentInfo");
    let agent_capabilities = initialize_result
        .get("agentCapabilities")
        .cloned()
        .unwrap_or(Value::Null);
    let prompt = agent_capabilities
        .get("promptCapabilities")
        .cloned()
        .unwrap_or(Value::Null);
    let mcp = agent_capabilities
        .get("mcpCapabilities")
        .cloned()
        .unwrap_or(Value::Null);
    let session_caps = agent_capabilities
        .get("sessionCapabilities")
        .cloned()
        .unwrap_or(Value::Null);

    AgentRuntimeCapabilities {
        protocol_version: initialize_result
            .get("protocolVersion")
            .and_then(Value::as_u64),
        agent_name: agent_info
            .and_then(|info| info.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string),
        agent_version: agent_info
            .and_then(|info| info.get("version"))
            .and_then(Value::as_str)
            .map(str::to_string),
        load_session: truthy_capability(agent_capabilities.get("loadSession")),
        prompt_image: truthy_capability(prompt.get("image")),
        prompt_audio: truthy_capability(prompt.get("audio")),
        prompt_embedded_context: truthy_capability(prompt.get("embeddedContext")),
        mcp_http: truthy_capability(mcp.get("http")),
        mcp_sse: truthy_capability(mcp.get("sse")),
        session_list: session_caps.get("list").is_some(),
        session_resume: session_caps.get("resume").is_some(),
        session_config_options: session_caps.get("configOptions").is_some(),
        auth_methods: parse_auth_method_summaries(initialize_result),
        capabilities_stale: false,
    }
}

pub fn parse_session_config_from_response(
    session_id: &str,
    response: &Value,
) -> SessionConfigState {
    let options_value = response
        .get("configOptions")
        .or_else(|| response.get("config_options"));
    match options_value.and_then(Value::as_array) {
        Some(items) if !items.is_empty() => SessionConfigState {
            session_id: session_id.to_string(),
            status: SessionConfigStatus::Known,
            options: items.iter().map(parse_session_config_option).collect(),
        },
        _ => SessionConfigState::unknown(session_id),
    }
}

fn merge_config_option_update(state: &mut SessionConfigState, update: &Value) {
    if let Some(options) = update
        .get("configOptions")
        .or_else(|| update.get("config_options"))
        .and_then(Value::as_array)
    {
        state.status = SessionConfigStatus::Known;
        state.options = options.iter().map(parse_session_config_option).collect();
        return;
    }

    let config_id = update
        .get("configId")
        .or_else(|| update.get("config_id"))
        .and_then(Value::as_str);
    let current_value = update
        .get("currentValue")
        .or_else(|| update.get("current_value"))
        .cloned();

    if let (Some(id), Some(value)) = (config_id, current_value) {
        if state.status == SessionConfigStatus::Unknown && state.options.is_empty() {
            state.status = SessionConfigStatus::Known;
        }
        if let Some(option) = state.options.iter_mut().find(|opt| opt.id == id) {
            option.current_value = Some(value);
        } else {
            state.options.push(SessionConfigOption {
                id: id.to_string(),
                option_type: "unknown".to_string(),
                label: None,
                current_value: Some(value),
                options: None,
            });
        }
    }
}

fn parse_session_config_option(raw: &Value) -> SessionConfigOption {
    let choices = raw.get("options").and_then(Value::as_array).map(|items| {
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
    });

    SessionConfigOption {
        id: raw
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        option_type: raw
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        label: raw.get("label").and_then(Value::as_str).map(str::to_string),
        current_value: raw
            .get("currentValue")
            .or_else(|| raw.get("current_value"))
            .cloned(),
        options: choices,
    }
}

fn parse_auth_method_summaries(initialize_result: &Value) -> Vec<AuthMethodSummary> {
    let methods = initialize_result
        .get("authMethods")
        .or_else(|| initialize_result.get("authenticationMethods"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    methods
        .into_iter()
        .filter_map(|item| {
            if let Some(id) = item.as_str() {
                return Some(AuthMethodSummary {
                    id: id.to_string(),
                    name: None,
                    description: None,
                });
            }
            let id = item
                .get("id")
                .or_else(|| item.get("methodId"))
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)?;
            Some(AuthMethodSummary {
                id: id.to_string(),
                name: item.get("name").and_then(Value::as_str).map(str::to_string),
                description: item
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

fn truthy_capability(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

pub fn validate_config_option_value(
    session_id: &str,
    config_id: &str,
    value: &Value,
) -> Result<(), String> {
    let state = get_session_config(session_id)
        .ok_or_else(|| "Session config is unknown; reconnect and retry".to_string())?;
    if state.status == SessionConfigStatus::Unknown {
        return Err("Session config is unknown; reconnect and retry".to_string());
    }
    let option = state
        .option_by_id(config_id)
        .ok_or_else(|| format!("Config option `{config_id}` is not declared for this session"))?;
    if let Some(choices) = &option.options {
        if choices.is_empty() {
            return Ok(());
        }
        if !choices
            .iter()
            .any(|choice| values_equal(&choice.value, value))
        {
            return Err(format!(
                "Value is not among declared choices for `{config_id}`"
            ));
        }
    }
    Ok(())
}

fn values_equal(left: &Value, right: &Value) -> bool {
    if left == right {
        return true;
    }
    match (left, right) {
        (Value::String(left), Value::String(right)) => {
            left.trim().eq_ignore_ascii_case(right.trim())
        }
        _ => false,
    }
}

pub fn agent_runtime_capabilities_to_value(caps: &AgentRuntimeCapabilities) -> Value {
    serde_json::to_value(caps).unwrap_or(Value::Null)
}

pub fn session_config_state_to_value(state: &SessionConfigState) -> Value {
    serde_json::to_value(state).unwrap_or(Value::Null)
}

pub fn config_option_update_to_wire_payload(session_id: &str, state: &SessionConfigState) -> Value {
    json!({
        "session_id": session_id,
        "status": match state.status {
            SessionConfigStatus::Known => "known",
            SessionConfigStatus::Unknown => "unknown",
        },
        "options": state.options,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_path(version: &str, name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/test-fixtures/acp")
            .join(version)
            .join(name)
    }

    fn load_fixture(version: &str, name: &str) -> Value {
        let path = fixture_path(version, name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|err| panic!("parse {}: {err}", path.display()))
    }

    #[test]
    fn parses_v030_initialize_capabilities() {
        let init = load_fixture("v0.30", "initialize.result.json");
        let caps = parse_agent_runtime_capabilities(&init);
        assert_eq!(caps.agent_version.as_deref(), Some("0.30.0"));
        assert!(caps.load_session);
        assert!(caps.prompt_image);
        assert!(!caps.session_config_options);
        assert_eq!(caps.auth_methods.len(), 1);
        assert_eq!(caps.auth_methods[0].id, "login");
    }

    #[test]
    fn parses_v031_initialize_with_config_options_capability() {
        let init = load_fixture("v0.31", "initialize.result.json");
        let caps = parse_agent_runtime_capabilities(&init);
        assert_eq!(caps.agent_version.as_deref(), Some("0.31.0"));
        assert!(caps.session_config_options);
    }

    #[test]
    fn v030_session_new_yields_unknown_config() {
        let response = load_fixture("v0.30", "session_new.result.json");
        let state = parse_session_config_from_response("sess-desktop-fixture-030", &response);
        assert_eq!(state.status, SessionConfigStatus::Unknown);
        assert!(state.options.is_empty());
    }

    #[test]
    fn v031_session_new_parses_config_options() {
        let response = load_fixture("v0.31", "session_new.result.json");
        let state = parse_session_config_from_response("sess-desktop-fixture-031", &response);
        assert_eq!(state.status, SessionConfigStatus::Known);
        assert_eq!(state.options.len(), 3);
        assert_eq!(
            state.option_by_id("model").unwrap().current_value,
            Some(json!("kimi-k2"))
        );
    }

    #[test]
    fn v031_session_load_restores_config() {
        let response = load_fixture("v0.31", "session_load.result.json");
        let state = parse_session_config_from_response("sess-desktop-fixture-031", &response);
        assert_eq!(
            state.option_by_id("mode").unwrap().current_value,
            Some(json!("auto"))
        );
    }

    #[test]
    fn v030_resume_without_options_stays_unknown() {
        let response = load_fixture("v0.30", "session_resume.result.json");
        let state = parse_session_config_from_response("sess-desktop-fixture-030", &response);
        assert_eq!(state.status, SessionConfigStatus::Unknown);
    }

    #[test]
    fn config_option_update_merges_partial_and_full_refresh() {
        clear_session_config("merge-test");
        mark_session_config_unknown("merge-test");

        let partial = load_fixture("v0.30", "config_option_update.notification.json");
        let state = apply_config_option_update("merge-test", &partial);
        assert_eq!(state.status, SessionConfigStatus::Known);
        assert_eq!(
            state.option_by_id("mode").unwrap().current_value,
            Some(json!("auto"))
        );

        let full = load_fixture("v0.31", "config_option_update.notification.json");
        let state = apply_config_option_update("merge-test", &full);
        assert_eq!(state.options.len(), 3);
        assert_eq!(
            state.option_by_id("model").unwrap().current_value,
            Some(json!("kimi-coder"))
        );
        clear_session_config("merge-test");
    }

    #[test]
    fn session_config_invalidates_on_clear() {
        set_session_config_from_response(
            "invalidate-test",
            &load_fixture("v0.31", "session_new.result.json"),
        );
        assert!(get_session_config("invalidate-test").is_some());
        clear_session_config("invalidate-test");
        assert!(get_session_config("invalidate-test").is_none());
    }

    #[test]
    fn initialize_capabilities_do_not_include_session_options() {
        let init = load_fixture("v0.31", "initialize.result.json");
        let caps = parse_agent_runtime_capabilities(&init);
        let serialized = serde_json::to_string(&caps).expect("serialize");
        assert!(!serialized.contains("kimi-k2"));
        assert!(!serialized.contains("configOptions"));
    }

    #[test]
    fn validate_config_option_value_rejects_undeclared_id_and_value() {
        set_session_config_from_response(
            "validate-test",
            &load_fixture("v0.31", "session_new.result.json"),
        );
        assert!(validate_config_option_value("validate-test", "thinking", &json!("on")).is_ok());
        assert!(
            validate_config_option_value("validate-test", "model", &json!("not-listed")).is_err()
        );
        assert!(validate_config_option_value("validate-test", "missing", &json!("x")).is_err());
        clear_session_config("validate-test");
    }
}
