//! runtime-v1 event translation into desktop wire messages (M2 wave 2).
//!
//! Input: [`EventFrame`]s from the supervisor's event stream. Output: legacy
//! desktop wire JSON strings — the exact lines `wire:message` delivers to the
//! frontend `useSessionStream` consumer. The output contract is
//! `src/hooks/wireTypes.ts` with `the pre-cutover ACP translation module` as the behavioral
//! baseline: field names, nesting, and optionality are kept identical so the
//! existing UI works unchanged. Input payload conventions follow
//! `runtime/kimi-code/apps/desktop-runtime/src/protocol.ts`
//! (`sessionEventPayloadSchemas`) and `event-bridge.ts` (camelCase structural
//! ids, snake_case token usage, approval display pre-wrapped as
//! `[{type, data}]`, and no `turn.cancelled` — cancelled turns arrive as
//! `turn.failed` with error code `cancelled`).
//!
//! Most mappings are pure, but three are inherently stateful, so the primary
//! entry point is [`WireTranslator`]:
//!
//! - the `session_status` wire `seq` must be strictly increasing per session
//!   (the frontend drops `seq <= last`), so the translator owns a per-session
//!   counter (see `turn.rs`);
//! - `task.updated` is a state machine: a task is announced via `TaskCreated`
//!   exactly once, later sightings become `TaskProgress` / `TaskCompleted`
//!   (see `task.rs`);
//! - subagent provenance (`parentToolCallId` / `subagentType` / `agentId`) is
//!   learned from `subagent.updated` and `tool.started`, so `tool.updated` /
//!   `tool.completed` — which carry no provenance in runtime-v1 — still wrap
//!   subagent tool traffic as `SubagentEvent` with a stable parent link. A
//!   top-level `ToolCallPart` has no id and would otherwise corrupt the
//!   argument stream of an interleaved main-agent call.
//!
//! [`translate_event`] is the stateless one-shot form: a fresh translator per
//! call. Fine for stateless events, but per-session seq/dedup/provenance
//! state does not survive across calls — production wiring must hold one
//! [`WireTranslator`].
//!
//! Submodules: `turn` (session status / turn terminals), `task`
//! (task/subagent state machines), `interaction` (approval/question reverse
//! requests), `fidelity` (the M3 wave-2 parity events — step.* / compaction.*
//! / mcp.loading.* / slash_commands.update / background_task.observed /
//! turn.steered — plus the completed `session.config` options mapping and the
//! BackgroundTaskObserved synthesis behind `tool.completed`).

mod fidelity;
mod interaction;
mod task;
mod turn;

use super::protocol::EventFrame;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// `{"jsonrpc":"2.0","method":"event",...}` line, byte-compatible with the
/// ACP-era `wire_event_message`.
fn wire_event_message(event_type: &str, payload: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "method": "event",
        "params": { "type": event_type, "payload": payload },
    })
    .to_string()
}

/// Reverse-request line (`ApprovalRequest` / `QuestionRequest`); the frontend
/// answers with a JSON-RPC response echoing `id`.
fn wire_request_message(request_type: &str, payload: Value, id: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "method": "request",
        "id": id,
        "params": { "type": request_type, "payload": payload },
    })
    .to_string()
}

/// Prompt result line answering a frontend `prompt` request; the frontend
/// terminates the prompt whose id matches `result.status` finished/cancelled.
fn wire_prompt_result_message(request_id: &str, status: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": { "status": status },
    })
    .to_string()
}

/// Prompt error line for a failed turn. JSON-RPC error codes are integers;
/// the runtime-v1 string code and retryable flag ride in `data`.
fn wire_prompt_error_message(
    request_id: &str,
    code: &str,
    message: &str,
    retryable: bool,
) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": -32000,
            "message": message,
            "data": { "code": code, "retryable": retryable },
        },
    })
    .to_string()
}

/// `SessionNotice` is the wire's only always-visible generic card. Its `kind`
/// is typed as the literal `"restart"` in wireTypes.ts (the frontend reads
/// only `text`), so every notice — including non-restart ones — carries it.
fn session_notice_wire(text: &str, reason: Option<&str>) -> String {
    wire_event_message(
        "SessionNotice",
        json!({ "text": text, "kind": "restart", "reason": reason }),
    )
}

/// Generic fallback for event names outside the M1 registry: surfaced as a
/// readable notice instead of being dropped (UI compatibility checklist §3).
fn unsupported_event_notice(event: &str) -> String {
    session_notice_wire(
        &format!("Unsupported runtime event `{event}`; shown as a generic notice."),
        Some("unsupported_event"),
    )
}

/// Known event missing a required identifier: surfaced, never a panic.
fn malformed_event_notice(event: &str, field: &str) -> String {
    session_notice_wire(
        &format!("Runtime event `{event}` is missing required field `{field}`."),
        Some("malformed_event"),
    )
}

