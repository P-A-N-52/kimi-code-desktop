//! Typed runtime-v1 client over `RuntimeSupervisor` (M2 wave 2).
//!
//! Contract authority: `runtime/kimi-code/apps/desktop-runtime/src/protocol.ts`.
//! Every M1 method except `runtime.hello` (supervisor handshake) gets a typed
//! call: serialize params, block with an explicit timeout, deserialize.
//! The typed params/results live in the `client_types` submodule.
//!
//! Error classes mirror the supervisor:
//! - Fatal: `RuntimeError` variants meaning the process or the protocol is
//!   gone (`Protocol`, `Io`, `InvalidState`, `Timeout`, `UnexpectedExit`,
//!   `DuplicateResponseId`, `UnknownResponseId`, `Readiness`).
//! - Non-fatal: `RuntimeError::Rejected(ErrorBody)` — a well-formed `ok:
//!   false` answer from the runtime carrying `code`/`message`/`retryable`/
//!   `details`.
//! - A well-formed `ok: true` whose result does not match the method schema
//!   maps to `RuntimeError::Protocol(ProtocolFault{InvalidEnvelope, ..})`:
//!   an envelope contract violation, surfaced without failing the runtime
//!   closed (fail-closed fault handling is the supervisor's job).
//!
//! Session-scoped calls (`session.open`/`session.close`, `turn.*`,
//! `approval.respond`, `question.respond`) attach the envelope-level
//! `sessionId` via `RuntimeSupervisor::call_with_session`; the `sessions.*`
//! management family does not (it operates on metadata, not in a live session).

#[path = "client_types.rs"]
mod client_types;

pub use client_types::{
    ApprovalDecision, ApprovalRespondParams, ApprovalScope, ConfigTarget, ConfigUpdateParams,
    ContentPart, EmptyResult, MediaRef, ModelDescriptor, ModelsListResult, PromptInput,
    ProviderDescriptor, ProviderImport, ProvidersImportParams, ProvidersListResult, QuestionMethod,
    QuestionRespondParams, QuestionResult, SessionClosed, SessionDeleted, SessionDescriptor,
    SessionsCreateParams, SessionsListParams, SessionsListResult, SessionsUpdateParams,
    ShutdownResult, TurnCancelParams, TurnCancelResult, TurnStartParams, TurnStartResult,
    TurnSteerParams, TurnSteerResult,
};

use super::protocol::{FaultCode, ProtocolFault, RuntimeInfo, METHOD_GET_INFO, METHOD_SHUTDOWN};
use super::supervisor::{RuntimeError, RuntimeSupervisor};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const METHOD_SESSIONS_LIST: &str = "sessions.list";
const METHOD_SESSIONS_CREATE: &str = "sessions.create";
const METHOD_SESSIONS_GET: &str = "sessions.get";
const METHOD_SESSIONS_UPDATE: &str = "sessions.update";
const METHOD_SESSIONS_DELETE: &str = "sessions.delete";
const METHOD_SESSION_OPEN: &str = "session.open";
const METHOD_SESSION_CLOSE: &str = "session.close";
const METHOD_TURN_START: &str = "turn.start";
const METHOD_TURN_CANCEL: &str = "turn.cancel";
const METHOD_TURN_STEER: &str = "turn.steer";
const METHOD_APPROVAL_RESPOND: &str = "approval.respond";
const METHOD_QUESTION_RESPOND: &str = "question.respond";
const METHOD_CONFIG_GET: &str = "config.get";
const METHOD_CONFIG_UPDATE: &str = "config.update";
const METHOD_MODELS_LIST: &str = "models.list";
const METHOD_PROVIDERS_LIST: &str = "providers.list";
const METHOD_PROVIDERS_IMPORT: &str = "providers.import";

/// Typed facade over one `RuntimeSupervisor`; every call is synchronous with
/// an explicit timeout (see the module docs for the error classes).
pub struct RuntimeClient<'a> {
    supervisor: &'a RuntimeSupervisor,
}

impl<'a> RuntimeClient<'a> {
    pub fn new(supervisor: &'a RuntimeSupervisor) -> Self {
        Self { supervisor }
    }

    /// Generic passthrough for methods without a dedicated typed wrapper.
    pub fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RuntimeError> {
        self.supervisor.call(method, params, timeout)
    }

    pub fn get_info(&self, timeout: Duration) -> Result<RuntimeInfo, RuntimeError> {
        self.call_typed(METHOD_GET_INFO, json!({}), timeout)
    }

    pub fn shutdown(&self, timeout: Duration) -> Result<ShutdownResult, RuntimeError> {
        self.call_typed(METHOD_SHUTDOWN, json!({}), timeout)
    }

    pub fn sessions_list(
        &self,
        params: &SessionsListParams,
        timeout: Duration,
    ) -> Result<SessionsListResult, RuntimeError> {
        self.call_typed(
            METHOD_SESSIONS_LIST,
            to_params(METHOD_SESSIONS_LIST, params)?,
            timeout,
        )
    }

    pub fn sessions_create(
        &self,
        params: &SessionsCreateParams,
        timeout: Duration,
    ) -> Result<SessionDescriptor, RuntimeError> {
        self.call_typed(
            METHOD_SESSIONS_CREATE,
            to_params(METHOD_SESSIONS_CREATE, params)?,
            timeout,
        )
    }

