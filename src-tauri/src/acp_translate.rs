//! Translate between Kimi Code ACP JSON-RPC and the legacy desktop wire stream.

use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

pub fn wire_event_message(event_type: &str, payload: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "method": "event",
        "params": {
            "type": event_type,
            "payload": payload,
        }
    })
    .to_string()
}

pub fn wire_request_message(request_type: &str, payload: Value, id: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "method": "request",
        "id": id,
        "params": {
            "type": request_type,
            "payload": payload,
        }
    })
    .to_string()
}

pub fn legacy_prompt_status_from_stop_reason(stop_reason: Option<&str>) -> &'static str {
    match stop_reason.unwrap_or("end_turn") {
        "cancelled" => "cancelled",
        _ => "finished",
    }
}

pub fn legacy_user_input_to_acp_prompt(params: &Value) -> Value {
    let user_input = params.get("user_input").cloned().unwrap_or(Value::Null);
    match user_input {
        Value::String(text) => json!([{ "type": "text", "text": text }]),
        Value::Array(ref parts) => {
            let mut blocks = Vec::new();
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    blocks.push(json!({ "type": "text", "text": text }));
                    continue;
                }
                if let Some(image_url) = part.get("image_url") {
                    if let Some(url) = image_url.get("url").and_then(Value::as_str) {
                        if let Some((mime_type, data)) = parse_data_url(url) {
                            blocks.push(json!({
                                "type": "image",
                                "mimeType": mime_type,
                                "data": data,
                            }));
                        }
                    }
                }
            }
            if blocks.is_empty() {
                json!([{ "type": "text", "text": user_input.to_string() }])
            } else {
                Value::Array(blocks)
            }
        }
        other => json!([{ "type": "text", "text": other.to_string() }]),
    }
}

/// Kimi Code 0.23.3 exposes plan mode through ACP `session/set_mode`, but its
/// ACP adapter has no swarm mode or generic config option for swarm. Keep the
/// standard `session/prompt` schema and append a model-visible compatibility
/// instruction instead of sending an unsupported top-level field. Appending
/// also preserves ACP's leading slash-command detection on the user block.
pub fn legacy_user_input_to_acp_prompt_with_swarm(params: &Value, swarm_mode: bool) -> Value {
    let mut prompt = legacy_user_input_to_acp_prompt(params);
    if !swarm_mode {
        return prompt;
    }

    if let Some(blocks) = prompt.as_array_mut() {
        blocks.push(json!({
            "type": "text",
            "text": concat!(
                "<system-reminder>\n",
                "Swarm mode is enabled for this turn. When the request can be split into two ",
                "or more independent items, use AgentSwarm. AgentSwarm must be the only tool ",
                "call in that model response. If parallel delegation would not help, continue ",
                "normally.\n",
                "</system-reminder>"
            ),
        }));
    }
    prompt
}

pub fn legacy_approval_result_to_acp_outcome(result: &Value) -> Value {
    let response = result
        .get("response")
        .and_then(Value::as_str)
        .unwrap_or("reject");
    let option_id = match response {
        "approve" => "allow-once",
        "approve_for_session" => "allow-always",
        _ => "reject-once",
    };
    json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option_id,
        }
    })
}