fn value_for_keys<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|key| value.get(*key).filter(|candidate| !candidate.is_null()))
}

fn string_for_keys(value: &Value, keys: &[&str]) -> Option<String> {
    value_for_keys(value, keys)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn cloned_for_keys(value: &Value, keys: &[&str]) -> Value {
    value_for_keys(value, keys).cloned().unwrap_or(Value::Null)
}

/// Learned parentage of one subagent (`subagent.updated` phase `spawned`).
#[derive(Clone, Default)]
struct SubagentProvenance {
    parent_tool_call_id: Option<String>,
    subagent_type: Option<String>,
}

/// What `tool.started` records about one open tool call; `tool.updated` /
/// `tool.completed` carry no provenance in runtime-v1, so they look up the
/// call here (and `tool.completed` removes it).
#[derive(Clone, Default)]
struct ToolCallOrigin {
    parent_tool_call_id: Option<String>,
    agent_id: Option<String>,
    name: Option<String>,
}

/// Per-session translator state; see the module docs for why these exist.
#[derive(Default)]
struct SessionTranslateState {
    status_seq: u64,
    announced_tasks: HashSet<String>,
    subagent_provenance: HashMap<String, SubagentProvenance>,
    tool_calls: HashMap<String, ToolCallOrigin>,
}

/// Stateful runtime-v1 -> wire translator. One instance may serve any number
/// of sessions; state is keyed by session id.
#[derive(Default)]
pub struct WireTranslator {
    sessions: HashMap<String, SessionTranslateState>,
}

impl WireTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop per-session state (session close / eviction).
    pub fn forget_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    /// Translate one event frame into 0..n wire message lines.
    pub fn translate(&mut self, frame: &EventFrame) -> Vec<String> {
        match frame {
            EventFrame::Session {
                session_id,
                event,
                payload,
                ..
            } => {
                let state = self.sessions.entry(session_id.clone()).or_default();
                translate_session_event(state, session_id, event, payload)
            }
            EventFrame::Runtime { event, payload } => translate_runtime_event(event, payload),
        }
    }
}

/// Stateless one-shot translation (fresh [`WireTranslator`] per call).
pub fn translate_event(frame: &EventFrame) -> Vec<String> {
    WireTranslator::new().translate(frame)
}

/// Synthesize the `TurnBegin` wire event for a desktop-minted turn.
/// runtime-v1 deliberately has no turn-begin event (protocol.ts); the M2
/// translate layer emits it from `turn.start` traffic. `user_input` is the
/// wire prompt shape (`string | ContentPart[]`). The request id rides along
/// as an extra field — the frontend ignores it today, but the compatibility
/// checklist requires TurnBegin to carry the turn/request identity.
pub fn synthesize_turn_begin(request_id: &str, user_input: Value) -> String {
    wire_event_message(
        "TurnBegin",
        json!({ "user_input": user_input, "request_id": request_id }),
    )
}

/// Synthesize the `ApprovalRequestResolved` echo after the desktop answers an
/// approval via `approval.respond` (runtime-v1 has no resolution event).
/// `decision` accepts the desktop wire vocabulary (`approve` /
/// `approve_for_session` / `reject`) and the runtime-v1 one (`approved` /
/// `rejected` / `cancelled`), normalized onto the wire vocabulary — the
/// frontend only recognizes `approve*` / `reject` as boolean outcomes.
pub fn synthesize_approval_resolved(approval_id: &str, decision: &str) -> String {
    let response = match decision {
        "approved" => "approve",
        "rejected" | "cancelled" => "reject",
        other => other,
    };
    wire_event_message(
        "ApprovalRequestResolved",
        json!({ "request_id": approval_id, "response": response }),
    )
}

