//! `task.updated` / `subagent.updated` state machines (runtime-v1 -> wire).
//!
//! Split out of `translate.rs` to keep each file under the 600-line module
//! budget. Both mappings are stateful by design: a task is announced via
//! `TaskCreated` exactly once per session, and subagent provenance learned at
//! `spawned` backfills later lifecycle events so the parent link stays
//! stable. Output shapes mirror `the pre-cutover ACP translation module` (the UI contract).

use super::{
    cloned_for_keys, malformed_event_notice, string_for_keys, value_for_keys, wire_event_message,
    SessionTranslateState, SubagentProvenance,
};
use serde_json::{json, Value};

const TERMINAL_TASK_STATUSES: &[&str] = &[
    "completed",
    "success",
    "failed",
    "error",
    "cancelled",
    "canceled",
    "aborted",
];

/// Normalize a `task.updated` payload into the wire `AgentTaskWire` shape
/// (same key set the ACP translator produced).
fn normalize_task(session_id: &str, payload: &Value) -> Option<Value> {
    let id = string_for_keys(payload, &["taskId", "task_id", "id"])?;
    let task_session_id = string_for_keys(payload, &["session_id", "sessionId"])
        .unwrap_or_else(|| session_id.to_string());
    let description = value_for_keys(payload, &["description", "item", "task"])
        .cloned()
        .or_else(|| value_for_keys(payload, &["command"]).cloned())
        .unwrap_or(Value::Null);
    Some(json!({
        "id": id,
        "session_id": task_session_id,
        "kind": cloned_for_keys(payload, &["kind"]),
        "description": description,
        "status": value_for_keys(payload, &["status", "state", "outcome"]).cloned().unwrap_or_else(|| json!("queued")),
        "command": cloned_for_keys(payload, &["command"]),
        "created_at": cloned_for_keys(payload, &["created_at", "createdAt"]),
        "started_at": cloned_for_keys(payload, &["started_at", "startedAt"]),
        "completed_at": cloned_for_keys(payload, &["completed_at", "completedAt"]),
        "output_preview": cloned_for_keys(payload, &["output_preview", "outputPreview"]),
        "output_bytes": cloned_for_keys(payload, &["output_bytes", "outputBytes"]),
        "subagent_phase": cloned_for_keys(payload, &["subagent_phase", "subagentPhase", "phase"]),
        "subagent_type": cloned_for_keys(payload, &["subagent_type", "subagentType"]),
        "parent_tool_call_id": cloned_for_keys(payload, &["parent_tool_call_id", "parentToolCallId"]),
        "parent_agent_id": cloned_for_keys(payload, &["parent_agent_id", "parentAgentId"]),
        "suspended_reason": cloned_for_keys(payload, &["suspended_reason", "suspendedReason", "reason"]),
        "swarm_index": cloned_for_keys(payload, &["swarm_index", "swarmIndex"]),
        "swarm_depth": cloned_for_keys(payload, &["swarm_depth", "swarmDepth"]),
        "run_in_background": cloned_for_keys(payload, &["run_in_background", "runInBackground"]),
        "bound_model": cloned_for_keys(payload, &["bound_model", "boundModel", "model"]),
        "model_preference": cloned_for_keys(payload, &["model_preference", "modelPreference"]),
    }))
}

fn task_created_wire(task: &Value) -> String {
    wire_event_message(
        "TaskCreated",
        json!({
            "session_id": task.get("session_id").cloned().unwrap_or(Value::Null),
            "task": task,
        }),
    )
}

fn task_completed_wire(
    session_id: &str,
    task_id: &str,
    status: &str,
    output_preview: Value,
    payload: &Value,
) -> String {
    wire_event_message(
        "TaskCompleted",
        json!({
            "session_id": session_id,
            "task_id": task_id,
            "status": status,
            "output_preview": output_preview,
            "output_bytes": cloned_for_keys(payload, &["output_bytes", "outputBytes"]),
            "completed_at": cloned_for_keys(payload, &["completed_at", "completedAt"]),
            "error": cloned_for_keys(payload, &["error"]),
        }),
    )
}

pub(super) fn translate_task_updated(
    state: &mut SessionTranslateState,
    session_id: &str,
    payload: &Value,
) -> Vec<String> {
    let Some(task) = normalize_task(session_id, payload) else {
        return vec![malformed_event_notice("task.updated", "taskId")];
    };
    let task_id = task
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let task_session_id = task
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or(session_id)
        .to_string();
    let status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("queued")
        .to_string();
    let first_sighting = state.announced_tasks.insert(task_id.clone());

    if TERMINAL_TASK_STATUSES.contains(&status.as_str()) {
        let mut messages = Vec::new();
        if first_sighting {
            // Terminal-without-start: announce first so the Tasks panel has
            // the full record, then complete it.
            messages.push(task_created_wire(&task));
        }
        messages.push(task_completed_wire(
            &task_session_id,
            &task_id,
            &status,
            cloned_for_keys(
                payload,
                &[
                    "output_preview",
                    "outputPreview",
                    "resultSummary",
                    "summary",
                ],
            ),
            payload,
        ));
        return messages;
    }
    if first_sighting {
        return vec![task_created_wire(&task)];
    }
    vec![wire_event_message(
        "TaskProgress",
        json!({
            "session_id": task_session_id,
            "task_id": task_id,
            "output_chunk": cloned_for_keys(payload, &["output_chunk", "outputChunk", "chunk"]),
            "stream": cloned_for_keys(payload, &["stream"]),
            "phase": value_for_keys(payload, &["phase", "subagent_phase", "subagentPhase"])
                .cloned()
                .unwrap_or_else(|| json!(status)),
        }),
    )]
}