pub fn translate_session_update(session_id: &str, update: &Value) -> Vec<String> {
    let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else {
        return Vec::new();
    };

    match kind {
        "agent_message_chunk" | "agent_thought_chunk" | "thought_message_chunk" => {
            let content = update.get("content").cloned().unwrap_or(Value::Null);
            let part_type = content
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("text");
            let wire_type = if kind == "agent_thought_chunk"
                || kind == "thought_message_chunk"
                || matches!(part_type, "think" | "thinking" | "reasoning")
            {
                "think"
            } else {
                "text"
            };
            let text = content
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| content.get("think").and_then(Value::as_str))
                .or_else(|| content.get("thinking").and_then(Value::as_str))
                .or_else(|| content.get("reasoning").and_then(Value::as_str))
                .unwrap_or("");
            vec![wire_event_message(
                "ContentPart",
                json!({
                    "type": wire_type,
                    wire_type: text,
                }),
            )]
        }
        // The desktop already renders the submitted prompt optimistically. ACP
        // user-message chunks are runtime echoes and carry no origin metadata,
        // so translating them would also expose model-only injected blocks as
        // user messages. Ignore every echo; the original local prompt remains
        // visible even when its text intentionally resembles a system reminder.
        "user_message_chunk" => Vec::new(),
        "tool_call" => {
            let tool_call_id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("tool-call");
            let title = update
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let raw_input = update.get("rawInput").cloned().unwrap_or(Value::Null);
            let tool_name = canonical_agent_tool_name(title, &raw_input).unwrap_or(title);
            let arguments = if raw_input.is_null() {
                "{}".to_string()
            } else {
                raw_input.to_string()
            };
            vec![wire_event_message(
                "ToolCall",
                json!({
                    "type": "function",
                    "id": tool_call_id,
                    "function": {
                        "name": tool_name,
                        "arguments": arguments,
                    }
                }),
            )]
        }
        "tool_call_update" => translate_tool_call_update(update),
        "plan" => {
            let entries = update
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let content = entries
                .iter()
                .filter_map(|entry| entry.get("content").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            vec![wire_event_message(
                "PlanDisplay",
                json!({
                    "content": content,
                    "file_path": "",
                }),
            )]
        }
        "usage_update" => {
            // ACP reports absolute token counts; the desktop wire expects a 0–1 ratio.
            let used = update.get("used").and_then(Value::as_f64);
            let size = update.get("size").and_then(Value::as_f64);
            let context_usage = match (used, size) {
                (Some(u), Some(s)) if s > 0.0 => Some((u / s).clamp(0.0, 1.0)),
                _ => None,
            };
            vec![wire_event_message(
                "StatusUpdate",
                json!({
                    "context_usage": context_usage,
                    "token_usage": null,
                    "context_tokens": used.map(|u| u.round() as u64),
                    "max_context_tokens": size.map(|s| s.round() as u64),
                }),
            )]
        }
        "task_created" | "task.created" | "event.task.created" => {
            translate_task_created(session_id, update)
        }
        "task_progress" | "task.progress" | "event.task.progress" => {
            translate_task_progress(session_id, update)
        }
        "task_completed" | "task.completed" | "event.task.completed" => {
            translate_task_completed(session_id, update)
        }
        "subagent_spawned" | "subagent.spawned" => {
            translate_subagent_lifecycle(session_id, "queued", update)
        }
        "subagent_started" | "subagent.started" => {
            translate_subagent_lifecycle(session_id, "working", update)
        }
        "subagent_suspended" | "subagent.suspended" => {
            translate_subagent_lifecycle(session_id, "suspended", update)
        }
        "subagent_completed" | "subagent.completed" => {
            translate_subagent_lifecycle(session_id, "completed", update)
        }
        "subagent_failed" | "subagent.failed" => {
            translate_subagent_lifecycle(session_id, "failed", update)
        }
        "subagent_cancelled" | "subagent.cancelled" | "subagent_aborted" | "subagent.aborted" => {
            translate_subagent_lifecycle(session_id, "cancelled", update)
        }
        "available_commands_update" => translate_available_commands_update(update),
        _ => Vec::new(),
    }
}