fn translate_session_event(
    state: &mut SessionTranslateState,
    session_id: &str,
    event: &str,
    payload: &Value,
) -> Vec<String> {
    match event {
        "content.delta" => vec![wire_event_message(
            "ContentPart",
            content_part_payload(payload, "text"),
        )],
        "thinking.delta" => vec![wire_event_message(
            "ContentPart",
            content_part_payload(payload, "think"),
        )],
        "tool.started" => translate_tool_started(state, payload),
        "tool.updated" => translate_tool_updated(state, payload),
        "tool.completed" => translate_tool_completed(state, session_id, payload),
        "approval.requested" => interaction::translate_approval_requested(payload),
        "question.requested" => interaction::translate_question_requested(payload),
        "task.updated" => task::translate_task_updated(state, session_id, payload),
        "subagent.updated" => task::translate_subagent_updated(state, session_id, payload),
        "plan.updated" => vec![wire_event_message(
            "PlanDisplay",
            json!({
                "content": payload.get("content").and_then(Value::as_str).unwrap_or(""),
                "file_path": string_for_keys(payload, &["filePath", "file_path"]).unwrap_or_default(),
            }),
        )],
        "usage.updated" => vec![wire_event_message(
            "StatusUpdate",
            json!({
                // The bridge already reports the 0-1 ratio and the snake_case
                // wire TokenUsage; nulls pass through explicitly (ACP parity).
                "context_usage": cloned_for_keys(payload, &["contextUsage", "context_usage"]),
                "token_usage": cloned_for_keys(payload, &["tokenUsage", "token_usage"]),
                "context_tokens": cloned_for_keys(payload, &["contextTokens", "context_tokens"]),
                "max_context_tokens": cloned_for_keys(payload, &["maxContextTokens", "max_context_tokens"]),
            }),
        )],
        "session.config" => fidelity::translate_session_config(session_id, payload),
        "session.status" => turn::translate_session_status(state, session_id, payload),
        "turn.completed" => turn::translate_turn_completed(state, session_id, payload),
        "turn.failed" => turn::translate_turn_failed(state, session_id, payload),
        // M3 wave-2 fidelity events (protocol-parity.ts); shapes pinned by
        // golden tests in tests/runtime_translate.rs.
        "step.begin" => fidelity::translate_step_begin(payload),
        "step.interrupted" => fidelity::translate_step_interrupted(),
        "step.retry" => fidelity::translate_step_retry(payload),
        "compaction.begin" => fidelity::translate_marker_event("CompactionBegin"),
        "compaction.end" => fidelity::translate_marker_event("CompactionEnd"),
        "mcp.loading.begin" => fidelity::translate_marker_event("MCPLoadingBegin"),
        "mcp.loading.end" => fidelity::translate_marker_event("MCPLoadingEnd"),
        "slash_commands.update" => fidelity::translate_slash_commands_update(payload),
        "background_task.observed" => {
            fidelity::translate_background_task_observed(session_id, payload)
        }
        "turn.steered" => fidelity::translate_turn_steered(payload),
        _ => vec![unsupported_event_notice(event)],
    }
}

/// Runtime-scoped events have no session; routing any produced wire line to a
/// session (or the log) is the wave-3 dispatcher's call.
fn translate_runtime_event(event: &str, payload: &Value) -> Vec<String> {
    match event {
        // Readiness is consumed by the supervisor handshake; there is no
        // visual wire for it (checklist §1 lists session events only).
        "runtime.ready" => Vec::new(),
        // Warnings must not vanish (checklist §3): show the message as a
        // generic notice card.
        "runtime.warning" => {
            let message = payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Runtime warning");
            let code = payload.get("code").and_then(Value::as_str);
            vec![session_notice_wire(message, code)]
        }
        _ => vec![unsupported_event_notice(event)],
    }
}

/// Build the wire `ContentPart` payload. Supports all five wire content types
/// (`think` / `text` / `image_url` / `audio_url` / `video_url`); an explicit
/// payload `type` wins over the event-derived default, and unrecognized types
/// degrade to visible text instead of vanishing.
fn content_part_payload(payload: &Value, default_type: &str) -> Value {
    let part_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(default_type);
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| payload.get("think").and_then(Value::as_str))
        .unwrap_or("");
    let mut part = match part_type {
        "think" => json!({ "type": "think", "think": text }),
        "image_url" => {
            json!({ "type": "image_url", "image_url": media_part(payload, "image_url", text) })
        }
        "audio_url" => {
            json!({ "type": "audio_url", "audio_url": media_part(payload, "audio_url", text) })
        }
        "video_url" => {
            json!({ "type": "video_url", "video_url": media_part(payload, "video_url", text) })
        }
        _ => json!({ "type": "text", "text": text }),
    };
    if let Some(encrypted) = payload.get("encrypted") {
        part["encrypted"] = encrypted.clone();
    }
    part
}

/// Media parts carry `{url, id?}`; a bare `text` URL degrades to `{url}`.
fn media_part(payload: &Value, key: &str, text: &str) -> Value {
    payload
        .get(key)
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({ "url": text }))
}

/// Wrap an inner wire event as `SubagentEvent` when the tool call belongs to
/// a subagent; main-agent traffic stays a plain top-level line. The
/// subagent_type learned at `subagent.updated(spawned)` backfills the
/// envelope so provenance stays stable across events.
fn wrap_or_plain(
    state: &SessionTranslateState,
    origin: Option<&ToolCallOrigin>,
    inner_type: &str,
    inner_payload: Value,
) -> String {
    let Some(origin) = origin else {
        return wire_event_message(inner_type, inner_payload);
    };
    let Some(parent) = origin.parent_tool_call_id.as_deref() else {
        return wire_event_message(inner_type, inner_payload);
    };
    let subagent_type = origin
        .agent_id
        .as_deref()
        .and_then(|id| state.subagent_provenance.get(id))
        .and_then(|learned| learned.subagent_type.clone());
    wire_event_message(
        "SubagentEvent",
        json!({
            "parent_tool_call_id": parent,
            "agent_id": origin.agent_id,
            "subagent_type": subagent_type,
            "event": { "type": inner_type, "payload": inner_payload },
        }),
    )
}

