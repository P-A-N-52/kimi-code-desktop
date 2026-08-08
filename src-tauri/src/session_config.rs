//! Session configuration model shared by the desktop and the source runtime (M4).
//!
//! Two deliberately separate models:
//! - [`AgentRuntimeCapabilities`] — the runtime's capability set (protocol /
//!   agent version, capability flags, auth summary), projected from the
//!   runtime handshake info by the command layer (`commands/config.rs`).
//! - [`SessionConfigState`] — the per-session configuration snapshot (model /
//!   thinking / mode / future option ids) normalized from runtime
//!   `session.config` events and persisted for replay.
//!
//! The in-memory store is the live source while a session is open;
//! [`resolve_session_config`] falls back to the persisted session metadata so
//! lazy-connect replay can emit a `ConfigOptionUpdate` snapshot without a
//! running session.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Summary of an authentication method from the runtime; never stores secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodSummary {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
}

/// Runtime agent capabilities from the latest handshake.
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
    /// Set when the latest live runtime probe failed but cached capabilities remain.
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

pub(crate) fn session_config_store() -> &'static Mutex<HashMap<String, SessionConfigState>> {
    SESSION_CONFIG_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn persist_session_config_best_effort(session_id: &str, state: &SessionConfigState) {
    if let Err(err) = crate::session_store::persist_session_config(session_id, state) {
        eprintln!("[session_config] failed to persist session config for {session_id}: {err}");
    }
}

/// Replace or seed config for a session (e.g. after a session snapshot refresh).
pub fn set_session_config_from_response(session_id: &str, response: &Value) {
    let mut store = session_config_store().lock().expect("session config store");
    let next = parse_session_config_from_response(session_id, response);
    store.insert(session_id.to_string(), next.clone());
    drop(store);
    persist_session_config_best_effort(session_id, &next);
}

/// Mark a resumed session as unknown when the snapshot response omitted `configOptions`.
pub fn mark_session_config_unknown(session_id: &str) {
    let mut store = session_config_store().lock().expect("session config store");
    let next = SessionConfigState::unknown(session_id);
    store.insert(session_id.to_string(), next.clone());
    drop(store);
    persist_session_config_best_effort(session_id, &next);
}

/// Drop cached options when the session disconnects or is replaced.
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

pub(crate) fn parse_session_config_option(raw: &Value) -> SessionConfigOption {
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
    fn session_config_invalidates_on_clear() {
        set_session_config_from_response(
            "invalidate-test",
            &load_fixture("v0.31", "session_new.result.json"),
        );
        assert!(get_session_config("invalidate-test").is_some());
        clear_session_config("invalidate-test");
        assert!(get_session_config("invalidate-test").is_none());
    }
}