fn translate_available_commands_update(update: &Value) -> Vec<String> {
    let commands = update
        .get("availableCommands")
        .or_else(|| update.get("available_commands"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let slash_commands = commands
        .iter()
        .filter_map(|command| {
            let name = command.get("name").and_then(Value::as_str)?;
            let description = command
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            let input_hint = command
                .get("input")
                .and_then(|input| input.get("hint"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let aliases = command
                .get("aliases")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            Some(json!({
                "name": name,
                "description": description,
                "aliases": aliases,
                "input_hint": input_hint,
            }))
        })
        .collect::<Vec<_>>();

    vec![wire_event_message(
        "SlashCommandsUpdate",
        json!({ "slash_commands": slash_commands }),
    )]
}

fn canonical_agent_tool_name<'a>(title: &'a str, raw_input: &Value) -> Option<&'a str> {
    let normalized_title = title
        .chars()
        .filter(|character| !matches!(character, ' ' | '_' | '-'))
        .collect::<String>()
        .to_ascii_lowercase();
    if normalized_title == "agentswarm" {
        return Some("AgentSwarm");
    }
    if normalized_title == "agent" {
        return Some("Agent");
    }

    let has_swarm_shape = raw_input.get("prompt_template").is_some()
        || raw_input.get("promptTemplate").is_some()
        || raw_input.get("resume_agent_ids").is_some()
        || raw_input.get("resumeAgentIds").is_some();
    if has_swarm_shape {
        return Some("AgentSwarm");
    }

    let has_agent_shape = (raw_input.get("subagent_type").is_some()
        || raw_input.get("subagentType").is_some()
        || raw_input.get("run_in_background").is_some()
        || raw_input.get("runInBackground").is_some())
        && raw_input.get("prompt").is_some();
    has_agent_shape.then_some("Agent")
}

/// Translate Kimi extension notifications that may be emitted as standalone
/// JSON-RPC methods rather than nested ACP `session/update` variants. Kimi Code
/// 0.23.3 does not currently bridge SDK subagent lifecycle events into ACP, but
/// these method names and payloads are the runtime's existing Web/SDK contract.
pub fn translate_acp_lifecycle_notification(
    session_id: &str,
    method: &str,
    params: &Value,
) -> Vec<String> {
    match method {
        "task.created" | "event.task.created" => translate_task_created(session_id, params),
        "task.progress" | "event.task.progress" => translate_task_progress(session_id, params),
        "task.completed" | "event.task.completed" => translate_task_completed(session_id, params),
        "subagent.spawned" => translate_subagent_lifecycle(session_id, "queued", params),
        "subagent.started" => translate_subagent_lifecycle(session_id, "working", params),
        "subagent.suspended" => translate_subagent_lifecycle(session_id, "suspended", params),
        "subagent.completed" => translate_subagent_lifecycle(session_id, "completed", params),
        "subagent.failed" => translate_subagent_lifecycle(session_id, "failed", params),
        "subagent.cancelled" | "subagent.aborted" => {
            translate_subagent_lifecycle(session_id, "cancelled", params)
        }
        _ => Vec::new(),
    }
}

fn event_payload(value: &Value) -> &Value {
    value
        .get("payload")
        .filter(|payload| payload.is_object())
        .unwrap_or(value)
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

fn event_session_id(fallback: &str, outer: &Value, inner: &Value) -> String {
    string_for_keys(inner, &["session_id", "sessionId"])
        .or_else(|| string_for_keys(outer, &["session_id", "sessionId"]))
        .unwrap_or_else(|| fallback.to_string())
}

fn normalize_task(session_id: &str, outer: &Value, raw: &Value) -> Option<Value> {
    let id = string_for_keys(raw, &["id", "task_id", "taskId"])?;
    let task_session_id = event_session_id(session_id, outer, raw);
    let description = value_for_keys(raw, &["description", "item", "task"])
        .cloned()
        .or_else(|| value_for_keys(raw, &["command"]).cloned())
        .unwrap_or(Value::Null);

    Some(json!({
        "id": id,
        "session_id": task_session_id,
        "kind": cloned_for_keys(raw, &["kind"]),
        "description": description,
        "status": value_for_keys(raw, &["status", "state", "outcome"])
            .cloned()
            .unwrap_or_else(|| json!("queued")),
        "command": cloned_for_keys(raw, &["command"]),
        "created_at": cloned_for_keys(raw, &["created_at", "createdAt"]),
        "started_at": cloned_for_keys(raw, &["started_at", "startedAt"]),
        "completed_at": cloned_for_keys(raw, &["completed_at", "completedAt"]),
        "output_preview": cloned_for_keys(raw, &["output_preview", "outputPreview"]),
        "output_bytes": cloned_for_keys(raw, &["output_bytes", "outputBytes"]),
        "subagent_phase": cloned_for_keys(raw, &["subagent_phase", "subagentPhase", "phase"]),
        "subagent_type": cloned_for_keys(raw, &["subagent_type", "subagentType", "subagent_name", "subagentName"]),
        "parent_tool_call_id": cloned_for_keys(raw, &["parent_tool_call_id", "parentToolCallId", "task_tool_call_id"]),
        "suspended_reason": cloned_for_keys(raw, &["suspended_reason", "suspendedReason", "reason"]),
        "swarm_index": cloned_for_keys(raw, &["swarm_index", "swarmIndex"]),
        "run_in_background": cloned_for_keys(raw, &["run_in_background", "runInBackground"]),
    }))
}

fn translate_task_created(session_id: &str, update: &Value) -> Vec<String> {
    let payload = event_payload(update);
    let raw_task = payload.get("task").unwrap_or(payload);
    let Some(task) = normalize_task(session_id, update, raw_task) else {
        return Vec::new();
    };
    let normalized_session_id = task
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or(session_id);
    vec![wire_event_message(
        "TaskCreated",
        json!({
            "session_id": normalized_session_id,
            "task": task,
        }),
    )]
}

fn translate_task_progress(session_id: &str, update: &Value) -> Vec<String> {
    let payload = event_payload(update);
    let Some(task_id) = string_for_keys(payload, &["task_id", "taskId", "id"]) else {
        return Vec::new();
    };
    vec![wire_event_message(
        "TaskProgress",
        json!({
            "session_id": event_session_id(session_id, update, payload),
            "task_id": task_id,
            "output_chunk": cloned_for_keys(payload, &["output_chunk", "outputChunk", "chunk"]),
            "stream": cloned_for_keys(payload, &["stream"]),
            "phase": cloned_for_keys(payload, &["phase", "subagent_phase", "subagentPhase"]),
        }),
    )]
}

fn translate_task_completed(session_id: &str, update: &Value) -> Vec<String> {
    let payload = event_payload(update);
    let Some(task_id) = string_for_keys(payload, &["task_id", "taskId", "id"]) else {
        return Vec::new();
    };
    vec![wire_event_message(
        "TaskCompleted",
        json!({
            "session_id": event_session_id(session_id, update, payload),
            "task_id": task_id,
            "status": value_for_keys(payload, &["status", "state", "outcome"])
                .cloned()
                .unwrap_or_else(|| json!("completed")),
            "output_preview": cloned_for_keys(payload, &["output_preview", "outputPreview", "result_summary", "resultSummary", "summary"]),
            "output_bytes": cloned_for_keys(payload, &["output_bytes", "outputBytes"]),
            "completed_at": cloned_for_keys(payload, &["completed_at", "completedAt"]),
            "error": cloned_for_keys(payload, &["error"]),
        }),
    )]
}

fn translate_subagent_lifecycle(session_id: &str, phase: &str, update: &Value) -> Vec<String> {
    let payload = event_payload(update);
    let Some(task_id) = string_for_keys(
        payload,
        &[
            "subagent_id",
            "subagentId",
            "agent_id",
            "agentId",
            "task_id",
            "taskId",
            "id",
        ],
    ) else {
        return Vec::new();
    };
    let normalized_session_id = event_session_id(session_id, update, payload);
    let parent_tool_call_id = cloned_for_keys(
        payload,
        &[
            "parent_tool_call_id",
            "parentToolCallId",
            "task_tool_call_id",
        ],
    );
    let subagent_type = cloned_for_keys(
        payload,
        &[
            "subagent_type",
            "subagentType",
            "subagent_name",
            "subagentName",
        ],
    );
    let description = cloned_for_keys(payload, &["description", "item", "task"]);
    let swarm_index = cloned_for_keys(payload, &["swarm_index", "swarmIndex"]);
    let error = if phase == "suspended" {
        value_for_keys(
            payload,
            &["error", "suspended_reason", "suspendedReason", "reason"],
        )
        .cloned()
        .unwrap_or(Value::Null)
    } else {
        cloned_for_keys(payload, &["error"])
    };
    let lifecycle = wire_event_message(
        "SubagentLifecycle",
        json!({
            "session_id": normalized_session_id,
            "agent_id": task_id,
            "task_id": task_id,
            "parent_tool_call_id": parent_tool_call_id,
            "subagent_type": subagent_type,
            "phase": phase,
            "description": description,
            "swarm_index": swarm_index,
            "error": error,
        }),
    );

    match phase {
        "queued" => {
            let task = json!({
                "id": task_id,
                "session_id": normalized_session_id,
                "kind": "subagent",
                "description": description,
                "status": "queued",
                "command": null,
                "created_at": cloned_for_keys(payload, &["created_at", "createdAt"]),
                "started_at": null,
                "completed_at": null,
                "output_preview": null,
                "output_bytes": null,
                "subagent_phase": "queued",
                "subagent_type": subagent_type,
                "parent_tool_call_id": parent_tool_call_id,
                "suspended_reason": null,
                "swarm_index": swarm_index,
                "run_in_background": cloned_for_keys(payload, &["run_in_background", "runInBackground"]),
            });
            vec![
                wire_event_message(
                    "TaskCreated",
                    json!({ "session_id": normalized_session_id, "task": task }),
                ),
                lifecycle,
            ]
        }
        "completed" | "failed" | "cancelled" => {
            let output_preview = if phase == "completed" {
                cloned_for_keys(
                    payload,
                    &[
                        "output_preview",
                        "outputPreview",
                        "result_summary",
                        "resultSummary",
                        "summary",
                    ],
                )
            } else {
                error.clone()
            };
            let status = match phase {
                "failed" => "failed",
                "cancelled" => "cancelled",
                _ => "completed",
            };
            vec![
                wire_event_message(
                    "TaskCompleted",
                    json!({
                        "session_id": normalized_session_id,
                        "task_id": task_id,
                        "status": status,
                        "output_preview": output_preview,
                        "output_bytes": cloned_for_keys(payload, &["output_bytes", "outputBytes"]),
                        "completed_at": cloned_for_keys(payload, &["completed_at", "completedAt"]),
                        "error": error,
                    }),
                ),
                lifecycle,
            ]
        }
        _ => vec![lifecycle],
    }
}

/// Map an ACP session/update payload to a legacy wire JSON-RPC line when it is a
/// reverse request (question/elicitation) rather than a stream event.
pub fn acp_update_to_wire_event(_session_id: &str, update: &Value) -> Option<String> {
    let session_update = update.get("sessionUpdate")?;
    let question = session_update.get("question")?;
    Some(acp_question_to_legacy_request(question))
}

fn acp_question_to_legacy_request(question: &Value) -> String {
    let prompt = question
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("Continue?");
    let id = question
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("question-1");
    let tool_call_id = question
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("ask-user");
    let payload = json!({
        "id": id,
        "tool_call_id": tool_call_id,
        "questions": [{
            "question": prompt,
            "header": prompt,
            "options": [],
            "multi_select": false,
        }],
    });
    wire_request_message("QuestionRequest", payload, json!(id))
}

fn translate_tool_call_update(update: &Value) -> Vec<String> {
    let status = update.get("status").and_then(Value::as_str).unwrap_or("");
    let tool_call_id = update
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("tool-call");

    if status == "completed" || status == "failed" {
        let message = tool_call_update_message(update);
        return vec![wire_event_message(
            "ToolResult",
            json!({
                "tool_call_id": tool_call_id,
                "return_value": {
                    "is_error": status == "failed",
                    "output": message,
                    "message": message,
                    "display": tool_call_update_display(update),
                }
            }),
        )];
    }

    if status == "in_progress" {
        let message = tool_call_update_message(update);
        let display = tool_call_update_display(update);
        if message.is_empty() && display.is_empty() {
            return Vec::new();
        }
        return vec![wire_event_message(
            "ToolResult",
            json!({
                "tool_call_id": tool_call_id,
                "return_value": {
                    "is_error": false,
                    "output": message,
                    "message": message,
                    "display": display,
                    "extras": { "in_progress": true },
                }
            }),
        )];
    }

    Vec::new()
}

fn tool_call_update_message(update: &Value) -> String {
    update
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(extract_tool_call_content_text)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| {
            update
                .get("content")
                .cloned()
                .map(|content| content.to_string())
                .unwrap_or_default()
        })
}

fn tool_call_update_display(update: &Value) -> Vec<Value> {
    update
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(tool_call_content_to_display_item)
                .collect()
        })
        .unwrap_or_default()
}

