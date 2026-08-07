//! runtime-v1 protocol frame types and the handshake contract.
//!
//! Contract authority: `runtime/kimi-code/apps/desktop-runtime/src/protocol.ts`.
//! Byte-level framing (LF-delimited JSONL, size caps) lives in `codec.rs`;
//! this module owns the typed envelopes, handshake params, and the
//! `RuntimeInfo` readiness gate.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// Protocol identifier stamped on every frame.
pub const RUNTIME_PROTOCOL: &str = "runtime-v1";
/// Hard per-frame byte cap (16 MiB), LF delimiter excluded.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// Runtime-scoped event names always carry this prefix.
pub const RUNTIME_EVENT_PREFIX: &str = "runtime.";

pub const METHOD_HELLO: &str = "runtime.hello";
pub const METHOD_GET_INFO: &str = "runtime.getInfo";
pub const METHOD_SHUTDOWN: &str = "runtime.shutdown";

pub const EVENT_READY: &str = "runtime.ready";
pub const EVENT_WARNING: &str = "runtime.warning";

/// Framing/envelope violation codes, mirroring the runtime-side fault codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultCode {
    EmptyFrame,
    InvalidUtf8,
    InvalidJson,
    FrameTooLarge,
    UnterminatedFrame,
    ProtocolMismatch,
    InvalidEnvelopeType,
    InvalidEnvelope,
}

impl FaultCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EmptyFrame => "empty_frame",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::InvalidJson => "invalid_json",
            Self::FrameTooLarge => "frame_too_large",
            Self::UnterminatedFrame => "unterminated_frame",
            Self::ProtocolMismatch => "protocol_mismatch",
            Self::InvalidEnvelopeType => "invalid_envelope_type",
            Self::InvalidEnvelope => "invalid_envelope",
        }
    }
}

impl fmt::Display for FaultCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A protocol contract violation on the runtime's output stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolFault {
    pub code: FaultCode,
    pub message: String,
}

impl ProtocolFault {
    pub fn new(code: FaultCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ProtocolFault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProtocolFault {}

/// Outgoing request frame (desktop -> runtime).
#[derive(Debug, Clone, Serialize)]
pub struct RequestFrame {
    pub protocol: &'static str,
    #[serde(rename = "type")]
    pub frame_type: &'static str,
    pub id: String,
    pub method: String,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub params: Value,
}

impl RequestFrame {
    pub fn new(id: impl Into<String>, method: impl Into<String>, params: Value) -> Self {
        Self {
            protocol: RUNTIME_PROTOCOL,
            frame_type: "request",
            id: id.into(),
            method: method.into(),
            session_id: None,
            params,
        }
    }

    /// Attach the envelope-level session id (session-scoped requests).
    pub fn with_session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }
}

/// Error body of an `ok: false` response.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default)]
    pub details: Option<Value>,
}

/// Incoming response frame; `id` correlates with a live request and is never
/// reused by the runtime.
#[derive(Debug, Clone, PartialEq)]
pub enum ResponseFrame {
    Ok { id: String, result: Value },
    Err { id: String, error: ErrorBody },
}

impl ResponseFrame {
    pub fn id(&self) -> &str {
        match self {
            Self::Ok { id, .. } | Self::Err { id, .. } => id,
        }
    }
}

/// Incoming event frame. Session events carry `sessionId` + a per-session
/// monotonic `seq` (from 1); runtime-scoped events carry neither and their
/// name always uses the `runtime.` prefix.
#[derive(Debug, Clone, PartialEq)]
pub enum EventFrame {
    Session {
        session_id: String,
        seq: u64,
        event: String,
        payload: Value,
    },
    Runtime {
        event: String,
        payload: Value,
    },
}

/// Any frame the runtime may emit on stdout.
#[derive(Debug, Clone, PartialEq)]
pub enum OutputFrame {
    Response(ResponseFrame),
    Event(EventFrame),
}

