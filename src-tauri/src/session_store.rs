//! Local Kimi Code session storage helpers (delete, update metadata, replay history).

use crate::runtime_check::kimi_code_home_dir;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn sessions_root() -> Result<PathBuf, String> {
    Ok(kimi_code_home_dir()?.join("sessions"))
}

/// Locate `~/.kimi-code/sessions/<workDirKey>/<session_id>/`.
pub fn find_session_dir_by_id(session_id: &str) -> Result<Option<PathBuf>, String> {
    let root = sessions_root()?;
    if !root.is_dir() {
        return Ok(None);
    }

    let entries =
        fs::read_dir(&root).map_err(|e| format!("Failed to read {}: {e}", root.display()))?;
    for work_dir_entry in entries.flatten() {
        let work_dir_path = work_dir_entry.path();
        if !work_dir_path.is_dir() {
            continue;
        }
        let candidate = work_dir_path.join(session_id);
        if candidate.is_dir() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

pub fn find_session_dir_by_id_or_err(session_id: &str) -> Result<PathBuf, String> {
    find_session_dir_by_id(session_id)?.ok_or_else(|| "Session not found".to_string())
}

fn session_log_path(session_id: &str) -> Result<Option<PathBuf>, String> {
    Ok(find_session_dir_by_id(session_id)?
        .map(|session_dir| session_dir.join("logs").join("kimi-code.log")))
}

pub fn session_log_offset(session_id: &str) -> Result<Option<u64>, String> {
    let Some(log_path) = session_log_path(session_id)? else {
        return Ok(None);
    };
    match fs::metadata(&log_path) {
        Ok(metadata) => Ok(Some(metadata.len())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Failed to inspect {}: {err}", log_path.display())),
    }
}

pub fn acp_turn_failure_since(session_id: &str, offset: u64) -> Result<Option<String>, String> {
    let Some(log_path) = session_log_path(session_id)? else {
        return Ok(None);
    };
    let mut file = match fs::File::open(&log_path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to open {}: {err}", log_path.display())),
    };
    let length = file
        .metadata()
        .map_err(|err| format!("Failed to inspect {}: {err}", log_path.display()))?
        .len();
    file.seek(SeekFrom::Start(offset.min(length)))
        .map_err(|err| format!("Failed to seek {}: {err}", log_path.display()))?;
    let mut tail = String::new();
    file.read_to_string(&mut tail)
        .map_err(|err| format!("Failed to read {}: {err}", log_path.display()))?;
    Ok(parse_acp_turn_failure_detail(&tail))
}

fn parse_acp_turn_failure_detail(log_tail: &str) -> Option<String> {
    log_tail.lines().rev().find_map(|line| {
        if line.contains("acp: turn ended with failed reason") {
            let error_json = parse_log_string_field(line, " error=")?;
            let payload: Value = serde_json::from_str(&error_json).ok()?;
            return payload
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(str::to_string);
        }
        if line.contains("llm request failed") {
            return parse_log_string_field(line, " errorMessage=")
                .map(|message| message.trim().to_string())
                .filter(|message| !message.is_empty());
        }
        None
    })
}

fn parse_log_string_field(line: &str, marker: &str) -> Option<String> {
    let encoded_value = line.split_once(marker)?.1.trim_start();
    serde_json::Deserializer::from_str(encoded_value)
        .into_iter::<String>()
        .next()?
        .ok()
}

pub fn delete_session_dir(session_id: &str) -> Result<(), String> {
    let session_dir = find_session_dir_by_id_or_err(session_id)?;
    fs::remove_dir_all(&session_dir).map_err(|e| {
        format!(
            "Failed to delete session directory {}: {e}",
            session_dir.display()
        )
    })
}

fn state_json_path(session_dir: &Path) -> PathBuf {
    session_dir.join("state.json")
}

fn local_session_from_dir(session_id: &str, session_dir: &Path) -> Result<Value, String> {
    let state_path = state_json_path(session_dir);
    let content = fs::read_to_string(&state_path)
        .map_err(|e| format!("Failed to read {}: {e}", state_path.display()))?;
    let state: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {e}", state_path.display()))?;

    let title = state
        .get("custom_title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .or_else(|| state.get("title").and_then(Value::as_str))
        .unwrap_or("Untitled");
    let work_dir = state
        .get("workDir")
        .or_else(|| state.get("work_dir"))
        .cloned()
        .unwrap_or(Value::Null);
    let last_updated = state
        .get("updatedAt")
        .or_else(|| state.get("last_updated"))
        .or_else(|| state.get("createdAt"))
        .cloned()
        .unwrap_or(Value::Null);

    Ok(json!({
        "session_id": session_id,
        "title": title,
        "work_dir": work_dir,
        "last_updated": last_updated,
        "session_dir": session_dir,
        "archived": state.get("archived").and_then(Value::as_bool).unwrap_or(false),
    }))
}

pub fn read_local_session(session_id: &str) -> Result<Value, String> {
    let session_dir = find_session_dir_by_id_or_err(session_id)?;
    local_session_from_dir(session_id, &session_dir)
}

pub fn list_local_sessions() -> Result<Vec<Value>, String> {
    let root = sessions_root()?;
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    let work_dirs =
        fs::read_dir(&root).map_err(|e| format!("Failed to read {}: {e}", root.display()))?;
    for work_dir in work_dirs.flatten() {
        let work_dir_path = work_dir.path();
        if !work_dir_path.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&work_dir_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let session_dir = entry.path();
            if !session_dir.is_dir() || !state_json_path(&session_dir).is_file() {
                continue;
            }
            let session_id = entry.file_name().to_string_lossy().into_owned();
            if let Ok(session) = local_session_from_dir(&session_id, &session_dir) {
                sessions.push(session);
            }
        }
    }
    Ok(sessions)
}

fn wire_jsonl_path(session_dir: &Path) -> Option<PathBuf> {
    let legacy = session_dir.join("wire.jsonl");
    if legacy.is_file() {
        return Some(legacy);
    }
    let kimi_code = session_dir.join("agents").join("main").join("wire.jsonl");
    if kimi_code.is_file() {
        return Some(kimi_code);
    }
    None
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PersistedRuntimeModes {
    pub plan_mode: Option<bool>,
    pub permission_mode: Option<String>,
}

/// Read the latest independent Plan and permission states persisted by Kimi Code.
///
/// ACP exposes these as mutually exclusive mode IDs, but Kimi's native session
/// log records them independently. Reading the log avoids resetting an existing
/// session to whatever the global defaults happen to be today.
pub(crate) fn persisted_runtime_modes(session_id: &str) -> Result<PersistedRuntimeModes, String> {
    let Some(session_dir) = find_session_dir_by_id(session_id)? else {
        return Ok(PersistedRuntimeModes::default());
    };
    let Some(wire_file) = wire_jsonl_path(&session_dir) else {
        return Ok(PersistedRuntimeModes::default());
    };
    let content = fs::read_to_string(&wire_file)
        .map_err(|e| format!("Failed to read {}: {e}", wire_file.display()))?;

    let mut modes = PersistedRuntimeModes::default();
    for record in content.lines().filter_map(|line| {
        let line = line.trim();
        (!line.is_empty())
            .then(|| serde_json::from_str::<Value>(line).ok())
            .flatten()
    }) {
        match record.get("type").and_then(Value::as_str) {
            Some("plan_mode.enter") => modes.plan_mode = Some(true),
            Some("plan_mode.cancel" | "plan_mode.exit") => modes.plan_mode = Some(false),
            Some("permission.set_mode") => {
                modes.permission_mode = match record.get("mode").and_then(Value::as_str) {
                    Some("ask" | "default") => Some("manual".to_string()),
                    Some(mode @ ("manual" | "auto" | "yolo")) => Some(mode.to_string()),
                    _ => modes.permission_mode,
                };
            }
            _ => {}
        }
    }

    Ok(modes)
}

pub fn session_swarm_mode(session_id: &str) -> Result<bool, String> {
    let session_dir = find_session_dir_by_id_or_err(session_id)?;
    let state_path = state_json_path(&session_dir);
    if !state_path.is_file() {
        return Ok(false);
    }

    let content = fs::read_to_string(&state_path)
        .map_err(|e| format!("Failed to read {}: {e}", state_path.display()))?;
    let state: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {e}", state_path.display()))?;

    Ok(state
        .get("custom")
        .and_then(|custom| custom.get("kimi_code_desktop"))
        .and_then(|desktop| desktop.get("swarm_mode"))
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

pub fn update_session_swarm_mode(session_id: &str, enabled: bool) -> Result<PathBuf, String> {
    let session_dir = find_session_dir_by_id_or_err(session_id)?;
    let state_path = state_json_path(&session_dir);
    let mut state = if state_path.is_file() {
        let content = fs::read_to_string(&state_path)
            .map_err(|e| format!("Failed to read {}: {e}", state_path.display()))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {e}", state_path.display()))?
    } else {
        json!({ "version": 1 })
    };

    let root = state
        .as_object_mut()
        .ok_or_else(|| "Session state is not a JSON object".to_string())?;
    let custom = root.entry("custom").or_insert_with(|| json!({}));
    let custom = custom
        .as_object_mut()
        .ok_or_else(|| "Session state custom field is not a JSON object".to_string())?;
    let desktop = custom
        .entry("kimi_code_desktop")
        .or_insert_with(|| json!({}));
    let desktop = desktop
        .as_object_mut()
        .ok_or_else(|| "Session desktop state is not a JSON object".to_string())?;
    desktop.insert("swarm_mode".to_string(), json!(enabled));

    let serialized = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize session state: {e}"))?;
    fs::write(&state_path, format!("{serialized}\n"))
        .map_err(|e| format!("Failed to write {}: {e}", state_path.display()))?;

    Ok(session_dir)
}

pub fn update_session_state(
    session_id: &str,
    title: Option<&str>,
    archived: Option<bool>,
) -> Result<PathBuf, String> {
    let session_dir = find_session_dir_by_id_or_err(session_id)?;
    let state_path = state_json_path(&session_dir);

    let mut state = if state_path.is_file() {
        let content = fs::read_to_string(&state_path)
            .map_err(|e| format!("Failed to read {}: {e}", state_path.display()))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {e}", state_path.display()))?
    } else {
        json!({ "version": 1 })
    };

    let obj = state
        .as_object_mut()
        .ok_or_else(|| "Session state is not a JSON object".to_string())?;

    if let Some(title) = title {
        obj.insert("custom_title".to_string(), json!(title));
        obj.insert("title_generated".to_string(), json!(true));
    }

    if let Some(archived) = archived {
        obj.insert("archived".to_string(), json!(archived));
        if archived {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            obj.insert("archived_at".to_string(), json!(now));
            obj.insert("auto_archive_exempt".to_string(), json!(false));
        } else {
            obj.insert("archived_at".to_string(), Value::Null);
            obj.insert("auto_archive_exempt".to_string(), json!(true));
        }
    }

    let serialized = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize session state: {e}"))?;
    fs::write(&state_path, format!("{serialized}\n"))
        .map_err(|e| format!("Failed to write {}: {e}", state_path.display()))?;

    Ok(session_dir)
}

/// Local overrides written by `update_session_state` (title, archived).
pub fn merge_local_metadata_into_legacy(session: &mut Value, session_id: &str) {
    let Some(session_dir) = find_session_dir_by_id(session_id).ok().flatten() else {
        return;
    };
    let state_path = state_json_path(&session_dir);
    if !state_path.is_file() {
        return;
    }
    let Ok(content) = fs::read_to_string(&state_path) else {
        return;
    };
    let Ok(state) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let Some(obj) = session.as_object_mut() else {
        return;
    };
    if let Some(title) = state.get("custom_title").and_then(Value::as_str) {
        if !title.is_empty() {
            obj.insert("title".to_string(), json!(title));
        }
    }
    if let Some(archived) = state.get("archived").and_then(Value::as_bool) {
        obj.insert("archived".to_string(), json!(archived));
    }
}

pub fn replay_session_history(session_id: &str) -> Result<Vec<String>, String> {
    let session_dir = find_session_dir_by_id_or_err(session_id)?;
    let Some(wire_file) = wire_jsonl_path(&session_dir) else {
        return Ok(Vec::new());
    };

    let content = fs::read_to_string(&wire_file)
        .map_err(|e| format!("Failed to read {}: {e}", wire_file.display()))?;

    let records = content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(line).ok()
        })
        .collect::<Vec<_>>();
    let has_turn_prompt_records = records.iter().any(|record| {
        record.get("type").and_then(Value::as_str) == Some("turn.prompt")
            && is_visible_user_source(record)
    });
    let has_loop_event_records = records.iter().any(|record| {
        record.get("type").and_then(Value::as_str) == Some("context.append_loop_event")
    });

    let mut messages = Vec::new();
    let mut next_step = 1u64;
    let mut emitted_turns = HashSet::new();
    for record in records {
        match record.get("type").and_then(Value::as_str) {
            Some("metadata") => continue,
            Some("turn.prompt") => {
                if !is_visible_user_source(&record) {
                    continue;
                }
                replay_turn_prompt(&record, &mut messages, &mut emitted_turns, &mut next_step)?;
            }
            Some("turn.steer") => {
                if !is_visible_user_source(&record) {
                    continue;
                }
                replay_steer_input(&record, &mut messages)?;
            }
            Some("context.append_loop_event") => {
                replay_loop_event(&record, &mut messages, &mut next_step)?;
            }
            Some("context.append_message") => {
                if let Some(message) = record.get("message") {
                    replay_context_message(
                        message,
                        &mut messages,
                        &mut next_step,
                        has_turn_prompt_records,
                        has_loop_event_records,
                    )?;
                }
            }
            _ => {}
        }
    }

    Ok(messages)
}

/// Derive a short session title from the first visible user turn in wire history.
pub fn fallback_title_from_wire(session_id: &str) -> Result<String, String> {
    let session_dir = find_session_dir_by_id_or_err(session_id)?;
    let Some(wire_file) = wire_jsonl_path(&session_dir) else {
        return Err("No conversation history available for title fallback".to_string());
    };

    let content = fs::read_to_string(&wire_file)
        .map_err(|e| format!("Failed to read {}: {e}", wire_file.display()))?;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        match record.get("type").and_then(Value::as_str) {
            Some("turn.prompt") => {
                if !is_visible_user_source(&record) {
                    continue;
                }
                let content = turn_prompt_content(&record);
                if let Some(title) = title_from_content_parts(&content) {
                    return Ok(title);
                }
            }
            Some("context.append_message") => {
                let Some(message) = record.get("message") else {
                    continue;
                };
                if message.get("role").and_then(Value::as_str) != Some("user") {
                    continue;
                }
                if !is_visible_user_message(message) {
                    continue;
                }
                if let Some(title) = title_from_content_parts(&message_content(message)) {
                    return Ok(title);
                }
            }
            _ => {}
        }
    }

    Err("No user message found for title fallback".to_string())
}

fn title_from_content_parts(content: &[Value]) -> Option<String> {
    let text = text_from_content_parts(content);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(shorten_title(trimmed, 50))
}

fn shorten_title(text: &str, max_len: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_len {
        return collapsed;
    }
    let mut end = max_len;
    while end > 0 && !collapsed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &collapsed[..end])
}

fn replay_context_message(
    message: &Value,
    messages: &mut Vec<String>,
    next_step: &mut u64,
    skip_user: bool,
    skip_assistant_and_tool: bool,
) -> Result<(), String> {
    match message.get("role").and_then(Value::as_str) {
        Some("user") => {
            if skip_user {
                return Ok(());
            }
            if !is_visible_user_message(message) {
                return Ok(());
            }
            let content = message_content(message);
            if content.is_empty() {
                return Ok(());
            }
            *next_step = 1;
            push_event(
                messages,
                "TurnBegin",
                json!({
                    "user_input": user_input_from_content(&content),
                }),
            )
        }
        Some("assistant") => {
            if skip_assistant_and_tool {
                return Ok(());
            }
            let content = message_content(message);
            let tool_calls = message
                .get("toolCalls")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if content.is_empty() && tool_calls.is_empty() {
                return Ok(());
            }

            push_event(messages, "StepBegin", json!({ "n": *next_step }))?;
            *next_step += 1;

            for part in content {
                if let Some(content_part) = content_part_payload(&part) {
                    push_event(messages, "ContentPart", content_part)?;
                }
            }

            for tool_call in tool_calls {
                if let Some(payload) = tool_call_payload(&tool_call) {
                    push_event(messages, "ToolCall", payload)?;
                }
            }

            Ok(())
        }
        Some("tool") => {
            if skip_assistant_and_tool {
                return Ok(());
            }
            let Some(tool_call_id) = message
                .get("toolCallId")
                .or_else(|| message.get("tool_call_id"))
                .and_then(Value::as_str)
            else {
                return Ok(());
            };
            let output = text_from_content_parts(&message_content(message));
            push_event(
                messages,
                "ToolResult",
                json!({
                    "tool_call_id": tool_call_id,
                    "return_value": {
                        "is_error": message.get("isError").and_then(Value::as_bool).unwrap_or(false),
                        "output": output,
                        "message": output,
                        "display": [],
                    },
                }),
            )
        }
        _ => Ok(()),
    }
}

fn turn_prompt_content(record: &Value) -> Vec<Value> {
    record
        .get("input")
        .or_else(|| record.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn replay_turn_prompt(
    record: &Value,
    messages: &mut Vec<String>,
    emitted_turns: &mut HashSet<String>,
    next_step: &mut u64,
) -> Result<(), String> {
    if let Some(turn_id) = record
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|turn_id| !turn_id.is_empty())
    {
        if !emitted_turns.insert(turn_id.to_string()) {
            return Ok(());
        }
    }

    let content = turn_prompt_content(record);
    if content.is_empty() {
        return Ok(());
    }

    *next_step = 1;
    push_event(
        messages,
        "TurnBegin",
        json!({
            "user_input": user_input_from_content(&content),
        }),
    )
}

fn replay_steer_input(record: &Value, messages: &mut Vec<String>) -> Result<(), String> {
    let content = turn_prompt_content(record);
    if content.is_empty() {
        return Ok(());
    }

    push_event(
        messages,
        "SteerInput",
        json!({
            "user_input": user_input_from_content(&content),
        }),
    )
}

fn replay_loop_event(
    record: &Value,
    messages: &mut Vec<String>,
    next_step: &mut u64,
) -> Result<(), String> {
    let Some(event) = record.get("event") else {
        return Ok(());
    };

    match event.get("type").and_then(Value::as_str) {
        Some("step.begin") => {
            let step = event
                .get("step")
                .and_then(Value::as_u64)
                .unwrap_or(*next_step);
            *next_step = (*next_step).max(step.saturating_add(1));
            push_event(messages, "StepBegin", json!({ "n": step }))
        }
        Some("content.part") => {
            if let Some(part) = event.get("part") {
                if let Some(content_part) = content_part_payload(part) {
                    push_event(messages, "ContentPart", content_part)?;
                }
            }
            Ok(())
        }
        Some("tool.call") => {
            if let Some(payload) = loop_tool_call_payload(event) {
                push_event(messages, "ToolCall", payload)?;
            }
            Ok(())
        }
        Some("tool.result") => {
            if let Some(payload) = loop_tool_result_payload(event) {
                push_event(messages, "ToolResult", payload)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn push_event(messages: &mut Vec<String>, event_type: &str, payload: Value) -> Result<(), String> {
    push_json(
        messages,
        json!({
            "jsonrpc": "2.0",
            "method": "event",
            "params": {
                "type": event_type,
                "payload": payload,
            },
        }),
    )
}

fn push_json(messages: &mut Vec<String>, value: Value) -> Result<(), String> {
    messages.push(
        serde_json::to_string(&value)
            .map_err(|e| format!("Failed to serialize replay envelope: {e}"))?,
    );
    Ok(())
}

fn message_content(message: &Value) -> Vec<Value> {
    message
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn is_visible_user_source(value: &Value) -> bool {
    match value
        .get("origin")
        .and_then(|origin| origin.get("kind"))
        .and_then(Value::as_str)
    {
        Some(kind) => kind == "user",
        // Some early new-format records omitted origin. Their record type and
        // role remain the only provenance available, so preserve them instead
        // of guessing from user-controlled text.
        None => true,
    }
}

fn is_visible_user_message(message: &Value) -> bool {
    is_visible_user_source(message)
}

fn user_input_from_content(content: &[Value]) -> Value {
    let mut text_parts = Vec::new();
    for part in content {
        if part.get("type").and_then(Value::as_str) != Some("text") {
            return Value::Array(content.to_vec());
        }
        let Some(text) = part.get("text").and_then(Value::as_str) else {
            return Value::Array(content.to_vec());
        };
        text_parts.push(text);
    }
    Value::String(text_parts.join(""))
}

fn content_part_payload(part: &Value) -> Option<Value> {
    match part.get("type").and_then(Value::as_str)? {
        "think" => part
            .get("think")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| json!({ "type": "think", "think": text })),
        "text" => part
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(|text| json!({ "type": "text", "text": text })),
        "image_url" | "audio_url" | "video_url" => Some(part.clone()),
        _ => None,
    }
}

fn tool_call_payload(tool_call: &Value) -> Option<Value> {
    let id = tool_call.get("id").and_then(Value::as_str)?;
    let function = tool_call.get("function")?;
    let name = function.get("name").and_then(Value::as_str)?;
    let arguments = function
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("");
    Some(json!({
        "type": tool_call.get("type").and_then(Value::as_str).unwrap_or("function"),
        "id": id,
        "function": {
            "name": name,
            "arguments": arguments,
        },
    }))
}

fn loop_tool_call_payload(event: &Value) -> Option<Value> {
    let id = event
        .get("toolCallId")
        .or_else(|| event.get("tool_call_id"))
        .or_else(|| event.get("uuid"))
        .and_then(Value::as_str)?;
    let name = event.get("name").and_then(Value::as_str)?;
    let arguments = event
        .get("args")
        .map(json_argument_string)
        .unwrap_or_default();

    Some(json!({
        "type": "function",
        "id": id,
        "function": {
            "name": name,
            "arguments": arguments,
        },
    }))
}

fn loop_tool_result_payload(event: &Value) -> Option<Value> {
    let tool_call_id = event
        .get("toolCallId")
        .or_else(|| event.get("tool_call_id"))
        .or_else(|| event.get("parentUuid"))
        .and_then(Value::as_str)?;
    let result = event.get("result").unwrap_or(&Value::Null);
    let output = result.get("output").cloned().unwrap_or_else(|| {
        if result.is_null() {
            Value::String(String::new())
        } else {
            result.clone()
        }
    });
    let message = result
        .get("message")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| message_from_value(&output));
    let display = result.get("display").cloned().unwrap_or_else(|| json!([]));

    Some(json!({
        "tool_call_id": tool_call_id,
        "return_value": {
            "is_error": result
                .get("isError")
                .or_else(|| result.get("is_error"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "output": output,
            "message": message,
            "display": display,
        },
    }))
}

fn json_argument_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn message_from_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => text_from_content_parts(parts),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn text_from_content_parts(content: &[Value]) -> String {
    content
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn is_method_not_found(response: &crate::acp::JsonRpcResponse) -> bool {
    let Some(error) = &response.error else {
        return false;
    };
    if error
        .message
        .as_deref()
        .map(|message| {
            let lowered = message.to_ascii_lowercase();
            lowered.contains("method not found") || lowered.contains("methodnotfound")
        })
        .unwrap_or(false)
    {
        return true;
    }
    matches!(error.code.as_ref(), Some(code) if code == &json!(-32601))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::lock::set_kimi_code_home;

    fn temp_home(prefix: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join(prefix);
        fs::create_dir_all(&home).expect("create home");
        (dir, home)
    }

    fn write_session_layout(home: &Path, work_key: &str, session_id: &str) -> PathBuf {
        let session_dir = home.join("sessions").join(work_key).join(session_id);
        fs::create_dir_all(&session_dir).expect("create session dir");
        session_dir
    }

    #[test]
    fn extracts_latest_acp_turn_failure_detail_from_log_tail() {
        let log = r#"2026-07-19T16:11:34.288Z WARN  llm request failed errorMessage="404 status code (no body)"
2026-07-19T16:11:34.305Z WARN  acp: turn ended with failed reason error="{\"code\":\"provider.api_error\",\"message\":\"404 status code (no body)\",\"retryable\":false}""#;

        assert_eq!(
            parse_acp_turn_failure_detail(log).as_deref(),
            Some("404 status code (no body)")
        );
    }

    #[test]
    fn extracts_llm_failure_before_acp_summary_is_flushed() {
        let log = r#"2026-07-19T16:11:34.288Z WARN  llm request failed errorMessage="404 status code (no body)" statusCode=404"#;

        assert_eq!(
            parse_acp_turn_failure_detail(log).as_deref(),
            Some("404 status code (no body)")
        );
    }

    #[test]
    fn reads_only_acp_failure_appended_after_prompt_offset() {
        let (_guard, home) = temp_home("prompt-error-tail");
        let session_id = "session-prompt-error";
        let session_dir = write_session_layout(&home, "work-key", session_id);
        let logs_dir = session_dir.join("logs");
        fs::create_dir_all(&logs_dir).expect("create logs dir");
        let log_path = logs_dir.join("kimi-code.log");
        let old_failure = r#"WARN  acp: turn ended with failed reason error="{\"message\":\"old failure\"}"
"#;
        fs::write(&log_path, old_failure).expect("write old log");
        let _lock = set_kimi_code_home(&home);
        let offset = session_log_offset(session_id)
            .expect("log offset")
            .expect("existing log");
        let current_failure = r#"WARN  acp: turn ended with failed reason error="{\"message\":\"current failure\"}"
"#;
        fs::write(&log_path, format!("{old_failure}{current_failure}"))
            .expect("append current failure");

        assert_eq!(
            acp_turn_failure_since(session_id, offset)
                .expect("read current failure")
                .as_deref(),
            Some("current failure")
        );
    }

    #[test]
    fn find_session_dir_by_id_locates_nested_session() {
        let (_guard, home) = temp_home("user");
        let session_id = "abc-123";
        let session_dir = write_session_layout(&home, "deadbeef", session_id);
        let _lock = set_kimi_code_home(&home);
        let found = find_session_dir_by_id(session_id)
            .expect("lookup")
            .expect("found");
        assert_eq!(found, session_dir);
    }

    #[test]
    fn reads_latest_independent_runtime_modes_from_main_wire_log() {
        let (_guard, home) = temp_home("runtime-modes");
        let session_id = "session-runtime-modes";
        let session_dir = write_session_layout(&home, "work-key", session_id);
        let wire_dir = session_dir.join("agents").join("main");
        fs::create_dir_all(&wire_dir).expect("wire dir");
        fs::write(
            wire_dir.join("wire.jsonl"),
            concat!(
                "{\"type\":\"permission.set_mode\",\"mode\":\"manual\"}\n",
                "{\"type\":\"plan_mode.enter\"}\n",
                "not-json\n",
                "{\"type\":\"permission.set_mode\",\"mode\":\"auto\"}\n",
                "{\"type\":\"plan_mode.exit\"}\n",
                "{\"type\":\"plan_mode.enter\"}\n"
            ),
        )
        .expect("write wire log");
        let _lock = set_kimi_code_home(&home);

        assert_eq!(
            persisted_runtime_modes(session_id).expect("read modes"),
            PersistedRuntimeModes {
                plan_mode: Some(true),
                permission_mode: Some("auto".to_string()),
            }
        );
    }

    #[test]
    fn maps_legacy_ask_permission_mode_from_wire_log_to_manual() {
        let (_guard, home) = temp_home("runtime-modes-ask");
        let session_id = "session-runtime-modes-ask";
        let session_dir = write_session_layout(&home, "work-key", session_id);
        let wire_dir = session_dir.join("agents").join("main");
        fs::create_dir_all(&wire_dir).expect("wire dir");
        fs::write(
            wire_dir.join("wire.jsonl"),
            "{\"type\":\"permission.set_mode\",\"mode\":\"ask\"}\n",
        )
        .expect("write wire log");
        let _lock = set_kimi_code_home(&home);

        assert_eq!(
            persisted_runtime_modes(session_id).expect("read modes"),
            PersistedRuntimeModes {
                plan_mode: None,
                permission_mode: Some("manual".to_string()),
            }
        );
    }

    #[test]
    fn missing_runtime_mode_records_leave_global_fallbacks_available() {
        let (_guard, home) = temp_home("runtime-mode-defaults");
        let session_id = "session-without-runtime-modes";
        write_session_layout(&home, "work-key", session_id);
        let _lock = set_kimi_code_home(&home);

        assert_eq!(
            persisted_runtime_modes(session_id).expect("read modes"),
            PersistedRuntimeModes::default()
        );
    }

    #[test]
    fn session_swarm_mode_round_trips_through_desktop_custom_state() {
        let (_guard, home) = temp_home("session-swarm-mode");
        let session_id = "session-swarm-mode";
        let session_dir = write_session_layout(&home, "work-key", session_id);
        fs::write(
            session_dir.join("state.json"),
            r#"{
                "title":"Keep me",
                "custom":{
                    "existing":"value"
                }
            }"#,
        )
        .expect("write state");
        let _lock = set_kimi_code_home(&home);

        assert!(!session_swarm_mode(session_id).expect("read default"));

        update_session_swarm_mode(session_id, true).expect("enable swarm");
        assert!(session_swarm_mode(session_id).expect("read enabled"));

        let enabled: Value =
            serde_json::from_str(&fs::read_to_string(session_dir.join("state.json")).unwrap())
                .unwrap();
        assert_eq!(enabled["title"], "Keep me");
        assert_eq!(enabled["custom"]["existing"], "value");
        assert_eq!(enabled["custom"]["kimi_code_desktop"]["swarm_mode"], true);

        update_session_swarm_mode(session_id, false).expect("disable swarm");
        assert!(!session_swarm_mode(session_id).expect("read disabled"));
    }

    #[test]
    fn update_session_state_patches_title_and_archive() {
        let (_guard, home) = temp_home("user2");
        let session_id = "sess-1";
        let session_dir = write_session_layout(&home, "hash", session_id);
        fs::write(
            session_dir.join("state.json"),
            r#"{"version":1,"archived":false}"#,
        )
        .expect("write state");

        let _lock = set_kimi_code_home(&home);
        update_session_state(session_id, Some("Renamed"), Some(true)).expect("update");

        let updated: Value =
            serde_json::from_str(&fs::read_to_string(session_dir.join("state.json")).unwrap())
                .unwrap();
        assert_eq!(updated["custom_title"], "Renamed");
        assert_eq!(updated["title_generated"], true);
        assert_eq!(updated["archived"], true);
        assert!(updated["archived_at"].is_number());
    }

    #[test]
    fn local_sessions_remain_visible_when_acp_does_not_list_them() {
        let (_guard, home) = temp_home("local-session-list");
        let session_id = "session-local-only";
        let session_dir = write_session_layout(&home, "hash-local", session_id);
        fs::write(
            session_dir.join("state.json"),
            r#"{
                "title":"New Session",
                "custom_title":"Archived draft",
                "workDir":"C:/work/project",
                "updatedAt":"2026-07-19T00:00:00Z",
                "archived":true
            }"#,
        )
        .expect("write state");

        let _lock = set_kimi_code_home(&home);
        let session = read_local_session(session_id).expect("read local session");
        assert_eq!(session["session_id"], session_id);
        assert_eq!(session["title"], "Archived draft");
        assert_eq!(session["work_dir"], "C:/work/project");
        assert_eq!(session["archived"], true);

        let sessions = list_local_sessions().expect("list local sessions");
        assert_eq!(sessions, vec![session]);
    }

    #[test]
    fn replay_session_history_ignores_legacy_wire_records() {
        let (_guard, home) = temp_home("user3");
        let session_id = "sess-replay";
        let session_dir = write_session_layout(&home, "hash2", session_id);
        let wire_path = session_dir.join("agents").join("main");
        fs::create_dir_all(&wire_path).expect("wire dir");
        fs::write(
            wire_path.join("wire.jsonl"),
            concat!(
                r#"{"type":"metadata","message":{}}"#,
                "\n",
                r#"{"type":"wire","message":{"type":"TurnBegin","payload":{"turn":1}}}"#,
                "\n",
                r#"{"type":"wire","message":{"type":"ApprovalRequest","payload":{"id":"req-1"}}}"#,
                "\n",
            ),
        )
        .expect("write wire");

        let _lock = set_kimi_code_home(&home);
        let messages = replay_session_history(session_id).expect("replay");
        assert!(messages.is_empty());
    }

    #[test]
    fn replay_session_history_returns_empty_when_no_wire_file() {
        let (_guard, home) = temp_home("user4");
        let session_id = "sess-empty";
        write_session_layout(&home, "hash3", session_id);
        let _lock = set_kimi_code_home(&home);
        let messages = replay_session_history(session_id).expect("replay");
        assert!(messages.is_empty());
    }

    #[test]
    fn replay_session_history_translates_context_append_messages() {
        let (_guard, home) = temp_home("user-context");
        let session_id = "sess-context";
        let session_dir = write_session_layout(&home, "hash-context", session_id);
        let wire_path = session_dir.join("agents").join("main");
        fs::create_dir_all(&wire_path).expect("wire dir");
        fs::write(
            wire_path.join("wire.jsonl"),
            concat!(
                r#"{"type":"metadata","message":{}}"#,
                "\n",
                r#"{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>hidden</system-reminder>"}],"origin":{"kind":"injection"}}}"#,
                "\n",
                r#"{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"hello"}],"origin":{"kind":"user"}}}"#,
                "\n",
                r#"{"type":"context.append_message","message":{"role":"assistant","content":[{"type":"think","think":"thinking"},{"type":"text","text":"hi there"}],"toolCalls":[{"type":"function","id":"call-1","function":{"name":"ReadFile","arguments":"{\"path\":\"README.md\"}"}}]}}"#,
                "\n",
                r#"{"type":"context.append_message","message":{"role":"tool","toolCallId":"call-1","content":[{"type":"text","text":"file body"}]}}"#,
                "\n",
            ),
        )
        .expect("write wire");

        let _lock = set_kimi_code_home(&home);
        let messages = replay_session_history(session_id).expect("replay");
        let parsed: Vec<Value> = messages
            .iter()
            .map(|message| serde_json::from_str(message).expect("json"))
            .collect();

        assert_eq!(parsed.len(), 6);
        assert_eq!(parsed[0]["params"]["type"], "TurnBegin");
        assert_eq!(parsed[0]["params"]["payload"]["user_input"], "hello");
        assert_eq!(parsed[1]["params"]["type"], "StepBegin");
        assert_eq!(parsed[2]["params"]["type"], "ContentPart");
        assert_eq!(parsed[2]["params"]["payload"]["type"], "think");
        assert_eq!(parsed[3]["params"]["type"], "ContentPart");
        assert_eq!(parsed[3]["params"]["payload"]["text"], "hi there");
        assert_eq!(parsed[4]["params"]["type"], "ToolCall");
        assert_eq!(
            parsed[4]["params"]["payload"]["function"]["name"],
            "ReadFile"
        );
        assert_eq!(parsed[5]["params"]["type"], "ToolResult");
        assert_eq!(parsed[5]["params"]["payload"]["tool_call_id"], "call-1");
    }

    #[test]
    fn replay_session_history_translates_loop_events() {
        let (_guard, home) = temp_home("user-loop");
        let session_id = "sess-loop";
        let session_dir = write_session_layout(&home, "hash-loop", session_id);
        let wire_path = session_dir.join("agents").join("main");
        fs::create_dir_all(&wire_path).expect("wire dir");
        fs::write(
            wire_path.join("wire.jsonl"),
            concat!(
                r#"{"type":"metadata","message":{}}"#,
                "\n",
                r#"{"type":"turn.prompt","turnId":"0","content":[{"type":"text","text":"hello from prompt"}]}"#,
                "\n",
                r#"{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"duplicate user"}],"origin":{"kind":"user"}}}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"step.begin","uuid":"step-1","turnId":"0","step":1}}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"content.part","uuid":"part-1","turnId":"0","step":1,"stepUuid":"step-1","part":{"type":"text","text":"assistant reply"}}}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"tool.call","uuid":"tool-1","turnId":"0","step":1,"stepUuid":"step-1","toolCallId":"tool-1","name":"ReadFile","args":{"path":"README.md"}}}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"tool.result","parentUuid":"tool-1","toolCallId":"tool-1","result":{"output":"file body","display":[{"type":"text","data":"file body"}]}}}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"step.end","uuid":"step-1","turnId":"0","step":1}}"#,
                "\n",
            ),
        )
        .expect("write wire");

        let _lock = set_kimi_code_home(&home);
        let messages = replay_session_history(session_id).expect("replay");
        let parsed: Vec<Value> = messages
            .iter()
            .map(|message| serde_json::from_str(message).expect("json"))
            .collect();

        assert_eq!(parsed.len(), 5);
        assert_eq!(parsed[0]["params"]["type"], "TurnBegin");
        assert_eq!(
            parsed[0]["params"]["payload"]["user_input"],
            "hello from prompt"
        );
        assert_eq!(parsed[1]["params"]["type"], "StepBegin");
        assert_eq!(parsed[1]["params"]["payload"]["n"], 1);
        assert_eq!(parsed[2]["params"]["type"], "ContentPart");
        assert_eq!(parsed[2]["params"]["payload"]["text"], "assistant reply");
        assert_eq!(parsed[3]["params"]["type"], "ToolCall");
        assert_eq!(
            parsed[3]["params"]["payload"]["function"]["name"],
            "ReadFile"
        );
        assert_eq!(
            parsed[3]["params"]["payload"]["function"]["arguments"],
            r#"{"path":"README.md"}"#
        );
        assert_eq!(parsed[4]["params"]["type"], "ToolResult");
        assert_eq!(parsed[4]["params"]["payload"]["tool_call_id"], "tool-1");
        assert_eq!(
            parsed[4]["params"]["payload"]["return_value"]["output"],
            "file body"
        );
    }

    #[test]
    fn replay_uses_origin_instead_of_user_controlled_tags_for_visibility() {
        let (_guard, home) = temp_home("user-origin-visibility");
        let session_id = "sess-origin-visibility";
        let session_dir = write_session_layout(&home, "hash-origin-visibility", session_id);
        let wire_path = session_dir.join("agents").join("main");
        fs::create_dir_all(&wire_path).expect("wire dir");
        fs::write(
            wire_path.join("wire.jsonl"),
            concat!(
                r#"{"type":"turn.prompt","input":[{"type":"text","text":"hidden prompt"}],"origin":{"kind":"injection"}}"#,
                "\n",
                r#"{"type":"turn.steer","input":[{"type":"text","text":"hidden steer"}],"origin":{"kind":"background_task"}}"#,
                "\n",
                r#"{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>literal user text</system-reminder>"}],"origin":{"kind":"user"}}}"#,
                "\n",
            ),
        )
        .expect("write wire");

        let _lock = set_kimi_code_home(&home);
        let messages = replay_session_history(session_id).expect("replay");
        let parsed: Vec<Value> = messages
            .iter()
            .map(|message| serde_json::from_str(message).expect("json"))
            .collect();

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["params"]["type"], "TurnBegin");
        assert_eq!(
            parsed[0]["params"]["payload"]["user_input"],
            "<system-reminder>literal user text</system-reminder>"
        );
    }

    #[test]
    fn replay_session_history_reads_turn_prompt_input_field() {
        let (_guard, home) = temp_home("user-input");
        let session_id = "sess-input";
        let session_dir = write_session_layout(&home, "hash-input", session_id);
        let wire_path = session_dir.join("agents").join("main");
        fs::create_dir_all(&wire_path).expect("wire dir");
        fs::write(
            wire_path.join("wire.jsonl"),
            concat!(
                r#"{"type":"metadata","message":{}}"#,
                "\n",
                r#"{"type":"turn.prompt","input":[{"type":"text","text":"hello from input"}],"origin":{"kind":"user"}}"#,
                "\n",
                r#"{"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"duplicate user"}],"origin":{"kind":"user"}}}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"step.begin","uuid":"step-1","turnId":"0","step":1}}"#,
                "\n",
                r#"{"type":"context.append_loop_event","event":{"type":"content.part","uuid":"part-1","turnId":"0","step":1,"stepUuid":"step-1","part":{"type":"text","text":"assistant reply"}}}"#,
                "\n",
            ),
        )
        .expect("write wire");

        let _lock = set_kimi_code_home(&home);
        let messages = replay_session_history(session_id).expect("replay");
        let parsed: Vec<Value> = messages
            .iter()
            .map(|message| serde_json::from_str(message).expect("json"))
            .collect();

        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0]["params"]["type"], "TurnBegin");
        assert_eq!(
            parsed[0]["params"]["payload"]["user_input"],
            "hello from input"
        );
        assert_eq!(parsed[1]["params"]["type"], "StepBegin");
        assert_eq!(parsed[2]["params"]["payload"]["text"], "assistant reply");
    }

    #[test]
    fn replay_session_history_translates_turn_steer_input() {
        let (_guard, home) = temp_home("user-steer");
        let session_id = "sess-steer";
        let session_dir = write_session_layout(&home, "hash-steer", session_id);
        let wire_path = session_dir.join("agents").join("main");
        fs::create_dir_all(&wire_path).expect("wire dir");
        fs::write(
            wire_path.join("wire.jsonl"),
            concat!(
                r#"{"type":"turn.prompt","input":[{"type":"text","text":"initial request"}]}"#,
                "\n",
                r#"{"type":"turn.steer","input":[{"type":"text","text":"also include tests"}],"origin":{"kind":"user"}}"#,
                "\n",
            ),
        )
        .expect("write wire");

        let _lock = set_kimi_code_home(&home);
        let messages = replay_session_history(session_id).expect("replay");
        let parsed: Vec<Value> = messages
            .iter()
            .map(|message| serde_json::from_str(message).expect("json"))
            .collect();

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1]["params"]["type"], "SteerInput");
        assert_eq!(
            parsed[1]["params"]["payload"]["user_input"],
            "also include tests"
        );
    }

    #[test]
    fn fallback_title_from_wire_uses_turn_prompt_input() {
        let (_guard, home) = temp_home("user-title");
        let session_id = "sess-title";
        let session_dir = write_session_layout(&home, "hash-title", session_id);
        let wire_path = session_dir.join("agents").join("main");
        fs::create_dir_all(&wire_path).expect("wire dir");
        fs::write(
            wire_path.join("wire.jsonl"),
            concat!(
                r#"{"type":"metadata","message":{}}"#,
                "\n",
                r#"{"type":"turn.prompt","input":[{"type":"text","text":"Investigate the ACP bridge"}],"origin":{"kind":"user"}}"#,
                "\n",
            ),
        )
        .expect("write wire");

        let _lock = set_kimi_code_home(&home);
        let title = fallback_title_from_wire(session_id).expect("title");
        assert_eq!(title, "Investigate the ACP bridge");
    }

    #[test]
    fn merge_local_metadata_overrides_title_and_archived() {
        let (_guard, home) = temp_home("user5");
        let session_id = "sess-merge";
        let session_dir = write_session_layout(&home, "hash4", session_id);
        fs::write(
            session_dir.join("state.json"),
            r#"{"version":1,"custom_title":"Local Title","archived":true}"#,
        )
        .expect("write state");

        let _lock = set_kimi_code_home(&home);
        let mut legacy = json!({
            "session_id": session_id,
            "title": "ACP Title",
            "archived": false,
        });
        merge_local_metadata_into_legacy(&mut legacy, session_id);
        assert_eq!(legacy["title"], "Local Title");
        assert_eq!(legacy["archived"], true);
    }

    #[test]
    fn is_method_not_found_detects_json_rpc_code() {
        use crate::acp::JsonRpcError;
        let response = crate::acp::JsonRpcResponse {
            id: Some(1),
            result: None,
            error: Some(JsonRpcError {
                code: Some(json!(-32601)),
                message: Some("Method not found".to_string()),
                data: None,
            }),
            method: None,
        };
        assert!(is_method_not_found(&response));
    }
}