fn extract_tool_call_content_text(item: &Value) -> Option<String> {
    match item.get("type").and_then(Value::as_str) {
        Some("content") => item
            .get("content")
            .and_then(|content| content.get("text").and_then(Value::as_str))
            .map(str::to_string),
        Some("text") => item.get("text").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

fn tool_call_content_to_display_item(item: &Value) -> Option<Value> {
    match item.get("type").and_then(Value::as_str) {
        Some("content") => {
            let content = item.get("content")?;
            let content_type = content
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("text");
            match content_type {
                "text" => Some(json!({
                    "type": "text",
                    "data": {
                        "type": "text",
                        "text": content.get("text").and_then(Value::as_str).unwrap_or(""),
                    }
                })),
                "image" => Some(json!({
                    "type": "image",
                    "data": {
                        "type": "image",
                        "data": content.get("data").and_then(Value::as_str).unwrap_or(""),
                        "mimeType": content.get("mimeType").and_then(Value::as_str).unwrap_or("image/png"),
                    }
                })),
                _ => content.get("text").and_then(Value::as_str).map(|text| {
                    json!({
                        "type": "text",
                        "data": { "type": "text", "text": text }
                    })
                }),
            }
        }
        Some("text") => Some(json!({
            "type": "text",
            "data": {
                "type": "text",
                "text": item.get("text").and_then(Value::as_str).unwrap_or(""),
            }
        })),
        _ => None,
    }
}

pub fn acp_permission_to_legacy_request(
    request_id: u64,
    params: &Value,
) -> Option<(String, String)> {
    let tool_call = params.get("toolCall")?;
    let tool_call_id = tool_call
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or("tool-call");
    let title = tool_call
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Tool approval required");
    let kind = tool_call
        .get("kind")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let wire_id = request_id.to_string();
    let payload = json!({
        "id": wire_id,
        "action": title,
        "description": title,
        "sender": "acp",
        "tool_call_id": tool_call_id,
        "kind": kind,
    });
    Some((
        wire_request_message("ApprovalRequest", payload, json!(wire_id)),
        wire_id,
    ))
}

pub fn normalize_workspace_path(raw: &str, workspace: &Path) -> Result<PathBuf, String> {
    let workspace_root = std::fs::canonicalize(workspace).map_err(|err| {
        format!(
            "Session workspace `{}` is not accessible: {err}",
            workspace.display()
        )
    })?;

    let logical = if Path::new(raw).is_absolute() {
        normalize_path(Path::new(raw))
    } else {
        normalize_path(&workspace_root.join(raw))
    };

    ensure_path_under_workspace(logical, &workspace_root)
}

fn ensure_path_under_workspace(logical: PathBuf, workspace_root: &Path) -> Result<PathBuf, String> {
    if logical.exists() {
        let canonical = std::fs::canonicalize(&logical)
            .map_err(|err| format!("Path `{}` could not be resolved: {err}", logical.display()))?;
        return ensure_canonical_within_workspace(&canonical, workspace_root);
    }

    let mut ancestor = logical.clone();
    let mut suffix = PathBuf::new();
    while !ancestor.exists() {
        let file_name = ancestor
            .file_name()
            .ok_or_else(|| format!("Path `{}` is invalid", logical.display()))?;
        suffix = Path::new(file_name).join(suffix);
        if !ancestor.pop() {
            ancestor = workspace_root.to_path_buf();
            break;
        }
    }

    let canonical_ancestor = std::fs::canonicalize(&ancestor)
        .map_err(|err| format!("Path `{}` could not be resolved: {err}", logical.display()))?;
    ensure_canonical_within_workspace(&canonical_ancestor, workspace_root)?;
    Ok(canonical_ancestor.join(suffix))
}

fn ensure_canonical_within_workspace(
    path: &Path,
    workspace_root: &Path,
) -> Result<PathBuf, String> {
    if path.starts_with(workspace_root) {
        Ok(path.to_path_buf())
    } else {
        Err(format!(
            "Path `{}` is outside the session workspace `{}`",
            path.display(),
            workspace_root.display()
        ))
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime_type = meta
        .split(';')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    Some((mime_type, data.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_wire_message(message: &str) -> Value {
        serde_json::from_str(message).expect("valid wire message")
    }

    #[test]
    fn maps_agent_chunk_to_content_part() {
        let update = json!({
            "sessionUpdate": "agent_message_chunk",
            "messageId": "m1",
            "content": { "type": "text", "text": "hello" }
        });
        let messages = translate_session_update("sess-1", &update);
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("ContentPart"));
        assert!(messages[0].contains("hello"));
    }

    #[test]
    fn ignores_originless_acp_user_message_echoes() {
        for text in [
            "hello",
            "<system-reminder>literal user text</system-reminder>",
        ] {
            let update = json!({
                "sessionUpdate": "user_message_chunk",
                "messageId": "m1",
                "content": { "type": "text", "text": text }
            });
            assert!(translate_session_update("sess-1", &update).is_empty());
        }
    }

    #[test]
    fn maps_tool_call_update_in_progress_to_tool_result() {
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call_1",
            "status": "in_progress",
            "content": [{
                "type": "content",
                "content": { "type": "text", "text": "Running command..." }
            }]
        });
        let messages = translate_session_update("sess-1", &update);
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("ToolResult"));
        assert!(messages[0].contains("Running command"));
        assert!(messages[0].contains("in_progress"));
    }

    #[test]
    fn normalize_workspace_path_preserves_nested_relative_path() {
        let workspace = std::env::temp_dir().join("kimi-acp-workspace-nested-test");
        let nested_parent = workspace.join("a");
        std::fs::create_dir_all(&nested_parent).expect("temp workspace");
        let resolved = normalize_workspace_path("a/b/c.md", &workspace).expect("nested path");
        let expected_suffix = Path::new("a").join("b").join("c.md");
        assert!(
            resolved.ends_with(&expected_suffix),
            "resolved={resolved:?} should end with {expected_suffix:?}"
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn maps_tool_call_update_completed_to_tool_result() {
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call_1",
            "status": "completed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "done" } }]
        });
        let messages = translate_session_update("sess-1", &update);
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("ToolResult"));
        assert!(messages[0].contains("call_1"));
    }

    #[test]
    fn legacy_prompt_maps_text_blocks() {
        let prompt = legacy_user_input_to_acp_prompt(&json!({ "user_input": "hi" }));
        assert_eq!(prompt[0]["type"], "text");
        assert_eq!(prompt[0]["text"], "hi");
    }

    #[test]
    fn swarm_compat_prompt_preserves_user_block_and_appends_instruction() {
        let prompt =
            legacy_user_input_to_acp_prompt_with_swarm(&json!({ "user_input": "/help" }), true);
        assert_eq!(prompt.as_array().unwrap().len(), 2);
        assert_eq!(prompt[0]["text"], "/help");
        assert!(prompt[1]["text"]
            .as_str()
            .unwrap()
            .contains("Swarm mode is enabled"));
    }

    #[test]
    fn maps_task_created_to_stable_snake_case_contract() {
        let update = json!({
            "sessionUpdate": "task_created",
            "task": {
                "id": "task-1",
                "sessionId": "runtime-session",
                "kind": "subagent",
                "description": "Review parser",
                "status": "running",
                "createdAt": "2026-07-10T10:00:00Z",
                "parentToolCallId": "call-1",
                "swarmIndex": 2
            }
        });

        let messages = translate_session_update("desktop-session", &update);
        assert_eq!(messages.len(), 1);
        let message = parse_wire_message(&messages[0]);
        assert_eq!(message["params"]["type"], "TaskCreated");
        assert_eq!(
            message["params"]["payload"]["session_id"],
            "runtime-session"
        );
        let task = &message["params"]["payload"]["task"];
        assert_eq!(task["id"], "task-1");
        assert_eq!(task["parent_tool_call_id"], "call-1");
        assert_eq!(task["swarm_index"], 2);
        assert!(task.get("output_preview").is_some());
        assert!(task.get("completed_at").is_some());
    }

    #[test]
    fn maps_standalone_task_progress_notification() {
        let messages = translate_acp_lifecycle_notification(
            "sess-1",
            "event.task.progress",
            &json!({
                "payload": {
                    "task_id": "task-1",
                    "output_chunk": "checking",
                    "stream": "text",
                    "phase": "reviewing"
                }
            }),
        );
        assert_eq!(messages.len(), 1);
        let message = parse_wire_message(&messages[0]);
        assert_eq!(message["params"]["type"], "TaskProgress");
        assert_eq!(message["params"]["payload"]["session_id"], "sess-1");
        assert_eq!(message["params"]["payload"]["task_id"], "task-1");
        assert_eq!(message["params"]["payload"]["output_chunk"], "checking");
        assert_eq!(message["params"]["payload"]["phase"], "reviewing");
    }

    #[test]
    fn maps_subagent_spawned_to_task_and_lifecycle_events() {
        let messages = translate_acp_lifecycle_notification(
            "sess-1",
            "subagent.spawned",
            &json!({
                "subagentId": "agent-1",
                "subagentName": "reviewer",
                "parentToolCallId": "swarm-call",
                "description": "Review ACP bridge",
                "swarmIndex": 0,
                "runInBackground": false
            }),
        );
        assert_eq!(messages.len(), 2);
        let created = parse_wire_message(&messages[0]);
        let lifecycle = parse_wire_message(&messages[1]);
        assert_eq!(created["params"]["type"], "TaskCreated");
        assert_eq!(
            created["params"]["payload"]["task"]["parent_tool_call_id"],
            "swarm-call"
        );
        assert_eq!(lifecycle["params"]["type"], "SubagentLifecycle");
        assert_eq!(lifecycle["params"]["payload"]["agent_id"], "agent-1");
        assert_eq!(lifecycle["params"]["payload"]["task_id"], "agent-1");
        assert_eq!(lifecycle["params"]["payload"]["phase"], "queued");
    }

    #[test]
    fn maps_subagent_completed_to_task_and_lifecycle_events() {
        let messages = translate_session_update(
            "sess-1",
            &json!({
                "sessionUpdate": "subagent.completed",
                "subagentId": "agent-1",
                "resultSummary": "Review complete"
            }),
        );
        assert_eq!(messages.len(), 2);
        let completed = parse_wire_message(&messages[0]);
        let lifecycle = parse_wire_message(&messages[1]);
        assert_eq!(completed["params"]["type"], "TaskCompleted");
        assert_eq!(completed["params"]["payload"]["status"], "completed");
        assert_eq!(
            completed["params"]["payload"]["output_preview"],
            "Review complete"
        );
        assert_eq!(lifecycle["params"]["type"], "SubagentLifecycle");
        assert_eq!(lifecycle["params"]["payload"]["phase"], "completed");
    }

    #[test]
    fn preserves_subagent_suspension_reason_in_lifecycle_contract() {
        let messages = translate_acp_lifecycle_notification(
            "sess-1",
            "subagent.suspended",
            &json!({ "subagentId": "agent-1", "reason": "rate limited" }),
        );
        assert_eq!(messages.len(), 1);
        let lifecycle = parse_wire_message(&messages[0]);
        assert_eq!(lifecycle["params"]["type"], "SubagentLifecycle");
        assert_eq!(lifecycle["params"]["payload"]["phase"], "suspended");
        assert_eq!(lifecycle["params"]["payload"]["error"], "rate limited");
    }

    #[test]
    fn generic_tool_updates_keep_the_existing_contract() {
        let messages = translate_session_update(
            "sess-1",
            &json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "completed",
                "content": [{
                    "type": "content",
                    "content": { "type": "text", "text": "done" }
                }]
            }),
        );
        assert_eq!(messages.len(), 1);
        let message = parse_wire_message(&messages[0]);
        assert_eq!(message["params"]["type"], "ToolResult");
    }

    #[test]
    fn canonicalizes_agent_swarm_name_from_actual_tool_input_shape() {
        let messages = translate_session_update(
            "sess-1",
            &json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "swarm-call",
                "title": "Review the ACP bridge in parallel",
                "rawInput": {
                    "prompt_template": "Review {{item}}",
                    "items": ["mode handling", "event handling"]
                }
            }),
        );
        assert_eq!(messages.len(), 1);
        let message = parse_wire_message(&messages[0]);
        assert_eq!(message["params"]["type"], "ToolCall");
        assert_eq!(
            message["params"]["payload"]["function"]["name"],
            "AgentSwarm"
        );
    }

    #[test]
    fn normalize_workspace_path_rejects_escape() {
        let workspace = std::env::temp_dir().join("kimi-acp-workspace-test");
        std::fs::create_dir_all(&workspace).expect("temp workspace");
        let err = normalize_workspace_path(r"..\secret.txt", &workspace).unwrap_err();
        assert!(err.contains("outside the session workspace"));
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn approval_result_maps_to_acp_outcome() {
        let outcome = legacy_approval_result_to_acp_outcome(&json!({ "response": "approve" }));
        assert_eq!(outcome["outcome"]["optionId"], "allow-once");
    }

    #[test]
    fn maps_acp_question_to_legacy_request() {
        let update = json!({ "sessionUpdate": { "question": { "prompt": "Continue?" } } });
        let msg = acp_update_to_wire_event("sess-1", &update).expect("event");
        assert!(msg.contains(r#""method":"request""#));
        assert!(msg.contains("QuestionRequest"));
        assert!(msg.contains("Continue?"));
    }

    #[test]
    fn maps_available_commands_update_to_slash_commands() {
        let update = json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [
                {
                    "name": "compact",
                    "description": "Compact context",
                    "input": { "hint": "optional instruction" }
                },
                {
                    "name": "help",
                    "description": "Show help"
                }
            ]
        });
        let messages = translate_session_update("sess-1", &update);
        assert_eq!(messages.len(), 1);
        let parsed = parse_wire_message(&messages[0]);
        assert_eq!(parsed["params"]["type"], "SlashCommandsUpdate");
        let commands = parsed["params"]["payload"]["slash_commands"]
            .as_array()
            .expect("slash_commands array");
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0]["name"], "compact");
        assert_eq!(commands[0]["input_hint"], "optional instruction");
        assert_eq!(commands[1]["name"], "help");
        assert!(commands[1]["input_hint"].is_null());
    }

    #[test]
    fn maps_usage_update_to_context_ratio() {
        let update = json!({
            "sessionUpdate": "usage_update",
            "used": 53000,
            "size": 200000,
        });
        let messages = translate_session_update("sess-1", &update);
        assert_eq!(messages.len(), 1);
        let parsed = parse_wire_message(&messages[0]);
        assert_eq!(parsed["params"]["type"], "StatusUpdate");
        let payload = &parsed["params"]["payload"];
        assert!((payload["context_usage"].as_f64().unwrap() - 0.265).abs() < 1e-9);
        assert_eq!(payload["context_tokens"], 53000);
        assert_eq!(payload["max_context_tokens"], 200000);
        assert!(payload["token_usage"].is_null());
    }

    #[test]
    fn usage_update_without_size_omits_ratio() {
        let update = json!({
            "sessionUpdate": "usage_update",
            "used": 1000,
        });
        let messages = translate_session_update("sess-1", &update);
        let payload = &parse_wire_message(&messages[0])["params"]["payload"];
        assert!(payload["context_usage"].is_null());
        assert_eq!(payload["context_tokens"], 1000);
        assert!(payload["max_context_tokens"].is_null());
    }
}