fn translate_tool_started(state: &mut SessionTranslateState, payload: &Value) -> Vec<String> {
    let tool_call_id = string_for_keys(payload, &["toolCallId", "tool_call_id"])
        .unwrap_or_else(|| "tool-call".to_string());
    // Unknown tool names pass through untouched — the frontend registry falls
    // back to its generic card (checklist §4).
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let arguments = payload
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let agent_id = string_for_keys(payload, &["agentId", "agent_id"]);
    let mut parent_tool_call_id =
        string_for_keys(payload, &["parentToolCallId", "parent_tool_call_id"]);
    if parent_tool_call_id.is_none() {
        // The bridge stamps the parent link on tool.started; recover it from
        // the learned subagent provenance if a runtime omits it.
        if let Some(learned) = agent_id
            .as_deref()
            .and_then(|id| state.subagent_provenance.get(id))
        {
            parent_tool_call_id = learned.parent_tool_call_id.clone();
        }
    }
    let origin = ToolCallOrigin {
        parent_tool_call_id,
        agent_id,
        name: Some(name.to_string()),
    };
    state
        .tool_calls
        .insert(tool_call_id.clone(), origin.clone());
    vec![wrap_or_plain(
        state,
        Some(&origin),
        "ToolCall",
        json!({
            "type": "function",
            "id": tool_call_id,
            "function": { "name": name, "arguments": arguments },
        }),
    )]
}

fn translate_tool_updated(state: &mut SessionTranslateState, payload: &Value) -> Vec<String> {
    let tool_call_id = string_for_keys(payload, &["toolCallId", "tool_call_id"])
        .unwrap_or_else(|| "tool-call".to_string());
    let Some(arguments_part) = string_for_keys(payload, &["argumentsPart", "arguments_part"])
    else {
        return Vec::new();
    };
    let origin = state.tool_calls.get(&tool_call_id).cloned();
    vec![wrap_or_plain(
        state,
        origin.as_ref(),
        "ToolCallPart",
        json!({ "arguments_part": arguments_part }),
    )]
}

fn translate_tool_completed(
    state: &mut SessionTranslateState,
    session_id: &str,
    payload: &Value,
) -> Vec<String> {
    let tool_call_id = string_for_keys(payload, &["toolCallId", "tool_call_id"])
        .unwrap_or_else(|| "tool-call".to_string());
    let is_error = payload
        .get("isError")
        .or_else(|| payload.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message = payload.get("message").and_then(Value::as_str).unwrap_or("");
    // return_value.output is `ToolOutputPart[] | string`; anything else the
    // bridge leaked through is stringified so the frontend never renders a
    // raw object.
    let output = match payload.get("output") {
        Some(value @ (Value::String(_) | Value::Array(_))) => value.clone(),
        Some(Value::Null) | None => Value::String(message.to_string()),
        Some(other) => Value::String(other.to_string()),
    };
    let origin = state.tool_calls.remove(&tool_call_id);
    let mut return_value = json!({
        "is_error": is_error,
        "output": output,
        "message": message,
        // Display blocks pass through verbatim; unknown block types hit the
        // frontend generic fallback (checklist §1 ToolResult / §3).
        "display": payload.get("display").and_then(Value::as_array).cloned().unwrap_or_default(),
    });
    let tool_name = origin
        .as_ref()
        .and_then(|origin| origin.name.as_deref())
        .or_else(|| payload.get("name").and_then(Value::as_str));
    if let Some(name) = tool_name {
        // extras.tool_title feeds the frontend's background-task observation
        // heuristic (TaskList/TaskOutput/Cron* titles).
        return_value["extras"] = json!({ "tool_title": name });
    }
    let mut messages = vec![wrap_or_plain(
        state,
        origin.as_ref(),
        "ToolResult",
        json!({ "tool_call_id": tool_call_id, "return_value": return_value }),
    )];
    // Background/cron observation synthesis (ACP parity — the ACP translator
    // derived BackgroundTaskObserved from tool_call updates; the pinned
    // engine has no native per-observation event). The snapshot text is the
    // string output when there is one, else the message.
    let snapshot = match &output {
        Value::String(text) if !text.is_empty() => text.clone(),
        _ => message.to_string(),
    };
    if let Some(observed) = fidelity::background_task_observation_from_tool_completed(
        session_id,
        &tool_call_id,
        tool_name,
        is_error,
        &snapshot,
    ) {
        messages.push(observed);
    }
    messages
}