/// `runtime.hello` params — must be the first request the desktop sends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    pub desktop_version: String,
    pub supported_protocols: Vec<String>,
    pub data_root: String,
    pub platform: String,
    pub arch: String,
    pub locale: String,
}

impl HelloParams {
    pub fn new(
        desktop_version: impl Into<String>,
        data_root: impl Into<String>,
        platform: impl Into<String>,
        arch: impl Into<String>,
        locale: impl Into<String>,
    ) -> Self {
        Self {
            desktop_version: desktop_version.into(),
            supported_protocols: vec![RUNTIME_PROTOCOL.to_string()],
            data_root: data_root.into(),
            platform: platform.into(),
            arch: arch.into(),
            locale: locale.into(),
        }
    }
}

/// Pinned upstream source identity reported inside `RuntimeInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct KimiSourceInfo {
    pub tag: String,
    pub commit: String,
}

/// Capability snapshot returned by hello/getInfo.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RuntimeCapabilities {
    pub methods: Vec<String>,
    pub sessions: bool,
    pub turns: bool,
    pub config: bool,
}

/// Handshake/getInfo result.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub selected_protocol: String,
    pub runtime_version: String,
    pub kimi_source: KimiSourceInfo,
    pub node_version: String,
    pub capabilities: RuntimeCapabilities,
    pub data_schema_version: u64,
}

/// Readiness gate shared by the supervisor handshake and the wave-2
/// `readiness.rs`: the runtime must select `runtime-v1` and, when an expected
/// commit is configured, report exactly the pinned Kimi source commit.
pub fn validate_runtime_info(
    info: &RuntimeInfo,
    expected_commit: Option<&str>,
) -> Result<(), String> {
    if info.selected_protocol != RUNTIME_PROTOCOL {
        return Err(format!(
            "runtime selected protocol `{}`, expected `{RUNTIME_PROTOCOL}`",
            info.selected_protocol
        ));
    }
    if let Some(expected) = expected_commit {
        if info.kimi_source.commit != expected {
            return Err(format!(
                "runtime kimi source commit `{}` does not match pinned `{}`",
                info.kimi_source.commit, expected
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_runtime_info_checks_protocol_and_commit() {
        let info = RuntimeInfo {
            selected_protocol: RUNTIME_PROTOCOL.to_string(),
            runtime_version: "0.0.0".to_string(),
            kimi_source: KimiSourceInfo {
                tag: "@moonshot-ai/kimi-code@0.33.0".to_string(),
                commit: "abc".to_string(),
            },
            node_version: "24.0.0".to_string(),
            capabilities: RuntimeCapabilities {
                methods: vec![METHOD_GET_INFO.to_string()],
                sessions: true,
                turns: true,
                config: true,
            },
            data_schema_version: 1,
        };
        assert!(validate_runtime_info(&info, Some("abc")).is_ok());
        assert!(validate_runtime_info(&info, Some("other")).is_err());
        let mut wrong = info.clone();
        wrong.selected_protocol = "runtime-v2".to_string();
        assert!(validate_runtime_info(&wrong, Some("abc")).is_err());
    }

    #[test]
    fn deserialize_runtime_info_from_hello_result() {
        let value = json!({
            "selectedProtocol": "runtime-v1",
            "runtimeVersion": "0.0.0-fixture",
            "kimiSource": {"tag": "@moonshot-ai/kimi-code@0.33.0", "commit": "deadbeef"},
            "nodeVersion": "24.15.0",
            "capabilities": {"methods": ["runtime.hello"], "sessions": false, "turns": false, "config": false},
            "dataSchemaVersion": 1
        });
        let info: RuntimeInfo = serde_json::from_value(value).unwrap();
        assert_eq!(info.selected_protocol, "runtime-v1");
        assert_eq!(info.kimi_source.commit, "deadbeef");
        assert_eq!(info.data_schema_version, 1);
        assert!(!info.capabilities.sessions);
    }
}