pub(super) fn translate_subagent_updated(
    state: &mut SessionTranslateState,
    session_id: &str,
    payload: &Value,
) -> Vec<String> {
    let Some(agent_id) = string_for_keys(
        payload,
        &["agentId", "agent_id", "subagentId", "subagent_id"],
    ) else {
        return vec![malformed_event_notice("subagent.updated", "agentId")];
    };
    let raw_phase = payload.get("phase").and_then(Value::as_str).unwrap_or("");
    // ACP-phase parity: spawned -> queued, started -> working; unknown phases
    // pass through and degrade in the frontend's status normalization.
    let phase = match raw_phase {
        "spawned" => "queued",
        "started" => "working",
        other => other,
    };

    // Payload provenance wins; fall back to what `spawned` taught us so the
    // parent link stays stable across the lifecycle.
    let learned = state.subagent_provenance.get(&agent_id).cloned();
    let parent_tool_call_id =
        string_for_keys(payload, &["parentToolCallId", "parent_tool_call_id"])
            .or_else(|| learned.as_ref().and_then(|p| p.parent_tool_call_id.clone()));
    let subagent_type = string_for_keys(payload, &["subagentType", "subagent_type"])
        .or_else(|| learned.and_then(|p| p.subagent_type));
    if raw_phase == "spawned" {
        state.subagent_provenance.insert(
            agent_id.clone(),
            SubagentProvenance {
                parent_tool_call_id: parent_tool_call_id.clone(),
                subagent_type: subagent_type.clone(),
            },
        );
    }

    let description = cloned_for_keys(payload, &["description", "item", "task"]);
    let error = if phase == "suspended" {
        cloned_for_keys(payload, &["error", "reason", "suspended_reason"])
    } else {
        cloned_for_keys(payload, &["error"])
    };
    let lifecycle = wire_event_message(
        "SubagentLifecycle",
        json!({
            "session_id": session_id,
            "agent_id": agent_id,
            "task_id": agent_id,
            "parent_tool_call_id": parent_tool_call_id,
            "subagent_type": subagent_type,
            "phase": phase,
            "description": description,
            "swarm_index": cloned_for_keys(payload, &["swarm_index", "swarmIndex"]),
            "parent_agent_id": cloned_for_keys(payload, &["parent_agent_id", "parentAgentId"]),
            "swarm_depth": cloned_for_keys(payload, &["swarm_depth", "swarmDepth"]),
            "error": error,
            "bound_model": cloned_for_keys(payload, &["bound_model", "boundModel", "model"]),
            "model_preference": cloned_for_keys(payload, &["model_preference", "modelPreference"]),
        }),
    );

    match phase {
        "queued" => {
            state.announced_tasks.insert(agent_id.clone());
            let task = json!({
                "id": agent_id,
                "session_id": session_id,
                "kind": "subagent",
                "description": description,
                "status": "queued",
                "command": null,
                "created_at": null,
                "started_at": null,
                "completed_at": null,
                "output_preview": null,
                "output_bytes": null,
                "subagent_phase": "queued",
                "subagent_type": subagent_type,
                "parent_tool_call_id": parent_tool_call_id,
                "suspended_reason": null,
                "swarm_index": cloned_for_keys(payload, &["swarm_index", "swarmIndex"]),
                "parent_agent_id": cloned_for_keys(payload, &["parent_agent_id", "parentAgentId"]),
                "swarm_depth": cloned_for_keys(payload, &["swarm_depth", "swarmDepth"]),
                "run_in_background": cloned_for_keys(payload, &["run_in_background", "runInBackground"]),
                "bound_model": cloned_for_keys(payload, &["bound_model", "boundModel", "model"]),
                "model_preference": cloned_for_keys(payload, &["model_preference", "modelPreference"]),
            });
            vec![task_created_wire(&task), lifecycle]
        }
        "completed" | "failed" | "cancelled" => {
            let output_preview = if phase == "completed" {
                cloned_for_keys(
                    payload,
                    &[
                        "resultSummary",
                        "result_summary",
                        "output_preview",
                        "summary",
                    ],
                )
            } else {
                error.clone()
            };
            vec![
                task_completed_wire(session_id, &agent_id, phase, output_preview, payload),
                lifecycle,
            ]
        }
        _ => vec![lifecycle],
    }
}
