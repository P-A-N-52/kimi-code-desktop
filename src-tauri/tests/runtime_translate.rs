//! Golden tests for the runtime-v1 -> wire translator (`runtime/translate.rs`)
//! plus an end-to-end pass over the deterministic fixture worker
//! (`tests/fixtures/runtime-fixture-worker.mjs`).
//!
//! The pure tests synthesize `EventFrame`s directly and assert the wire JSON
//! shape for every M1 mapping, the state machines, and the generic fallbacks
//! — no node required. The fixture test spawns the real worker and skips with
//! a note when `node` is not on PATH.

use app_lib::runtime::protocol::{EventFrame, HelloParams, RUNTIME_PROTOCOL};
use app_lib::runtime::supervisor::{
    HandshakeConfig, RuntimeSupervisor, ShutdownConfig, SpawnConfig,
};
use app_lib::runtime::translate::{
    synthesize_approval_resolved, synthesize_turn_begin, translate_event, WireTranslator,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

const EXPECTED_COMMIT: &str = "53c832dfdf9566afd59a8b3d54ebd36d3cb03d72";
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
const EVENT_TIMEOUT: Duration = Duration::from_secs(5);

fn session_frame(event: &str, payload: Value) -> EventFrame {
    EventFrame::Session {
        session_id: "sess-1".to_string(),
        seq: 1,
        event: event.to_string(),
        payload,
    }
}

fn runtime_frame(event: &str, payload: Value) -> EventFrame {
    EventFrame::Runtime {
        event: event.to_string(),
        payload,
    }
}

fn parse(line: &str) -> Value {
    serde_json::from_str(line).unwrap_or_else(|err| panic!("wire line is not valid JSON: {err}"))
}

/// One wire line, parsed, asserting the common event envelope.
fn parse_event(line: &str) -> Value {
    let message = parse(line);
    assert_eq!(message["jsonrpc"], json!("2.0"));
    assert_eq!(message["method"], json!("event"));
    message
}

fn event_type(line: &str) -> String {
    parse_event(line)["params"]["type"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn event_payload(line: &str) -> Value {
    parse_event(line)["params"]["payload"].clone()
}

// ---------------------------------------------------------------------------
// content.delta / thinking.delta -> ContentPart
// ---------------------------------------------------------------------------

#[test]
fn content_delta_maps_to_text_part() {
    let messages = translate_event(&session_frame(
        "content.delta",
        json!({ "text": "hello", "requestId": "req-1" }),
    ));
    assert_eq!(messages.len(), 1);
    let payload = event_payload(&messages[0]);
    assert_eq!(payload, json!({ "type": "text", "text": "hello" }));
}

#[test]
fn thinking_delta_maps_to_think_part() {
    let messages = translate_event(&session_frame("thinking.delta", json!({ "text": "hmm" })));
    assert_eq!(
        event_payload(&messages[0]),
        json!({ "type": "think", "think": "hmm" })
    );
}

#[test]
fn content_delta_explicit_type_wins_and_think_field_is_read() {
    let messages = translate_event(&session_frame(
        "content.delta",
        json!({ "type": "think", "think": "reasoning" }),
    ));
    assert_eq!(
        event_payload(&messages[0]),
        json!({ "type": "think", "think": "reasoning" })
    );
}

#[test]
fn content_delta_supports_all_media_types() {
    for (part_type, key) in [
        ("image_url", "image_url"),
        ("audio_url", "audio_url"),
        ("video_url", "video_url"),
    ] {
        let messages = translate_event(&session_frame(
            "content.delta",
            json!({ "type": part_type, key: { "url": "https://example.com/x", "id": "m1" } }),
        ));
        assert_eq!(
            event_payload(&messages[0]),
            json!({ "type": part_type, key: { "url": "https://example.com/x", "id": "m1" } }),
            "media part for {part_type}"
        );
    }
    // A bare text URL degrades to {url}.
    let messages = translate_event(&session_frame(
        "content.delta",
        json!({ "type": "image_url", "text": "https://example.com/p.png" }),
    ));
    assert_eq!(
        event_payload(&messages[0]),
        json!({ "type": "image_url", "image_url": { "url": "https://example.com/p.png" } })
    );
}

#[test]
fn content_delta_unknown_type_degrades_to_text() {
    let messages = translate_event(&session_frame(
        "content.delta",
        json!({ "type": "spreadsheet", "text": "csv body" }),
    ));
    assert_eq!(
        event_payload(&messages[0]),
        json!({ "type": "text", "text": "csv body" })
    );
}

// ---------------------------------------------------------------------------
// tool.started / tool.updated / tool.completed
// ---------------------------------------------------------------------------

#[test]
fn tool_started_maps_to_tool_call() {
    let messages = translate_event(&session_frame(
        "tool.started",
        json!({ "toolCallId": "call-1", "name": "Read", "arguments": "{\"path\":\"a\"}" }),
    ));
    assert_eq!(messages.len(), 1);
    assert_eq!(
        event_payload(&messages[0]),
        json!({
            "type": "function",
            "id": "call-1",
            "function": { "name": "Read", "arguments": "{\"path\":\"a\"}" },
        })
    );
}

#[test]
fn tool_started_defaults_arguments_and_keeps_unknown_tool_names() {
    let messages = translate_event(&session_frame(
        "tool.started",
        json!({ "toolCallId": "call-2", "name": "BrandNewTool" }),
    ));
    // Unknown tool names pass through: the frontend registry renders them
    // with its generic card.
    let payload = event_payload(&messages[0]);
    assert_eq!(payload["function"]["name"], json!("BrandNewTool"));
    assert_eq!(payload["function"]["arguments"], json!("{}"));
}

#[test]
fn tool_updated_maps_to_tool_call_part() {
    let messages = translate_event(&session_frame(
        "tool.updated",
        json!({ "toolCallId": "call-1", "argumentsPart": "{\"a\":" }),
    ));
    assert_eq!(
        event_payload(&messages[0]),
        json!({ "arguments_part": "{\"a\":" })
    );
    // No argumentsPart -> no wire line.
    let empty = translate_event(&session_frame(
        "tool.updated",
        json!({ "toolCallId": "call-1" }),
    ));
    assert!(empty.is_empty());
}

#[test]
fn tool_completed_maps_to_tool_result_with_display_passthrough() {
    let messages = translate_event(&session_frame(
        "tool.completed",
        json!({
            "toolCallId": "call-1",
            "isError": true,
            "message": "boom",
            "display": [
                { "type": "text", "data": { "type": "text", "text": "shown" } },
                // Unknown display block types pass through verbatim to the
                // frontend generic fallback.
                { "type": "hologram", "data": { "z": 1 } },
            ],
        }),
    ));
    assert_eq!(messages.len(), 1);
    let payload = event_payload(&messages[0]);
    assert_eq!(payload["tool_call_id"], json!("call-1"));
    let return_value = &payload["return_value"];
    assert_eq!(return_value["is_error"], json!(true));
    // No `output` in the payload -> the message becomes the output.
    assert_eq!(return_value["output"], json!("boom"));
    assert_eq!(return_value["message"], json!("boom"));
    assert_eq!(
        return_value["display"],
        json!([
            { "type": "text", "data": { "type": "text", "text": "shown" } },
            { "type": "hologram", "data": { "z": 1 } },
        ])
    );
}

#[test]
fn tool_completed_output_passthrough_rules() {
    // Array output passes through; non-string/non-array leaks are stringified.
    let with_array = translate_event(&session_frame(
        "tool.completed",
        json!({ "toolCallId": "c", "isError": false, "output": [{ "type": "text", "text": "o" }] }),
    ));
    assert_eq!(
        event_payload(&with_array[0])["return_value"]["output"],
        json!([{ "type": "text", "text": "o" }])
    );
    let with_object = translate_event(&session_frame(
        "tool.completed",
        json!({ "toolCallId": "c", "isError": false, "output": { "odd": true } }),
    ));
    assert_eq!(
        event_payload(&with_object[0])["return_value"]["output"],
        json!("{\"odd\":true}")
    );
}

#[test]
fn subagent_tool_calls_wrap_as_subagent_event_with_stable_provenance() {
    let mut translator = WireTranslator::new();
    let spawned = translator.translate(&session_frame(
        "subagent.updated",
        json!({
            "phase": "spawned",
            "agentId": "agent-1",
            "parentToolCallId": "agent-call-1",
            "subagentType": "reviewer",
            "description": "Review it",
        }),
    ));
    assert_eq!(event_type(&spawned[0]), "TaskCreated");
    assert_eq!(event_type(&spawned[1]), "SubagentLifecycle");

    // tool.started for the subagent wraps into SubagentEvent with the learned
    // subagent_type backfilled.
    let started = translator.translate(&session_frame(
        "tool.started",
        json!({
            "toolCallId": "sub-tool-1",
            "name": "Grep",
            "arguments": "{}",
            "parentToolCallId": "agent-call-1",
            "agentId": "agent-1",
        }),
    ));
    assert_eq!(started.len(), 1);
    let envelope = event_payload(&started[0]);
    assert_eq!(event_type(&started[0]), "SubagentEvent");
    assert_eq!(envelope["parent_tool_call_id"], json!("agent-call-1"));
    assert_eq!(envelope["agent_id"], json!("agent-1"));
    assert_eq!(envelope["subagent_type"], json!("reviewer"));
    assert_eq!(envelope["event"]["type"], json!("ToolCall"));
    assert_eq!(envelope["event"]["payload"]["id"], json!("sub-tool-1"));

    // tool.updated / tool.completed carry no provenance in runtime-v1; the
    // translator recovers it from tool.started so the argument stream stays
    // scoped to the subagent card.
    let updated = translator.translate(&session_frame(
        "tool.updated",
        json!({ "toolCallId": "sub-tool-1", "argumentsPart": "{\"q\":" }),
    ));
    let updated_envelope = event_payload(&updated[0]);
    assert_eq!(event_type(&updated[0]), "SubagentEvent");
    assert_eq!(updated_envelope["event"]["type"], json!("ToolCallPart"));
    assert_eq!(
        updated_envelope["event"]["payload"],
        json!({ "arguments_part": "{\"q\":" })
    );

    let completed = translator.translate(&session_frame(
        "tool.completed",
        json!({ "toolCallId": "sub-tool-1", "isError": false, "message": "done" }),
    ));
    let completed_envelope = event_payload(&completed[0]);
    assert_eq!(completed_envelope["event"]["type"], json!("ToolResult"));
    assert_eq!(
        completed_envelope["event"]["payload"]["return_value"]["extras"],
        json!({ "tool_title": "Grep" })
    );
}

// ---------------------------------------------------------------------------
// approval.requested / question.requested (reverse requests)
// ---------------------------------------------------------------------------

#[test]
fn approval_requested_maps_to_wire_request() {
    let messages = translate_event(&session_frame(
        "approval.requested",
        json!({
            "approvalId": "ap-1",
            "action": "run_command",
            "description": "Run ls",
            "toolCallId": "call-9",
            "kind": null,
            "display": [{ "type": "execute", "data": { "command": "ls" } }],
        }),
    ));
    assert_eq!(messages.len(), 1);
    let message = parse(&messages[0]);
    assert_eq!(message["method"], json!("request"));
    assert_eq!(message["id"], json!("ap-1"));
    assert_eq!(message["params"]["type"], json!("ApprovalRequest"));
    let payload = &message["params"]["payload"];
    assert_eq!(payload["id"], json!("ap-1"));
    assert_eq!(payload["action"], json!("run_command"));
    assert_eq!(payload["description"], json!("Run ls"));
    assert_eq!(payload["sender"], json!("runtime"));
    assert_eq!(payload["tool_call_id"], json!("call-9"));
    assert_eq!(payload["kind"], Value::Null);
    assert_eq!(
        payload["display"],
        json!([{ "type": "execute", "data": { "command": "ls" } }])
    );
    assert!(payload.get("agent_id").is_none());
}

#[test]
fn approval_requested_without_id_is_a_notice_not_a_panic() {
    let messages = translate_event(&session_frame(
        "approval.requested",
        json!({ "action": "x" }),
    ));
    assert_eq!(messages.len(), 1);
    assert_eq!(event_type(&messages[0]), "SessionNotice");
    assert!(event_payload(&messages[0])["text"]
        .as_str()
        .unwrap_or_default()
        .contains("approvalId"));
}

#[test]
fn question_requested_maps_to_wire_request_with_defaults() {
    let messages = translate_event(&session_frame(
        "question.requested",
        json!({
            "questionId": "q-1",
            "questions": [
                {
                    "question": "Pick one?",
                    "options": [{ "label": "yes", "description": "Sure" }, { "label": "no" }],
                    "multi_select": true,
                },
                { "question": "Free text?" },
            ],
        }),
    ));
    let message = parse(&messages[0]);
    assert_eq!(message["method"], json!("request"));
    assert_eq!(message["id"], json!("q-1"));
    assert_eq!(message["params"]["type"], json!("QuestionRequest"));
    let payload = &message["params"]["payload"];
    assert_eq!(payload["id"], json!("q-1"));
    assert_eq!(payload["tool_call_id"], json!(""));
    let questions = payload["questions"].as_array().expect("questions array");
    assert_eq!(questions.len(), 2);
    assert_eq!(
        questions[0],
        json!({
            "question": "Pick one?",
            "header": "Pick one?",
            "options": [{ "label": "yes", "description": "Sure" }, { "label": "no" }],
            "multi_select": true,
            "other_label": "其他",
            "other_description": "输入自定义回答",
        })
    );
    // header defaults to the question text; Other defaults are injected.
    assert_eq!(questions[1]["header"], json!("Free text?"));
    assert_eq!(questions[1]["multi_select"], json!(false));
    assert_eq!(questions[1]["other_label"], json!("其他"));
}

// ---------------------------------------------------------------------------
// task.updated state machine
// ---------------------------------------------------------------------------

#[test]
fn task_updated_state_machine_created_progress_completed() {
    let mut translator = WireTranslator::new();
    let created = translator.translate(&session_frame(
        "task.updated",
        json!({ "taskId": "task-1", "status": "running", "description": "Build", "kind": "shell" }),
    ));
    assert_eq!(created.len(), 1);
    assert_eq!(event_type(&created[0]), "TaskCreated");
    let task = event_payload(&created[0]);
    assert_eq!(task["session_id"], json!("sess-1"));
    assert_eq!(task["task"]["id"], json!("task-1"));
    assert_eq!(task["task"]["status"], json!("running"));
    assert_eq!(task["task"]["kind"], json!("shell"));
    // Full AgentTaskWire key set (ACP parity) — nulls included.
    for key in [
        "command",
        "created_at",
        "started_at",
        "completed_at",
        "output_preview",
        "output_bytes",
        "subagent_phase",
        "subagent_type",
        "parent_tool_call_id",
        "parent_agent_id",
        "suspended_reason",
        "swarm_index",
        "swarm_depth",
        "run_in_background",
        "bound_model",
        "model_preference",
    ] {
        assert!(task["task"].get(key).is_some(), "missing task key {key}");
    }

    let progress = translator.translate(&session_frame(
        "task.updated",
        json!({ "taskId": "task-1", "status": "running", "output_chunk": "line", "stream": "stdout" }),
    ));
    assert_eq!(progress.len(), 1);
    assert_eq!(event_type(&progress[0]), "TaskProgress");
    let progress_payload = event_payload(&progress[0]);
    assert_eq!(progress_payload["task_id"], json!("task-1"));
    assert_eq!(progress_payload["output_chunk"], json!("line"));
    assert_eq!(progress_payload["stream"], json!("stdout"));
    assert_eq!(progress_payload["phase"], json!("running"));

    let completed = translator.translate(&session_frame(
        "task.updated",
        json!({ "taskId": "task-1", "status": "completed", "output_preview": "ok", "completed_at": 7 }),
    ));
    assert_eq!(completed.len(), 1);
    assert_eq!(event_type(&completed[0]), "TaskCompleted");
    let completed_payload = event_payload(&completed[0]);
    assert_eq!(completed_payload["status"], json!("completed"));
    assert_eq!(completed_payload["output_preview"], json!("ok"));
    assert_eq!(completed_payload["completed_at"], json!(7));
}

#[test]
fn task_updated_terminal_first_sighting_announces_then_completes() {
    let mut translator = WireTranslator::new();
    let messages = translator.translate(&session_frame(
        "task.updated",
        json!({ "taskId": "task-9", "status": "failed", "error": "nope" }),
    ));
    assert_eq!(messages.len(), 2);
    assert_eq!(event_type(&messages[0]), "TaskCreated");
    assert_eq!(event_type(&messages[1]), "TaskCompleted");
    assert_eq!(event_payload(&messages[1])["status"], json!("failed"));
    assert_eq!(event_payload(&messages[1])["error"], json!("nope"));
}

// ---------------------------------------------------------------------------
// subagent.updated state machine
// ---------------------------------------------------------------------------

#[test]
fn subagent_updated_lifecycle_with_stable_provenance() {
    let mut translator = WireTranslator::new();
    let spawned = translator.translate(&session_frame(
        "subagent.updated",
        json!({
            "phase": "spawned",
            "agentId": "agent-1",
            "parentToolCallId": "agent-call-1",
            "subagentType": "reviewer",
            "description": "Review it",
        }),
    ));
    assert_eq!(spawned.len(), 2);
    assert_eq!(event_type(&spawned[0]), "TaskCreated");
    let task = event_payload(&spawned[0])["task"].clone();
    assert_eq!(task["kind"], json!("subagent"));
    assert_eq!(task["status"], json!("queued"));
    assert_eq!(task["subagent_phase"], json!("queued"));
    assert_eq!(task["parent_tool_call_id"], json!("agent-call-1"));
    let lifecycle = event_payload(&spawned[1]);
    assert_eq!(event_type(&spawned[1]), "SubagentLifecycle");
    assert_eq!(lifecycle["phase"], json!("queued"));
    assert_eq!(lifecycle["agent_id"], json!("agent-1"));
    assert_eq!(lifecycle["task_id"], json!("agent-1"));

    // `started` carries no provenance on the wire; the learned parent link
    // backfills the lifecycle.
    let started = translator.translate(&session_frame(
        "subagent.updated",
        json!({ "phase": "started", "agentId": "agent-1" }),
    ));
    assert_eq!(started.len(), 1);
    let started_payload = event_payload(&started[0]);
    assert_eq!(started_payload["phase"], json!("working"));
    assert_eq!(
        started_payload["parent_tool_call_id"],
        json!("agent-call-1")
    );
    assert_eq!(started_payload["subagent_type"], json!("reviewer"));

    let completed = translator.translate(&session_frame(
        "subagent.updated",
        json!({ "phase": "completed", "agentId": "agent-1", "resultSummary": "LGTM" }),
    ));
    assert_eq!(completed.len(), 2);
    assert_eq!(event_type(&completed[0]), "TaskCompleted");
    let completed_payload = event_payload(&completed[0]);
    assert_eq!(completed_payload["status"], json!("completed"));
    assert_eq!(completed_payload["output_preview"], json!("LGTM"));
    assert_eq!(event_payload(&completed[1])["phase"], json!("completed"));
}

#[test]
fn subagent_updated_failed_and_suspended_carry_reasons() {
    let mut translator = WireTranslator::new();
    let failed = translator.translate(&session_frame(
        "subagent.updated",
        json!({ "phase": "failed", "agentId": "agent-2", "error": "crashed" }),
    ));
    assert_eq!(event_type(&failed[0]), "TaskCompleted");
    assert_eq!(event_payload(&failed[0])["status"], json!("failed"));
    assert_eq!(event_payload(&failed[0])["error"], json!("crashed"));
    assert_eq!(event_payload(&failed[1])["error"], json!("crashed"));

    let suspended = translator.translate(&session_frame(
        "subagent.updated",
        json!({ "phase": "suspended", "agentId": "agent-2", "reason": "rate limited" }),
    ));
    assert_eq!(suspended.len(), 1);
    let payload = event_payload(&suspended[0]);
    assert_eq!(payload["phase"], json!("suspended"));
    assert_eq!(payload["error"], json!("rate limited"));
}

// ---------------------------------------------------------------------------
// plan.updated / usage.updated / session.config
// ---------------------------------------------------------------------------

#[test]
fn plan_updated_maps_to_plan_display() {
    let messages = translate_event(&session_frame(
        "plan.updated",
        json!({ "content": "- [pending] ship", "filePath": "/tmp/plan.md" }),
    ));
    assert_eq!(
        event_payload(&messages[0]),
        json!({ "content": "- [pending] ship", "file_path": "/tmp/plan.md" })
    );
}

#[test]
fn usage_updated_maps_to_status_update() {
    let messages = translate_event(&session_frame(
        "usage.updated",
        json!({
            "contextUsage": 0.5,
            "contextTokens": 1000,
            "maxContextTokens": 2000,
            "tokenUsage": { "input_other": 9, "output": 3, "input_cache_read": 1, "input_cache_creation": 0 },
        }),
    ));
    assert_eq!(event_type(&messages[0]), "StatusUpdate");
    assert_eq!(
        event_payload(&messages[0]),
        json!({
            "context_usage": 0.5,
            "token_usage": { "input_other": 9, "output": 3, "input_cache_read": 1, "input_cache_creation": 0 },
            "context_tokens": 1000,
            "max_context_tokens": 2000,
        })
    );
}

#[test]
fn session_config_maps_model_to_config_option_update() {
    let messages = translate_event(&session_frame("session.config", json!({ "model": "k2" })));
    assert_eq!(event_type(&messages[0]), "ConfigOptionUpdate");
    assert_eq!(
        event_payload(&messages[0]),
        json!({
            "session_id": "sess-1",
            "status": "known",
            "options": [{
                "id": "model",
                "optionType": "unknown",
                "label": Value::Null,
                "currentValue": "k2",
                "options": Value::Null,
            }],
        })
    );
}

// ---------------------------------------------------------------------------
// session.status / turn.completed / turn.failed
// ---------------------------------------------------------------------------

fn session_status_params(line: &str) -> Value {
    let message = parse(line);
    assert_eq!(message["method"], json!("session_status"));
    message["params"].clone()
}

#[test]
fn session_status_seq_is_monotonic_per_session() {
    let mut translator = WireTranslator::new();
    let busy = translator.translate(&session_frame("session.status", json!({ "state": "busy" })));
    let idle = translator.translate(&session_frame("session.status", json!({ "state": "idle" })));
    let first = session_status_params(&busy[0]);
    let second = session_status_params(&idle[0]);
    assert_eq!(first["state"], json!("busy"));
    assert_eq!(first["seq"], json!(1));
    assert_eq!(second["seq"], json!(2));
    assert_eq!(first["session_id"], json!("sess-1"));
    assert_eq!(first["worker_id"], json!("runtime"));
    assert!(first["updated_at"].is_string());
    // The same translator tracks a second session independently.
    let other = translator.translate(&EventFrame::Session {
        session_id: "sess-2".to_string(),
        seq: 1,
        event: "session.status".to_string(),
        payload: json!({ "state": "busy" }),
    });
    assert_eq!(session_status_params(&other[0])["seq"], json!(1));
}

#[test]
fn session_status_error_also_raises_a_notice() {
    let mut translator = WireTranslator::new();
    let messages = translator.translate(&session_frame(
        "session.status",
        json!({ "state": "error", "reason": "engine_dead", "detail": "engine exploded" }),
    ));
    assert_eq!(messages.len(), 2);
    let params = session_status_params(&messages[0]);
    assert_eq!(params["state"], json!("error"));
    assert_eq!(params["reason"], json!("engine_dead"));
    assert_eq!(params["detail"], json!("engine exploded"));
    assert_eq!(event_type(&messages[1]), "SessionNotice");
    assert_eq!(
        event_payload(&messages[1])["text"],
        json!("engine exploded")
    );
}

#[test]
fn turn_completed_terminates_the_matching_request() {
    let mut translator = WireTranslator::new();
    let messages = translator.translate(&session_frame(
        "turn.completed",
        json!({
            "requestId": "req-7",
            "usage": { "input_other": 10, "output": 5, "input_cache_read": 0, "input_cache_creation": 0 },
        }),
    ));
    assert_eq!(messages.len(), 3);
    // 1. prompt result (the primary terminal the frontend matches by id)
    let result = parse(&messages[0]);
    assert_eq!(result["id"], json!("req-7"));
    assert_eq!(result["result"]["status"], json!("finished"));
    // 2. terminal session_status carrying prompt_request_id
    let params = session_status_params(&messages[1]);
    assert_eq!(params["state"], json!("idle"));
    assert_eq!(params["reason"], json!("finished"));
    assert_eq!(params["prompt_request_id"], json!("req-7"));
    // 3. usage snapshot
    let usage = event_payload(&messages[2]);
    assert_eq!(event_type(&messages[2]), "StatusUpdate");
    assert_eq!(usage["token_usage"]["output"], json!(5));
    assert_eq!(usage["context_usage"], Value::Null);
}

#[test]
fn turn_failed_cancelled_is_not_an_error() {
    let mut translator = WireTranslator::new();
    let messages = translator.translate(&session_frame(
        "turn.failed",
        json!({ "requestId": "req-8", "error": { "code": "cancelled", "message": "Turn cancelled." } }),
    ));
    assert_eq!(messages.len(), 2);
    assert_eq!(parse(&messages[0])["result"]["status"], json!("cancelled"));
    let params = session_status_params(&messages[1]);
    assert_eq!(params["state"], json!("idle"));
    assert_eq!(params["reason"], json!("cancelled"));
    assert_eq!(params["prompt_request_id"], json!("req-8"));
}

#[test]
fn turn_failed_error_surfaces_error_response_and_status() {
    let mut translator = WireTranslator::new();
    let messages = translator.translate(&session_frame(
        "turn.failed",
        json!({
            "requestId": "req-9",
            "error": { "code": "model_timeout", "message": "model timed out", "retryable": true },
        }),
    ));
    assert_eq!(messages.len(), 2);
    let error = parse(&messages[0]);
    assert_eq!(error["id"], json!("req-9"));
    assert_eq!(error["error"]["code"], json!(-32000));
    assert_eq!(error["error"]["message"], json!("model timed out"));
    assert_eq!(error["error"]["data"]["code"], json!("model_timeout"));
    assert_eq!(error["error"]["data"]["retryable"], json!(true));
    let params = session_status_params(&messages[1]);
    assert_eq!(params["state"], json!("error"));
    assert_eq!(params["reason"], json!("model_timeout"));
    assert_eq!(params["detail"], json!("model timed out"));
}

// ---------------------------------------------------------------------------
// runtime-scoped events and generic fallbacks
// ---------------------------------------------------------------------------

#[test]
fn runtime_ready_has_no_visual_wire() {
    let messages = translate_event(&runtime_frame(
        "runtime.ready",
        json!({ "runtimeVersion": "0.0.0-fixture" }),
    ));
    assert!(messages.is_empty());
}

#[test]
fn runtime_warning_becomes_a_session_notice() {
    let messages = translate_event(&runtime_frame(
        "runtime.warning",
        json!({ "code": "deprecation", "message": "old field in use" }),
    ));
    assert_eq!(messages.len(), 1);
    let payload = event_payload(&messages[0]);
    assert_eq!(event_type(&messages[0]), "SessionNotice");
    assert_eq!(payload["text"], json!("old field in use"));
    assert_eq!(payload["reason"], json!("deprecation"));
}

#[test]
fn unknown_events_fall_back_to_a_generic_notice() {
    let session_side = translate_event(&session_frame("mcp.loading", json!({ "x": 1 })));
    assert_eq!(session_side.len(), 1);
    assert_eq!(event_type(&session_side[0]), "SessionNotice");
    assert!(event_payload(&session_side[0])["text"]
        .as_str()
        .unwrap_or_default()
        .contains("mcp.loading"));

    let runtime_side = translate_event(&runtime_frame("runtime.metrics", json!({})));
    assert_eq!(event_type(&runtime_side[0]), "SessionNotice");
    assert!(event_payload(&runtime_side[0])["text"]
        .as_str()
        .unwrap_or_default()
        .contains("runtime.metrics"));
}

// ---------------------------------------------------------------------------
// Synthesized wire events (desktop-side, not runtime-v1 events)
// ---------------------------------------------------------------------------

#[test]
fn synthesize_turn_begin_carries_user_input_and_request_id() {
    let line = synthesize_turn_begin("req-1", json!("hello"));
    let payload = event_payload(&line);
    assert_eq!(event_type(&line), "TurnBegin");
    assert_eq!(payload["user_input"], json!("hello"));
    assert_eq!(payload["request_id"], json!("req-1"));

    let with_parts = synthesize_turn_begin(
        "req-2",
        json!([{ "type": "text", "text": "hi" }, { "type": "image_url", "image_url": { "url": "data:..." } }]),
    );
    assert_eq!(
        event_payload(&with_parts)["user_input"][1]["type"],
        json!("image_url")
    );
}

#[test]
fn synthesize_approval_resolved_normalizes_decision_vocabularies() {
    let approve = synthesize_approval_resolved("ap-1", "approved");
    let payload = event_payload(&approve);
    assert_eq!(event_type(&approve), "ApprovalRequestResolved");
    assert_eq!(payload["request_id"], json!("ap-1"));
    assert_eq!(payload["response"], json!("approve"));

    assert_eq!(
        event_payload(&synthesize_approval_resolved("ap-2", "rejected"))["response"],
        json!("reject")
    );
    // Desktop wire vocabulary passes through unchanged.
    assert_eq!(
        event_payload(&synthesize_approval_resolved("ap-3", "approve_for_session"))["response"],
        json!("approve_for_session")
    );
}

#[test]
fn forget_session_resets_per_session_state() {
    let mut translator = WireTranslator::new();
    let _ = translator.translate(&session_frame("session.status", json!({ "state": "busy" })));
    translator.forget_session("sess-1");
    let after = translator.translate(&session_frame("session.status", json!({ "state": "idle" })));
    assert_eq!(session_status_params(&after[0])["seq"], json!(1));
}

// ---------------------------------------------------------------------------
// Fixture worker end-to-end: hello -> fixture.emitScript -> translate
// ---------------------------------------------------------------------------

fn node_on_path() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn fixture_config() -> SpawnConfig {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("runtime-fixture-worker.mjs");
    SpawnConfig {
        program: "node".to_string(),
        args: vec![fixture.to_string_lossy().into_owned()],
        env: Vec::new(),
        cwd: None,
    }
}

fn handshake_config() -> HandshakeConfig {
    HandshakeConfig {
        hello: HelloParams::new(
            env!("CARGO_PKG_VERSION"),
            std::env::temp_dir().to_string_lossy().into_owned(),
            std::env::consts::OS,
            std::env::consts::ARCH,
            "en-US",
        ),
        expected_commit: Some(EXPECTED_COMMIT.to_string()),
        timeout: CALL_TIMEOUT,
    }
}

fn recv_event(receiver: &std::sync::mpsc::Receiver<EventFrame>, what: &str) -> EventFrame {
    receiver
        .recv_timeout(EVENT_TIMEOUT)
        .unwrap_or_else(|err| panic!("timed out waiting for {what}: {err}"))
}

/// Compact per-line descriptor for the wire-sequence snapshot.
fn describe(line: &str) -> String {
    let message = parse(line);
    match message["method"].as_str().unwrap_or_default() {
        "event" => format!(
            "event:{}",
            message["params"]["type"].as_str().unwrap_or("?")
        ),
        "request" => format!(
            "request:{}",
            message["params"]["type"].as_str().unwrap_or("?")
        ),
        "session_status" => format!(
            "session_status:{}:{}",
            message["params"]["state"].as_str().unwrap_or("?"),
            message["params"]["reason"].as_str().unwrap_or("-")
        ),
        _ if message.get("result").is_some() => {
            format!(
                "result:{}",
                message["result"]["status"].as_str().unwrap_or("?")
            )
        }
        _ => "other".to_string(),
    }
}

#[test]
fn fixture_script_translates_to_the_expected_wire_sequence() {
    if !node_on_path() {
        eprintln!("skipping fixture_script_translates: `node` was not found on PATH");
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config());
    supervisor.start().expect("spawn fixture worker");
    let info = supervisor
        .handshake(&handshake_config())
        .expect("handshake");
    assert_eq!(info.selected_protocol, RUNTIME_PROTOCOL);

    let events = supervisor.take_event_receiver().expect("event receiver");
    let mut translator = WireTranslator::new();

    // runtime.ready is consumed by the handshake and produces no wire lines.
    let ready = recv_event(&events, "runtime.ready");
    assert!(translator.translate(&ready).is_empty());

    let answer = supervisor
        .call(
            "fixture.emitScript",
            json!({ "sessionId": "translate-session", "requestId": "req-translate-1" }),
            CALL_TIMEOUT,
        )
        .expect("emitScript");
    assert_eq!(answer, json!({ "emitted": 8 }));

    let script_events = [
        "content.delta",
        "thinking.delta",
        "tool.started",
        "tool.updated",
        "tool.completed",
        "approval.requested",
        "question.requested",
        "turn.completed",
    ];
    let mut wire_sequence: Vec<Vec<String>> = Vec::new();
    for name in script_events {
        let frame = recv_event(&events, name);
        match &frame {
            EventFrame::Session {
                session_id,
                seq,
                event,
                ..
            } => {
                assert_eq!(session_id, "translate-session");
                assert_eq!(event, name);
                let _ = seq;
            }
            other => panic!("expected session event {name}, got {other:?}"),
        }
        wire_sequence.push(translator.translate(&frame));
    }

    // Full-sequence snapshot: the 8 fixture events produce exactly this wire
    // shape series.
    let snapshot: Vec<Vec<String>> = wire_sequence
        .iter()
        .map(|lines| lines.iter().map(|line| describe(line)).collect())
        .collect();
    assert_eq!(
        snapshot,
        vec![
            vec!["event:ContentPart".to_string()],
            vec!["event:ContentPart".to_string()],
            vec!["event:ToolCall".to_string()],
            vec!["event:ToolCallPart".to_string()],
            vec!["event:ToolResult".to_string()],
            vec!["request:ApprovalRequest".to_string()],
            vec!["request:QuestionRequest".to_string()],
            vec![
                "result:finished".to_string(),
                "session_status:idle:finished".to_string(),
                "event:StatusUpdate".to_string(),
            ],
        ]
    );

    // Golden spot checks against the fixture payload contents.
    assert_eq!(
        event_payload(&wire_sequence[0][0]),
        json!({ "type": "text", "text": "fixture content delta" })
    );
    assert_eq!(
        event_payload(&wire_sequence[1][0]),
        json!({ "type": "think", "think": "fixture thinking delta" })
    );
    assert_eq!(
        event_payload(&wire_sequence[2][0]),
        json!({
            "type": "function",
            "id": "fixture-tool-1",
            "function": { "name": "fixture_tool", "arguments": "{\"path\":\"/tmp/fixture\"" },
        })
    );
    assert_eq!(
        event_payload(&wire_sequence[3][0]),
        json!({ "arguments_part": ",\"recursive\":true}" })
    );
    let tool_result = event_payload(&wire_sequence[4][0]);
    assert_eq!(tool_result["tool_call_id"], json!("fixture-tool-1"));
    assert_eq!(tool_result["return_value"]["is_error"], json!(false));
    assert_eq!(
        tool_result["return_value"]["message"],
        json!("fixture tool completed")
    );
    assert_eq!(
        tool_result["return_value"]["display"],
        json!([{ "type": "text", "text": "fixture display block" }])
    );
    assert_eq!(
        tool_result["return_value"]["extras"],
        json!({ "tool_title": "fixture_tool" })
    );

    let approval = parse(&wire_sequence[5][0]);
    assert_eq!(approval["id"], json!("fixture-approval-1"));
    let approval_payload = &approval["params"]["payload"];
    assert_eq!(approval_payload["action"], json!("run_command"));
    assert_eq!(
        approval_payload["description"],
        json!("Fixture approval request")
    );
    assert_eq!(approval_payload["tool_call_id"], json!("fixture-tool-1"));
    assert_eq!(approval_payload["kind"], json!("command"));

    let question = parse(&wire_sequence[6][0]);
    assert_eq!(question["id"], json!("fixture-question-1"));
    let question_item = &question["params"]["payload"]["questions"][0];
    assert_eq!(question_item["question"], json!("Fixture question?"));
    assert_eq!(question_item["header"], json!("Fixture"));
    assert_eq!(
        question_item["options"],
        json!([{ "label": "yes" }, { "label": "no" }])
    );
    assert_eq!(question_item["multi_select"], json!(false));

    let terminal = session_status_params(&wire_sequence[7][1]);
    assert_eq!(terminal["prompt_request_id"], json!("req-translate-1"));
    assert_eq!(terminal["seq"], json!(1));
    assert_eq!(parse(&wire_sequence[7][0])["id"], json!("req-translate-1"));

    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("clean shutdown");
}
