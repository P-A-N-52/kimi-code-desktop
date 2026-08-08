//! M3 wave-2 fidelity event translations (runtime-v1 -> wire).
//!
//! Split out of `translate.rs` to keep each file under the 600-line module
//! budget. Maps the ten parity session events (`PARITY_SESSION_EVENT_NAMES`
//! in `protocol-parity.ts`) onto the desktop wire shapes of
//! `src/hooks/wireTypes.ts`, with `the pre-cutover ACP translation module` / `session_store.rs` as
//! the behavioral baseline:
//!
//! - `step.begin` -> `StepBegin {n}` (replay shape, session_store.rs:1252);
//! - `step.interrupted` -> `StepInterrupted {}` (empty payload);
//! - `step.retry` -> `StepRetry` with the snake_case field set the frontend
//!   retry formatter reads (`session-stream/runtime.ts`
//!   `formatStepRetryReason` expects provider error class names in
//!   `error_type` and an optional HTTP `status_code`);
//! - `compaction.*` / `mcp.loading.*` -> the four empty-payload indicator
//!   markers (payloads are ignored by the frontend; only begin/end pairing
//!   matters);
//! - `slash_commands.update` -> `SlashCommandsUpdate`, normalizing item
//!   shapes exactly like the ACP-era `available_commands_update` mapping
//!   (the pre-cutover ACP translation module `translate_available_commands_update`);
//! - `background_task.observed` -> `BackgroundTaskObserved` with
//!   `session_id` lifted from the event envelope and the full ACP-era key
//!   set (explicit nulls), plus the synthesized observation the
//!   `tool.completed` mapping emits for the background/cron tool set —
//!   mirroring the pre-cutover ACP translation module
//!   `background_task_observation_from_tool_call_update`, because the pinned
//!   engine exposes no native per-observation event (its task domain
//!   publishes lifecycle `task.*` facts, not tool-call observations);
//! - `turn.steered` -> `SteerInput {user_input}` (replay shape,
//!   session_store.rs `replay_steer_input`); `requestId` is a runtime-side
//!   correlation id and does not cross the wire.
//!
//! Also hosts the completed `session.config` mapping: the M3 wave-1 payload
//! schema lets the runtime carry the full ConfigOptionUpdate option set;
//! when `options` is absent the M1 single-model record is synthesized.

use super::{malformed_event_notice, string_for_keys, value_for_keys, wire_event_message};
use serde_json::{json, Value};

pub(super) fn translate_step_begin(payload: &Value) -> Vec<String> {
    let Some(n) = payload.get("n").and_then(Value::as_u64) else {
        return vec![malformed_event_notice("step.begin", "n")];
    };
    vec![wire_event_message("StepBegin", json!({ "n": n }))]
}

pub(super) fn translate_step_interrupted() -> Vec<String> {
    vec![wire_event_message("StepInterrupted", json!({}))]
}

pub(super) fn translate_step_retry(payload: &Value) -> Vec<String> {
    for field in ["n", "next_attempt", "max_attempts"] {
        if payload.get(field).and_then(Value::as_i64).is_none() {
            return vec![malformed_event_notice("step.retry", field)];
        }
    }
    if payload.get("wait_s").and_then(Value::as_f64).is_none() {
        return vec![malformed_event_notice("step.retry", "wait_s")];
    }
    let Some(error_type) = string_for_keys(payload, &["error_type", "errorType"]) else {
        return vec![malformed_event_notice("step.retry", "error_type")];
    };
    vec![wire_event_message(
        "StepRetry",
        json!({
            "n": payload["n"],
            "next_attempt": payload["next_attempt"],
            "max_attempts": payload["max_attempts"],
            "wait_s": payload["wait_s"],
            "error_type": error_type,
            // Optional on the wire; an explicit null keeps the ACP-era
            // nulls-pass-through convention.
            "status_code": value_for_keys(payload, &["status_code", "statusCode"])
                .cloned()
                .unwrap_or(Value::Null),
        }),
    )]
}

