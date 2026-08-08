//! Replay / prompt migration helpers shared by session replay and the wire
//! command family (M4 cutover).
//!
//! These helpers translate between the persisted desktop wire shapes and the
//! prompt / replay contracts (session-config snapshot events, prompt content
//! normalization, swarm/goal compat reminders). The `legacy`/`acp` names
//! describe the persisted wire data shape, not a restored runtime backend.
//!
//! Moved here from the pre-cutover ACP wire-translation / session-bridge
//! modules during the M4 cutover; the runtime translator (`runtime/translate.rs`)
//! is the live path and these are the replay-side migration helpers.

use crate::session_config::{config_option_update_to_wire_payload, SessionConfigState};
use serde_json::{json, Value};

pub(crate) const SWARM_COMPAT_INSTRUCTION: &str = concat!(
    "Swarm mode is enabled for this turn. When the request can be split into two ",
    "or more independent items, use AgentSwarm. AgentSwarm must be the only tool ",
    "call in that model response. If parallel delegation would not help, continue ",
    "normally."
);
pub(crate) const GOAL_CREATE_COMPAT_INSTRUCTION: &str = concat!(
    "The user explicitly requested a new Goal. Before doing other work, call ",
    "CreateGoal with the user's objective and replace=false. Do not merely describe ",
    "the goal. After it is created, work toward it normally."
);
pub(crate) const GOAL_REPLACE_COMPAT_INSTRUCTION: &str = concat!(
    "The user explicitly requested replacing the current Goal. Before doing other ",
    "work, call CreateGoal with the user's objective and replace=true. Do not merely ",
    "describe the replacement."
);
pub(crate) const GOAL_RESUME_COMPAT_INSTRUCTION: &str = concat!(
    "The user explicitly requested resuming the current Goal. Call GetGoal, then call ",
    "UpdateGoal with status=active before continuing the work. Do not create a new ",
    "Goal or stop after merely summarizing the remaining work."
);
pub(crate) const GOAL_MODE_COMPAT_INSTRUCTION: &str = concat!(
    "Goal mode is enabled for this turn. Call GetGoal before expanding scope. If there ",
    "is no current goal, call CreateGoal with the user's request as the objective. If a ",
    "goal exists, use UpdateGoal and GetGoal to stay aligned with it. Do not merely ",
    "describe goal tracking without using the Goal tools."
);

pub(crate) fn desktop_compat_prompt_text(kind: &str, instruction: &str) -> String {
    format!(
        "<system-reminder source=\"kimi-code-desktop\" kind=\"{kind}\">\n{instruction}\n</system-reminder>"
    )
}

fn desktop_compat_prompt_block(kind: &str, instruction: &str) -> Value {
    json!({
        "type": "text",
        "text": desktop_compat_prompt_text(kind, instruction),
    })
}

fn legacy_desktop_compat_prompt_text(instruction: &str) -> String {
    format!("<system-reminder>\n{instruction}\n</system-reminder>")
}

fn is_desktop_compat_prompt_text(text: &str) -> bool {
    [
        ("swarm", SWARM_COMPAT_INSTRUCTION),
        ("goal-create", GOAL_CREATE_COMPAT_INSTRUCTION),
        ("goal-replace", GOAL_REPLACE_COMPAT_INSTRUCTION),
        ("goal-resume", GOAL_RESUME_COMPAT_INSTRUCTION),
        ("goal", GOAL_MODE_COMPAT_INSTRUCTION),
    ]
    .into_iter()
    .any(|(kind, instruction)| {
        text == desktop_compat_prompt_text(kind, instruction)
            || text == legacy_desktop_compat_prompt_text(instruction)
    })
}

