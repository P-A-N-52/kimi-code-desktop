//! Reverse-request translations (runtime-v1 -> wire): `approval.requested`
//! and `question.requested` become JSON-RPC `request` lines the frontend
//! answers by echoing `id`.
//!
//! Split out of `translate.rs` to keep each file under the 600-line module
//! budget. Moved verbatim in M3 wave 2.

use super::{cloned_for_keys, malformed_event_notice, string_for_keys, wire_request_message};
use serde_json::{json, Value};

pub(super) fn translate_approval_requested(payload: &Value) -> Vec<String> {
    let Some(approval_id) = string_for_keys(payload, &["approvalId", "approval_id"]) else {
        return vec![malformed_event_notice("approval.requested", "approvalId")];
    };
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("approval");
    let description = payload
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or(action);
    let mut wire_payload = json!({
        "id": approval_id,
        "action": action,
        "description": description,
        // Wire field kept from the ACP shape; identifies the emitting backend.
        "sender": "runtime",
        "tool_call_id": string_for_keys(payload, &["toolCallId", "tool_call_id"]).unwrap_or_default(),
        // The engine has no ACP tool kind; the bridge always sends null.
        "kind": cloned_for_keys(payload, &["kind"]),
        "display": payload.get("display").and_then(Value::as_array).cloned().unwrap_or_default(),
    });
    if let Some(agent_id) = string_for_keys(payload, &["agentId", "agent_id"]) {
        wire_payload["agent_id"] = json!(agent_id);
    }
    vec![wire_request_message(
        "ApprovalRequest",
        wire_payload,
        json!(approval_id),
    )]
}

pub(super) fn translate_question_requested(payload: &Value) -> Vec<String> {
    let Some(question_id) = string_for_keys(payload, &["questionId", "question_id"]) else {
        return vec![malformed_event_notice("question.requested", "questionId")];
    };
    let questions = payload
        .get("questions")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(question_item_wire).collect::<Vec<_>>())
        .unwrap_or_default();
    vec![wire_request_message(
        "QuestionRequest",
        json!({
            "id": question_id,
            "tool_call_id": string_for_keys(payload, &["toolCallId", "tool_call_id"]).unwrap_or_default(),
            "questions": questions,
        }),
        json!(question_id),
    )]
}

fn question_item_wire(item: &Value) -> Value {
    let question = item.get("question").and_then(Value::as_str).unwrap_or("");
    let mut wire = json!({
        "question": question,
        "header": string_for_keys(item, &["header"]).unwrap_or_else(|| question.to_string()),
        "options": item.get("options").and_then(Value::as_array).cloned().unwrap_or_default(),
        "multi_select": item
            .get("multi_select")
            .or_else(|| item.get("multiSelect"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    });
    if let Some(body) = string_for_keys(item, &["body"]) {
        wire["body"] = json!(body);
    }
    // The CLI always offers free-text "Other"; keep the ACP-desktop defaults
    // when the engine omits them.
    wire["other_label"] =
        json!(string_for_keys(item, &["other_label", "otherLabel"])
            .unwrap_or_else(|| "其他".to_string()));
    wire["other_description"] = json!(string_for_keys(
        item,
        &["other_description", "otherDescription"]
    )
    .unwrap_or_else(|| "输入自定义回答".to_string()));
    wire
}