    pub fn sessions_get(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> Result<SessionDescriptor, RuntimeError> {
        self.call_typed(
            METHOD_SESSIONS_GET,
            json!({ "sessionId": session_id }),
            timeout,
        )
    }

    pub fn sessions_update(
        &self,
        params: &SessionsUpdateParams,
        timeout: Duration,
    ) -> Result<SessionDescriptor, RuntimeError> {
        self.call_typed(
            METHOD_SESSIONS_UPDATE,
            to_params(METHOD_SESSIONS_UPDATE, params)?,
            timeout,
        )
    }

    pub fn sessions_delete(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> Result<SessionDeleted, RuntimeError> {
        self.call_typed(
            METHOD_SESSIONS_DELETE,
            json!({ "sessionId": session_id }),
            timeout,
        )
    }

    /// Materialize a live engine session; envelope-level `sessionId` is set.
    pub fn session_open(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> Result<SessionDescriptor, RuntimeError> {
        self.call_typed_session(
            METHOD_SESSION_OPEN,
            session_id,
            json!({ "sessionId": session_id }),
            timeout,
        )
    }

    /// Detach the event bridge and close the live engine session.
    pub fn session_close(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> Result<SessionClosed, RuntimeError> {
        self.call_typed_session(
            METHOD_SESSION_CLOSE,
            session_id,
            json!({ "sessionId": session_id }),
            timeout,
        )
    }

    pub fn turn_start(
        &self,
        params: &TurnStartParams,
        timeout: Duration,
    ) -> Result<TurnStartResult, RuntimeError> {
        self.call_typed_session(
            METHOD_TURN_START,
            &params.session_id,
            to_params(METHOD_TURN_START, params)?,
            timeout,
        )
    }

    pub fn turn_cancel(
        &self,
        params: &TurnCancelParams,
        timeout: Duration,
    ) -> Result<TurnCancelResult, RuntimeError> {
        self.call_typed_session(
            METHOD_TURN_CANCEL,
            &params.session_id,
            to_params(METHOD_TURN_CANCEL, params)?,
            timeout,
        )
    }

    pub fn turn_steer(
        &self,
        params: &TurnSteerParams,
        timeout: Duration,
    ) -> Result<TurnSteerResult, RuntimeError> {
        self.call_typed_session(
            METHOD_TURN_STEER,
            &params.session_id,
            to_params(METHOD_TURN_STEER, params)?,
            timeout,
        )
    }

    pub fn approval_respond(
        &self,
        params: &ApprovalRespondParams,
        timeout: Duration,
    ) -> Result<EmptyResult, RuntimeError> {
        self.call_typed_session(
            METHOD_APPROVAL_RESPOND,
            &params.session_id,
            to_params(METHOD_APPROVAL_RESPOND, params)?,
            timeout,
        )
    }

    pub fn question_respond(
        &self,
        params: &QuestionRespondParams,
        timeout: Duration,
    ) -> Result<EmptyResult, RuntimeError> {
        self.call_typed_session(
            METHOD_QUESTION_RESPOND,
            &params.session_id,
            to_params(METHOD_QUESTION_RESPOND, params)?,
            timeout,
        )
    }

    /// `domain` absent means the whole config (`configGetParamsSchema`).
    pub fn config_get(
        &self,
        domain: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, RuntimeError> {
        let params = match domain {
            Some(domain) => json!({ "domain": domain }),
            None => json!({}),
        };
        self.call_typed(METHOD_CONFIG_GET, params, timeout)
    }

    pub fn config_update(
        &self,
        params: &ConfigUpdateParams,
        timeout: Duration,
    ) -> Result<EmptyResult, RuntimeError> {
        self.call_typed(
            METHOD_CONFIG_UPDATE,
            to_params(METHOD_CONFIG_UPDATE, params)?,
            timeout,
        )
    }

    pub fn models_list(&self, timeout: Duration) -> Result<ModelsListResult, RuntimeError> {
        self.call_typed(METHOD_MODELS_LIST, json!({}), timeout)
    }

    pub fn providers_list(&self, timeout: Duration) -> Result<ProvidersListResult, RuntimeError> {
        self.call_typed(METHOD_PROVIDERS_LIST, json!({}), timeout)
    }

    pub fn providers_import(
        &self,
        params: &ProvidersImportParams,
        timeout: Duration,
    ) -> Result<EmptyResult, RuntimeError> {
        self.call_typed(
            METHOD_PROVIDERS_IMPORT,
            to_params(METHOD_PROVIDERS_IMPORT, params)?,
            timeout,
        )
    }

    fn call_typed<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<T, RuntimeError> {
        let value = self.supervisor.call(method, params, timeout)?;
        from_result(method, value)
    }

    fn call_typed_session<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        session_id: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<T, RuntimeError> {
        let value = self
            .supervisor
            .call_with_session(method, session_id, params, timeout)?;
        from_result(method, value)
    }
}

/// Serialize typed params; only `Io` can fail here (programmer error in the
/// params types), mirroring the supervisor's hello-params handling.
fn to_params<T: Serialize>(method: &str, params: &T) -> Result<Value, RuntimeError> {
    serde_json::to_value(params)
        .map_err(|err| RuntimeError::Io(format!("{method} params not serializable: {err}")))
}

/// Deserialize a typed result; a schema mismatch is an envelope violation.
fn from_result<T: serde::de::DeserializeOwned>(
    method: &str,
    value: Value,
) -> Result<T, RuntimeError> {
    serde_json::from_value(value).map_err(|err| {
        RuntimeError::Protocol(ProtocolFault::new(
            FaultCode::InvalidEnvelope,
            format!("{method} result does not match the runtime-v1 schema: {err}"),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_result_maps_to_protocol_fault() {
        match from_result::<ShutdownResult>("runtime.shutdown", json!({"wrong": true})) {
            Err(RuntimeError::Protocol(fault)) => {
                assert_eq!(fault.code, FaultCode::InvalidEnvelope);
            }
            other => panic!("expected protocol fault, got {other:?}"),
        }
    }
}