fn wire_event_message(event_type: &str, payload: Value) -> String {
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

/// Restore the user-authored content from a prompt that may contain
/// Desktop-only compatibility instructions. The Desktop always appends those
/// instructions as separate trailing text blocks. Requiring both that shape
/// and our stable marker (or an exact legacy value) preserves user-authored
/// system-like tags and arbitrary assistant/tool content.
pub fn user_content_from_acp_prompt(content: &[Value]) -> Vec<Value> {
    let mut visible = content.to_vec();
    while visible.len() > 1
        && visible.last().is_some_and(|part| {
            part.get("type").and_then(Value::as_str) == Some("text")
                && part
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(is_desktop_compat_prompt_text)
        })
    {
        visible.pop();
    }
    visible
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

/// If `user_input` is a slash command (`/compact`, `/mcp`, …), return a
/// **single-block** prompt containing only that command text.
///
/// Kimi Code's adapter (`detectLeadingSlashIntent`) inspects **only**
/// `blocks[0]`. Anything prepended (e.g. `<uploaded_files>` from upload
/// expansion) makes `/compact` fall through to a normal model turn — the
/// exact failure mode of "slash sent as plain text".
pub fn acp_slash_command_prompt(params: &Value) -> Option<Value> {
    let text = slash_command_text_from_user_input(params.get("user_input"))?;
    Some(json!([{ "type": "text", "text": text }]))
}

fn slash_command_text_from_user_input(user_input: Option<&Value>) -> Option<String> {
    match user_input {
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.starts_with('/') {
                Some(trimmed.to_string())
            } else {
                None
            }
        }
        Some(Value::Array(parts)) => parts.iter().find_map(|part| {
            let trimmed = part.get("text")?.as_str()?.trim();
            if trimmed.starts_with('/') {
                Some(trimmed.to_string())
            } else {
                None
            }
        }),
        _ => None,
    }
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

/// The engine has no swarm/goal session mode fields; append model-visible
/// reminders for normal prompts. Never append onto slash commands — slash
/// routing keys off the first text block, and trailing junk also pollutes
/// `/compact` custom instructions.
pub fn legacy_user_input_to_acp_prompt_with_swarm(
    params: &Value,
    swarm_mode: bool,
    goal_mode: bool,
) -> Value {
    if let Some(slash) = acp_slash_command_prompt(params) {
        return slash;
    }
    let mut prompt = legacy_user_input_to_acp_prompt(params);
    let goal_action = params
        .get("goal_action")
        .and_then(Value::as_str)
        .filter(|action| matches!(*action, "create" | "replace" | "resume"));
    if !swarm_mode && !goal_mode && goal_action.is_none() {
        return prompt;
    }

    if let Some(blocks) = prompt.as_array_mut() {
        if swarm_mode {
            blocks.push(desktop_compat_prompt_block(
                "swarm",
                SWARM_COMPAT_INSTRUCTION,
            ));
        }
        let goal_instruction = match goal_action {
            Some("create") => Some(("goal-create", GOAL_CREATE_COMPAT_INSTRUCTION)),
            Some("replace") => Some(("goal-replace", GOAL_REPLACE_COMPAT_INSTRUCTION)),
            Some("resume") => Some(("goal-resume", GOAL_RESUME_COMPAT_INSTRUCTION)),
            _ if goal_mode => Some(("goal", GOAL_MODE_COMPAT_INSTRUCTION)),
            _ => None,
        };
        if let Some((kind, instruction)) = goal_instruction {
            blocks.push(desktop_compat_prompt_block(kind, instruction));
        }
    }
    prompt
}

/// Build a wire event from an already-normalized session config snapshot (replay path).
pub fn translate_session_config_snapshot(session_id: &str, state: &SessionConfigState) -> String {
    wire_event_message(
        "ConfigOptionUpdate",
        config_option_update_to_wire_payload(session_id, state),
    )
}

// ---------------------------------------------------------------------------
// Goal bridge read side (moved from acp.rs; the runtime keeps its own
// journal-driven goal continuation, the classifier is shared with the wire
// prompt path in commands/wire.rs)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalPromptExpectation {
    Start,
    Resume,
    Continue,
}

/// Classify the prompt against the pre-start Goal journal snapshot (the
/// read-side classifier used to decide how to monitor the journal after the
/// turn).
pub fn goal_prompt_expectation(
    params: &Value,
    goal_mode: bool,
    initial_snapshot: &Option<Value>,
) -> Option<GoalPromptExpectation> {
    match params.get("goal_action").and_then(Value::as_str) {
        Some("create" | "replace") => Some(GoalPromptExpectation::Start),
        Some("resume") => Some(GoalPromptExpectation::Resume),

        _ if goal_status(initial_snapshot) == Some("active") => {
            Some(GoalPromptExpectation::Continue)
        }
        _ if goal_mode => Some(GoalPromptExpectation::Start),
        _ => None,
    }
}

pub fn goal_status(snapshot: &Option<Value>) -> Option<&str> {
    snapshot
        .as_ref()
        .and_then(|goal| goal.get("status"))
        .and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_acp_fixture(version: &str, name: &str) -> Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/test-fixtures/acp")
            .join(version)
            .join(name);
        let text = std::fs::read_to_string(&path).expect("fixture readable");
        serde_json::from_str(&text).expect("fixture json")
    }

    #[test]
    fn legacy_prompt_maps_text_blocks() {
        let prompt = legacy_user_input_to_acp_prompt(&json!({ "user_input": "hi" }));
        assert_eq!(prompt[0]["type"], "text");
        assert_eq!(prompt[0]["text"], "hi");
    }

    #[test]
    fn swarm_compat_prompt_preserves_user_block_and_appends_instruction() {
        let prompt = legacy_user_input_to_acp_prompt_with_swarm(
            &json!({ "user_input": "split this" }),
            true,
            false,
        );
        assert_eq!(prompt.as_array().unwrap().len(), 2);
        assert_eq!(prompt[0]["text"], "split this");
        assert!(prompt[1]["text"]
            .as_str()
            .unwrap()
            .contains("Swarm mode is enabled"));
        assert!(prompt[1]["text"]
            .as_str()
            .unwrap()
            .contains("source=\"kimi-code-desktop\" kind=\"swarm\""));
        assert_eq!(
            user_content_from_acp_prompt(prompt.as_array().unwrap()),
            vec![json!({ "type": "text", "text": "split this" })]
        );
    }

    #[test]
    fn goal_compat_prompt_preserves_user_block_and_appends_instruction() {
        let prompt = legacy_user_input_to_acp_prompt_with_swarm(
            &json!({ "user_input": "ship it" }),
            false,
            true,
        );
        assert_eq!(prompt.as_array().unwrap().len(), 2);
        assert_eq!(prompt[0]["text"], "ship it");
        assert!(prompt[1]["text"]
            .as_str()
            .unwrap()
            .contains("Goal mode is enabled"));
    }

    #[test]
    fn visible_prompt_content_removes_all_trailing_desktop_instructions() {
        let prompt = legacy_user_input_to_acp_prompt_with_swarm(
            &json!({
                "user_input": [
                    { "type": "text", "text": "review this" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA==" } }
                ],
                "goal_action": "create"
            }),
            true,
            true,
        );
        let visible = user_content_from_acp_prompt(prompt.as_array().unwrap());
        assert_eq!(visible.len(), 2);
        assert_eq!(visible[0]["text"], "review this");
        assert_eq!(visible[1]["type"], "image");
    }

    #[test]
    fn visible_prompt_content_supports_legacy_blocks_without_hiding_user_tags() {
        let legacy_swarm = legacy_desktop_compat_prompt_text(SWARM_COMPAT_INSTRUCTION);
        let literal = "<system-reminder>literal user text</system-reminder>";
        let content = vec![
            json!({ "type": "text", "text": literal }),
            json!({ "type": "text", "text": legacy_swarm }),
        ];
        assert_eq!(
            user_content_from_acp_prompt(&content),
            vec![json!({ "type": "text", "text": literal })]
        );

        let exact_internal_text_as_the_only_user_block = vec![
            json!({ "type": "text", "text": legacy_desktop_compat_prompt_text(SWARM_COMPAT_INSTRUCTION) }),
        ];
        assert_eq!(
            user_content_from_acp_prompt(&exact_internal_text_as_the_only_user_block),
            exact_internal_text_as_the_only_user_block
        );

        let spoofed_marker = vec![
            json!({ "type": "text", "text": "keep both" }),
            json!({
                "type": "text",
                "text": "<system-reminder source=\"kimi-code-desktop\" kind=\"swarm\">\nuser-authored text\n</system-reminder>"
            }),
        ];
        assert_eq!(
            user_content_from_acp_prompt(&spoofed_marker),
            spoofed_marker
        );
    }

    #[test]
    fn explicit_goal_action_requires_the_matching_native_tool_call() {
        let create = legacy_user_input_to_acp_prompt_with_swarm(
            &json!({ "user_input": "ship it", "goal_action": "create" }),
            false,
            false,
        );
        assert!(create[1]["text"]
            .as_str()
            .unwrap()
            .contains("CreateGoal with the user's objective and replace=false"));

        let resume = legacy_user_input_to_acp_prompt_with_swarm(
            &json!({ "user_input": "Resume the active goal.", "goal_action": "resume" }),
            false,
            false,
        );
        let resume_instruction = resume[1]["text"].as_str().unwrap();
        assert!(resume_instruction.contains("Call GetGoal"));
        assert!(resume_instruction.contains("before continuing the work"));
        assert!(resume_instruction.contains("UpdateGoal with status=active"));
    }

    #[test]
    fn swarm_compat_prompt_skips_slash_commands() {
        let prompt = legacy_user_input_to_acp_prompt_with_swarm(
            &json!({ "user_input": "/compact" }),
            true,
            true,
        );
        assert_eq!(prompt.as_array().unwrap().len(), 1);
        assert_eq!(prompt[0]["text"], "/compact");
    }

    #[test]
    fn slash_command_prompt_strips_prepended_upload_blocks() {
        let prompt = acp_slash_command_prompt(&json!({
            "user_input": [
                { "type": "text", "text": "<uploaded_files>\n1. x\n</uploaded_files>\n\n" },
                { "type": "text", "text": "/compact keep APIs" }
            ]
        }))
        .expect("slash");
        assert_eq!(prompt.as_array().unwrap().len(), 1);
        assert_eq!(prompt[0]["text"], "/compact keep APIs");
    }

    #[test]
    fn translate_session_config_snapshot_emits_config_option_update() {
        let response = load_acp_fixture("v0.31", "session_new.result.json");
        let state =
            crate::session_config::parse_session_config_from_response("sess-031", &response);
        let message = translate_session_config_snapshot("sess-031", &state);
        let parsed: Value = serde_json::from_str(&message).expect("valid wire message");
        assert_eq!(parsed["params"]["type"], "ConfigOptionUpdate");
        assert_eq!(parsed["params"]["payload"]["session_id"], "sess-031");
    }

    #[test]
    fn goal_prompt_expectation_classifies_actions_and_snapshots() {
        let no_goal = None;
        assert_eq!(
            goal_prompt_expectation(&json!({ "goal_action": "create" }), false, &no_goal),
            Some(GoalPromptExpectation::Start)
        );
        assert_eq!(
            goal_prompt_expectation(&json!({ "goal_action": "replace" }), false, &no_goal),
            Some(GoalPromptExpectation::Start)
        );
        assert_eq!(
            goal_prompt_expectation(&json!({ "goal_action": "resume" }), false, &no_goal),
            Some(GoalPromptExpectation::Resume)
        );
        assert_eq!(
            goal_prompt_expectation(&json!({}), true, &no_goal),
            Some(GoalPromptExpectation::Start)
        );
        assert_eq!(goal_prompt_expectation(&json!({}), false, &no_goal), None);
        let active = Some(json!({ "goal_id": "g", "status": "active" }));
        assert_eq!(
            goal_prompt_expectation(&json!({}), false, &active),
            Some(GoalPromptExpectation::Continue)
        );
        let paused = Some(json!({ "goal_id": "g", "status": "paused" }));
        assert_eq!(
            goal_prompt_expectation(&json!({}), true, &paused),
            Some(GoalPromptExpectation::Start)
        );
    }
}