/// The four indicator markers carry empty wire payloads (`Record<string,
/// never>` in wireTypes.ts); the frontend only pairs begin with end.
pub(super) fn translate_marker_event(wire_type: &str) -> Vec<String> {
    vec![wire_event_message(wire_type, json!({}))]
}

pub(super) fn translate_turn_steered(payload: &Value) -> Vec<String> {
    let Some(input) = payload
        .get("input")
        .filter(|input| input.is_string() || input.is_array())
    else {
        return vec![malformed_event_notice("turn.steered", "input")];
    };
    vec![wire_event_message(
        "SteerInput",
        json!({ "user_input": input }),
    )]
}

// ---------------------------------------------------------------------------
// slash_commands.update -> SlashCommandsUpdate
// ---------------------------------------------------------------------------

pub(super) fn translate_slash_commands_update(payload: &Value) -> Vec<String> {
    let commands = payload
        .get("slash_commands")
        .or_else(|| payload.get("slashCommands"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let slash_commands = commands
        .iter()
        .enumerate()
        .map(|(index, command)| slash_command_item_wire(command, index))
        .collect::<Vec<_>>();
    vec![wire_event_message(
        "SlashCommandsUpdate",
        json!({ "slash_commands": slash_commands }),
    )]
}

/// One slash-command item, normalized like the ACP-era
/// `translate_available_commands_update` (the pre-cutover ACP translation module): plain string
/// entries tolerated, `command` accepted as the name key, `input.hint`
/// unwrapped, `source` honored when the runtime sends it and inferred
/// otherwise.
fn slash_command_item_wire(command: &Value, index: usize) -> Value {
    if let Some(name) = command
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return json!({
            "name": name,
            "description": "",
            "aliases": [],
            "input_hint": Value::Null,
            "source": infer_slash_command_source(name),
        });
    }

    let name = string_for_keys(command, &["name", "command"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("unknown-{index}"));
    let description = string_for_keys(command, &["description"]).unwrap_or_default();
    let input_hint = string_for_keys(command, &["input_hint", "inputHint"]).or_else(|| {
        command
            .get("input")
            .and_then(|input| input.get("hint"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
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

    json!({
        "name": name,
        "description": description,
        "aliases": aliases,
        "input_hint": input_hint,
        "source": string_for_keys(command, &["source"])
            .unwrap_or_else(|| infer_slash_command_source(&name)),
    })
}

/// Mirror of the ACP-era `infer_slash_command_source` (the pre-cutover ACP translation module) —
/// the frontend's session-influence heuristics read exactly this vocabulary.
fn infer_slash_command_source(name: &str) -> String {
    if name.starts_with("skill:") {
        return "runtime:skill".to_string();
    }
    if let Some((prefix, _)) = name.split_once(':') {
        if !prefix.is_empty()
            && prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return format!("runtime:plugin:{prefix}");
        }
    }
    if name.contains('.') {
        return "runtime:plugin".to_string();
    }
    "runtime".to_string()
}

// ---------------------------------------------------------------------------
// background_task.observed -> BackgroundTaskObserved
// ---------------------------------------------------------------------------

/// Tool titles whose results reveal background-task or cron state; mirrors
/// the ACP-era `background_task_tool_names` (the pre-cutover ACP translation module).
const BACKGROUND_TASK_TOOL_NAMES: &[&str] = &[
    "TaskList",
    "TaskOutput",
    "TaskStop",
    "CronCreate",
    "CronList",
    "CronDelete",
];

fn is_background_task_tool_title(title: &str) -> bool {
    let normalized = title.trim();
    BACKGROUND_TASK_TOOL_NAMES
        .iter()
        .any(|name| normalized.eq_ignore_ascii_case(name))
}

/// Native `background_task.observed` event: pass the observation through with
/// `session_id` lifted from the event envelope and the full ACP-era key set
/// (explicit nulls — the frontend's `observed*FromWirePayload` readers
/// tolerate both absent and null, and the ACP translator emitted nulls).
pub(super) fn translate_background_task_observed(session_id: &str, payload: &Value) -> Vec<String> {
    let Some(tool_call_id) = string_for_keys(payload, &["tool_call_id", "toolCallId"]) else {
        return vec![malformed_event_notice(
            "background_task.observed",
            "tool_call_id",
        )];
    };
    let Some(tool_name) = string_for_keys(payload, &["tool_name", "toolName"]) else {
        return vec![malformed_event_notice(
            "background_task.observed",
            "tool_name",
        )];
    };
    vec![wire_event_message(
        "BackgroundTaskObserved",
        background_task_observed_payload(
            session_id,
            &tool_call_id,
            &tool_name,
            &string_for_keys(payload, &["snapshot"]).unwrap_or_default(),
            payload
                .get("terminal_state")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            payload,
        ),
    )]
}

/// The full-key BackgroundTaskObserved wire payload (ACP parity:
/// the pre-cutover ACP translation module `background_task_observation_from_tool_call_update`).
/// `extras` carries the optional fields when a caller already parsed them.
fn background_task_observed_payload(
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    snapshot: &str,
    terminal_state: &str,
    extras: &Value,
) -> Value {
    let terminal_state = match terminal_state {
        "running" | "completed" | "failed" | "stopped" => terminal_state,
        _ => "unknown",
    };
    json!({
        "session_id": session_id,
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "task_id": value_for_keys(extras, &["task_id", "taskId"]).cloned(),
        "snapshot": snapshot,
        "terminal_state": terminal_state,
        "output_path": value_for_keys(extras, &["output_path", "outputPath"]).cloned(),
        "cron_id": extras.get("cron_id").cloned(),
        "cron_expression": extras.get("cron_expression").cloned(),
        "human_schedule": extras.get("human_schedule").cloned(),
        "next_fire_at": extras.get("next_fire_at").cloned(),
        "recurring": extras.get("recurring").cloned(),
    })
}

/// Synthesize a `BackgroundTaskObserved` wire line from a terminal
/// `tool.completed` for the background/cron observation tool set, mirroring
/// the ACP-era tool_call_update heuristic (the pre-cutover ACP translation module:1173-1207). The
/// pinned engine has no native per-observation event, so — exactly like the
/// ACP era — the observation is derived from the tool result text. Returns
/// None for non-observation tools. runtime-v1 `tool.completed` is terminal
/// only, so `running` never appears here (the ACP era derived it from
/// in_progress tool_call updates, which have no runtime-v1 counterpart).
pub(super) fn background_task_observation_from_tool_completed(
    session_id: &str,
    tool_call_id: &str,
    tool_name: Option<&str>,
    is_error: bool,
    snapshot: &str,
) -> Option<String> {
    let title = tool_name?;
    if !is_background_task_tool_title(title) {
        return None;
    }
    let terminal_state = if is_error { "failed" } else { "completed" };
    let task_id = extract_task_id_from_text(snapshot).unwrap_or_else(|| tool_call_id.to_string());
    let output_path = extract_output_path_from_text(snapshot);
    let (cron_id, human_schedule, next_fire_at, recurring) = parse_cron_fields(snapshot);
    Some(wire_event_message(
        "BackgroundTaskObserved",
        json!({
            "session_id": session_id,
            "tool_call_id": tool_call_id,
            "tool_name": title,
            "task_id": task_id,
            "snapshot": snapshot,
            "terminal_state": terminal_state,
            "output_path": output_path,
            "cron_id": cron_id,
            "human_schedule": human_schedule,
            "next_fire_at": next_fire_at,
            "recurring": recurring,
        }),
    ))
}

// Text heuristics below mirror the ACP-era extraction helpers in
// the pre-cutover ACP translation module (extract_task_id_from_text / extract_output_path_from_text
// / extract_field_value / parse_cron_fields) — the wire consumer
// (`src/lib/background-tasks/normalize.ts`) was built against exactly these.

fn extract_task_id_from_text(text: &str) -> Option<String> {
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("task_id") || lower.contains("task id") {
            if let Some(value) = extract_field_value(line) {
                return Some(value);
            }
        }
        if lower.contains("output written to") {
            if let Some(path) = line.split_whitespace().last() {
                if let Some(stem) = path.rsplit('/').next() {
                    if let Some(id) = stem.strip_suffix(".txt") {
                        if !id.is_empty() {
                            return Some(id.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn extract_output_path_from_text(text: &str) -> Option<String> {
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("output_path") || lower.contains("output path") {
            if let Some(value) = extract_field_value(line) {
                return Some(value);
            }
        }
        if lower.contains("output written to") {
            if let Some(index) = lower.find("output written to") {
                let tail = line[index + "output written to".len()..].trim();
                if !tail.is_empty() {
                    return Some(tail.to_string());
                }
            }
        }
        if line.contains(".kimi/tasks/") {
            if let Some(index) = line.find(".kimi/tasks/") {
                let tail = line[index..].split_whitespace().next()?.trim();
                return Some(tail.to_string());
            }
        }
    }
    None
}

fn extract_field_value(line: &str) -> Option<String> {
    let (_, rhs) = line.split_once(':').or_else(|| line.split_once('='))?;
    let value = rhs.trim().trim_matches('"').trim_matches('\'');
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn parse_cron_fields(text: &str) -> (Option<String>, Option<String>, Option<String>, Option<bool>) {
    let mut cron_id = None;
    let mut human_schedule = None;
    let mut next_fire_at = None;
    let mut recurring = None;
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("id:") || lower.starts_with("id=") {
            cron_id = extract_field_value(line);
        } else if lower.contains("humanschedule") || lower.contains("human schedule") {
            human_schedule = extract_field_value(line);
        } else if lower.contains("nextfireat") || lower.contains("next fire") {
            next_fire_at = extract_field_value(line);
        } else if lower.contains("recurring") {
            if let Some(value) = extract_field_value(line) {
                recurring = Some(value.eq_ignore_ascii_case("true"));
            }
        }
    }
    (cron_id, human_schedule, next_fire_at, recurring)
}

// ---------------------------------------------------------------------------
// session.config -> ConfigOptionUpdate (wave-1 options array completed)
// ---------------------------------------------------------------------------

pub(super) fn translate_session_config(session_id: &str, payload: &Value) -> Vec<String> {
    // The wave-1 payload schema carries the full option set; each record maps
    // onto the ACP-serialized SessionConfigOption shape (camelCase).
    if let Some(options) = payload.get("options").and_then(Value::as_array) {
        let mapped = options
            .iter()
            .filter_map(|option| {
                let id = string_for_keys(option, &["id"])?;
                Some(json!({
                    "id": id,
                    "optionType": string_for_keys(option, &["optionType", "type"])
                        .unwrap_or_else(|| "unknown".to_string()),
                    "label": value_for_keys(option, &["label"]).cloned(),
                    "currentValue": value_for_keys(option, &["currentValue", "current_value"]).cloned(),
                    "options": value_for_keys(option, &["options"]).cloned(),
                }))
            })
            .collect::<Vec<_>>();
        return vec![wire_event_message(
            "ConfigOptionUpdate",
            json!({
                "session_id": session_id,
                "status": "known",
                "options": mapped,
            }),
        )];
    }
    // M1 minimal form: `model` only — synthesize the single-record option
    // set exactly as before.
    vec![wire_event_message(
        "ConfigOptionUpdate",
        json!({
            "session_id": session_id,
            "status": "known",
            "options": [{
                "id": "model",
                "optionType": "unknown",
                "label": Value::Null,
                "currentValue": value_for_keys(payload, &["model"]).cloned().unwrap_or(Value::Null),
                "options": Value::Null,
            }],
        }),
    )]
}
