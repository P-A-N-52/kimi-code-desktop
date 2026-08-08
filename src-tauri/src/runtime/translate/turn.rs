//! Session status and turn-terminal translations (runtime-v1 -> wire).
//!
//! Split out of `translate.rs` to keep each file under the 600-line module
//! budget. Owns the per-session `session_status` wire seq — the frontend
//! drops any status whose `seq` is not strictly greater than the last one it
//! saw, so every line below increments the translator-held counter.

use super::{
    malformed_event_notice, session_notice_wire, string_for_keys, wire_event_message,
    wire_prompt_error_message, wire_prompt_result_message, SessionTranslateState,
};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_unix_ms_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
        .to_string()
}

/// `session_status` wire line with the translator-owned per-session seq. The
/// `worker_id` is the literal `runtime`: unlike ACP (one worker per session)
/// there is exactly one runtime process behind every session.
fn session_status_wire(
    state: &mut SessionTranslateState,
    session_id: &str,
    session_state: &str,
    reason: Option<&str>,
    detail: Option<&str>,
    prompt_request_id: Option<&str>,
) -> String {
    state.status_seq += 1;
    let mut params = json!({
        "session_id": session_id,
        "state": session_state,
        "seq": state.status_seq,
        "worker_id": "runtime",
        "reason": reason,
        "detail": detail,
        "updated_at": now_unix_ms_string(),
    });
    if let Some(prompt_request_id) = prompt_request_id {
        params["prompt_request_id"] = json!(prompt_request_id);
    }
    json!({ "jsonrpc": "2.0", "method": "session_status", "params": params }).to_string()
}

pub(super) fn translate_session_status(
    state: &mut SessionTranslateState,
    session_id: &str,
    payload: &Value,
) -> Vec<String> {
    let session_state = payload
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let reason = payload.get("reason").and_then(Value::as_str);
    let detail = payload.get("detail").and_then(Value::as_str);
    let request_id = string_for_keys(payload, &["requestId", "request_id"]);
    let status_wire = session_status_wire(
        state,
        session_id,
        session_state,
        reason,
        detail,
        request_id.as_deref(),
    );
    if session_state == "error" {
        // Persistent engine-side error: flip the status strip and keep a
        // visible notice (checklist §1 SessionNotice / §6).
        let text = detail.or(reason).unwrap_or("Session error");
        return vec![status_wire, session_notice_wire(text, reason)];
    }
    vec![status_wire]
}

pub(super) fn translate_turn_completed(
    state: &mut SessionTranslateState,
    session_id: &str,
    payload: &Value,
) -> Vec<String> {
    let Some(request_id) = string_for_keys(payload, &["requestId", "request_id"]) else {
        return vec![malformed_event_notice("turn.completed", "requestId")];
    };
    // ACP emission order: prompt result first, then the terminal status, then
    // the usage snapshot. The frontend terminates only the matching request.
    let mut messages = vec![
        wire_prompt_result_message(&request_id, "finished"),
        session_status_wire(
            state,
            session_id,
            "idle",
            Some("finished"),
            None,
            Some(&request_id),
        ),
    ];
    if let Some(usage) = payload.get("usage").filter(|usage| usage.is_object()) {
        messages.push(wire_event_message(
            "StatusUpdate",
            json!({
                "context_usage": Value::Null,
                "token_usage": usage,
                "context_tokens": Value::Null,
                "max_context_tokens": Value::Null,
            }),
        ));
    }
    messages
}

pub(super) fn translate_turn_failed(
    state: &mut SessionTranslateState,
    session_id: &str,
    payload: &Value,
) -> Vec<String> {
    let Some(request_id) = string_for_keys(payload, &["requestId", "request_id"]) else {
        return vec![malformed_event_notice("turn.failed", "requestId")];
    };
    let error = payload.get("error").filter(|error| error.is_object());
    let code = error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("turn_failed");
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("Turn failed.");
    // runtime-v1 has no turn.cancelled; the bridge reports cancelled turns as
    // turn.failed with code `cancelled`. Cancel is not an error on the wire
    // (ACP parity: result status cancelled + idle/cancelled status).
    if code == "cancelled" {
        return vec![
            wire_prompt_result_message(&request_id, "cancelled"),
            session_status_wire(
                state,
                session_id,
                "idle",
                Some("cancelled"),
                None,
                Some(&request_id),
            ),
        ];
    }
    let retryable = error
        .and_then(|error| error.get("retryable"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    vec![
        wire_prompt_error_message(&request_id, code, message, retryable),
        session_status_wire(state, session_id, "error", Some(code), Some(message), None),
    ]
}
