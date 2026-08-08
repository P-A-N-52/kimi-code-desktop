//! Wire-family Tauri commands over the source runtime (M4 wave 1, W1-A).
//!
//! Replaces the pre-cutover adapters that talked to an external installed
//! CLI. The five commands keep their frontend contract
//! (`src/lib/tauri-api.ts`) while moving onto the [`RuntimeHost`]:
//!
//! - `wire_connect` / `wire_disconnect` lease a session on the host (ACP
//!   `connect_leased` / `disconnect_leased` parity, verbatim semantics);
//! - `wire_send` dispatches the frontend JSON-RPC messages — initialize /
//!   replay / prompt / cancel / the mode family / `set_config_option` /
//!   result answers — onto the typed [`RuntimeClient`] with ACP-shaped wire
//!   replies;
//! - `wire_status` / `wire_list_workers` project the host session table.
//!
//! Threading follows `commands/auth.rs`: every command is `async` and runs its
//! body in `spawn_blocking`; the [`RuntimeHost`] state is fetched inside the
//! closure via the app handle (`State` is not `'static` and cannot move).
//! Wire lines synthesized by the command side (initialize reply, mode
//! StatusUpdates, config updates, replay/cancel replies) are emitted directly
//! through `wire_events::emit_wire_message`; runtime-originated lines keep
//! flowing through the host pump, the single emit point for engine events.
//!
//! Behavior parity baseline is `src-tauri/src/acp.rs` (per-wire-method
//! semantics and error texts) with the runtime-v1 shapes pinned by
//! `src/hooks/wireTypes.ts` and
//! `runtime/kimi-code/apps/desktop-runtime/src/protocol*.ts`.
//!
//! ## Request id flow
//!
//! The frontend terminates a prompt only by id, so the wire `prompt` message
//! `id` IS the `turn.start` request id (never minted host-side). The wire
//! `cancel` message carries its own id: the cancel reply echoes that id while
//! the cancelled prompt terminal (`turn.failed` with code `cancelled`) flows
//! from the runtime through the pump under the prompt's own request id — the
//! two ids never mix. Approval/question answers echo the request id of the
//! `ApprovalRequest` / `QuestionRequest` line the pump emitted, which the host
//! resolves against its pending tables.

use crate::global_config;
use crate::goal_store;
use crate::runtime::client::{
    ApprovalDecision, ApprovalRespondParams, ApprovalScope, ContentPart, MediaRef, PromptInput,
    QuestionRespondParams, QuestionResult, RuntimeClient, SessionPermissionMode,
    SessionReplayParams, SessionSetModeParams, SessionSetModeResult, SessionsUpdateParams,
    TurnStartParams,
};
use crate::runtime::host::RuntimeHost;
use crate::session_compat::{
    desktop_compat_prompt_text, goal_prompt_expectation, GOAL_CREATE_COMPAT_INSTRUCTION,
    GOAL_MODE_COMPAT_INSTRUCTION, GOAL_REPLACE_COMPAT_INSTRUCTION, GOAL_RESUME_COMPAT_INSTRUCTION,
    SWARM_COMPAT_INSTRUCTION,
};
use crate::session_files;
use crate::session_store;
use crate::session_store::SessionUsageSnapshot;
use crate::wire_events::{emit_wire_message, RuntimeStatus, WorkerStatusView};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Bounded runtime call budget for wire RPCs, matching the host `CALL_TIMEOUT`
/// (open/close/turns/responds) and `commands/auth.rs`.
const WIRE_CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Quiet period before the replay reply, standing in for the ACP-era
/// `wait_for_session_update_quiescence`: the runtime emits the whole replay
/// burst before answering `session.replay`, but the host pump may still be
/// translating the tail frames when the response resolves. Waiting keeps the
/// command-side reply from overtaking the burst.
const REPLAY_QUIESCENCE: Duration = Duration::from_millis(150);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn wire_connect(
    app: tauri::AppHandle,
    session_id: String,
    connection_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        host.connect_leased(&session_id, &connection_id)
    })
    .await
    .map_err(|e| format!("Failed to join wire_connect: {e}"))?
}

#[tauri::command]
pub async fn wire_disconnect(
    app: tauri::AppHandle,
    session_id: String,
    connection_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        host.disconnect_leased(&session_id, &connection_id)
    })
    .await
    .map_err(|e| format!("Failed to join wire_disconnect: {e}"))?
}

#[tauri::command]
pub async fn wire_send(
    app: tauri::AppHandle,
    session_id: String,
    message: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let parsed: Value =
            serde_json::from_str(&message).map_err(|e| format!("Invalid JSON-RPC message: {e}"))?;
        let method = parsed.get("method").and_then(Value::as_str);
        let id = parsed.get("id").cloned();
        match method {
            Some("initialize") => handle_initialize(&app, &host, &session_id, id),
            Some("replay") => handle_replay(&app, &host, &session_id, id),
            Some("prompt") => handle_prompt(
                &host,
                &session_id,
                id,
                parsed.get("params").cloned().unwrap_or(Value::Null),
            ),
            Some("cancel") => handle_cancel(&app, &host, &session_id, id),
            Some("set_plan_mode") => handle_set_plan_mode(
                &app,
                &host,
                &session_id,
                id,
                parsed.get("params").cloned().unwrap_or(Value::Null),
            ),
            Some("set_permission_mode") => handle_set_permission_mode(
                &app,
                &host,
                &session_id,
                id,
                parsed.get("params").cloned().unwrap_or(Value::Null),
            ),
            Some("set_swarm_mode") => handle_set_swarm_mode(
                &app,
                &host,
                &session_id,
                id,
                parsed.get("params").cloned().unwrap_or(Value::Null),
            ),
            Some("set_goal_mode") => handle_set_goal_mode(
                &app,
                &host,
                &session_id,
                id,
                parsed.get("params").cloned().unwrap_or(Value::Null),
            ),
            Some("set_config_option") => handle_set_config_option(
                &app,
                &host,
                &session_id,
                id,
                parsed.get("params").cloned().unwrap_or(Value::Null),
            ),
            None if parsed.get("result").is_some() => {
                handle_permission_response(&host, &session_id, id, parsed.get("result"))
            }
            _ => Ok(()),
        }
    })
    .await
    .map_err(|e| format!("Failed to join wire_send: {e}"))?
}

#[tauri::command]
pub async fn wire_status(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Option<RuntimeStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        Ok(host.session_status(&session_id))
    })
    .await
    .map_err(|e| format!("Failed to join wire_status: {e}"))?
}

#[tauri::command]
pub async fn wire_list_workers(app: tauri::AppHandle) -> Result<Vec<WorkerStatusView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        Ok(host.list_workers())
    })
    .await
    .map_err(|e| format!("Failed to join wire_list_workers: {e}"))?
}

// ---------------------------------------------------------------------------
// wire_send handlers
// ---------------------------------------------------------------------------

/// `initialize` — local reply plus the mode/usage/config state refreshes,
/// verbatim acp.rs `initialize` (acp.rs:939-955). The runtime has no slash
/// command catalog, so the desktop keeps its cached command set. The ACP-era
/// `session_status` idle/initialized line is not emitted: the host projects
/// the connected status and the pump emits engine `session.status` events.
fn handle_initialize(
    app: &AppHandle,
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
) -> Result<(), String> {
    emit_wire_message(
        app,
        session_id,
        json!({ "jsonrpc": "2.0", "id": id, "result": { "slash_commands": [] } }).to_string(),
    );
    emit_wire_message(
        app,
        session_id,
        wire_event_message("StatusUpdate", modes_for(session_id).payload()),
    );
    if let Some(usage) = usage_status_payload(session_id) {
        emit_wire_message(app, session_id, wire_event_message("StatusUpdate", usage));
    }
    if let Some(snapshot) = host.session_config_snapshot(session_id) {
        emit_wire_message(
            app,
            session_id,
            session_config_snapshot_wire(session_id, &snapshot),
        );
    }
    Ok(())
}

/// `replay` — stream the session history through `session.replay` (the burst
/// frames reach the pump and are translated as ordinary session events), then
/// close the burst with the ACP-shaped reply (`{status:"finished"}`).
fn handle_replay(
    app: &AppHandle,
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
) -> Result<(), String> {
    let supervisor = host.ensure_started()?;
    let client = RuntimeClient::new(&supervisor);
    let result = client
        .session_replay(
            &SessionReplayParams {
                session_id: session_id.to_string(),
                from_seq: None,
                limit: None,
            },
            WIRE_CALL_TIMEOUT,
        )
        .map_err(|err| format!("runtime session.replay failed: {err}"))?;
    if result.events > 0 {
        std::thread::sleep(REPLAY_QUIESCENCE);
    }
    if let Some(id) = id {
        emit_wire_message(
            app,
            session_id,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "status": "finished", "events": result.events, "requests": 0 },
            })
            .to_string(),
        );
    }
    Ok(())
}

/// `prompt` — start a turn on the runtime.
///
/// The wire prompt message `id` IS the turn request id (hard constraint: the
/// frontend terminates only the prompt whose id matches, so the id is never
/// minted here). The chain mirrors acp.rs `handle_prompt` up to `turn.start`:
/// upload expansion, the Goal bridge read side, then `host.start_turn` (busy
/// gate built into the host with the ACP-verbatim message).
fn handle_prompt(
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let prompt_id = wire_id_to_string(id.as_ref())
        .ok_or_else(|| "prompt message requires an id".to_string())?;
    let expanded = session_files::expand_prompt_with_uploads(session_id, &params)?;
    let modes = modes_for(session_id);
    let goal_requested = modes.goal_mode
        || expanded
            .get("goal_action")
            .and_then(Value::as_str)
            .is_some_and(|action| matches!(action, "create" | "replace" | "resume"));
    // Goal bridge read side (retained from acp.rs `handle_prompt`): capture
    // the journal baseline and the Goal expectation before `turn.start`. In
    // runtime-v1 the engine owns the whole goal lifecycle inside the turn and
    // the terminal arrives via the host pump, so the ACP-era post-start
    // journal polling is not replicated here; the baseline keeps the desktop
    // goal journal observable for M5 acceptance.
    if goal_requested {
        let cursor = goal_store::GoalJournalCursor::open(session_id).map_err(|err| {
            eprintln!("[wire] failed to open Goal journal for {session_id}: {err}");
            err
        })?;
        let initial_snapshot = cursor.snapshot();
        let _baseline_record = cursor.record_index();
        let _expectation =
            goal_prompt_expectation(&expanded, modes.goal_mode, &initial_snapshot)
                .ok_or_else(|| "Missing native Goal action for Goal prompt.".to_string())?;
        // `upcoming_goal_id` feeds the goal_queue consume after a Goal is
        // created in the ACP bridge; retained here for the M5 journal hook.
        let _upcoming_goal_id = expanded
            .get("upcoming_goal_id")
            .and_then(Value::as_str)
            .filter(|goal_id| !goal_id.trim().is_empty())
            .map(str::to_string);
    }
    let input = build_turn_input(&expanded, modes.swarm_mode, modes.goal_mode)?;
    host.start_turn(TurnStartParams {
        session_id: session_id.to_string(),
        request_id: prompt_id,
        input,
        model: None,
        plan_mode: Some(modes.plan_mode),
    })
    .map(|_| ())
}

/// `cancel` — cancel every in-flight turn (the frontend cancel message carries
/// no request id). The cancel reply echoes the cancel message id; the
/// cancelled prompt terminal (`turn.failed` with code `cancelled`) flows from
/// the runtime through the pump under the prompt's own request id.
fn handle_cancel(
    app: &AppHandle,
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
) -> Result<(), String> {
    host.cancel_turn(session_id, None)?;
    if let Some(id) = id {
        emit_wire_message(
            app,
            session_id,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "status": "cancelled" },
            })
            .to_string(),
        );
    }
    Ok(())
}

/// `set_plan_mode` — engine plan mode via `session.setMode` (the engine
/// handler is idempotent and idle-gated), local in-memory state, and the mode
/// StatusUpdate with the engine readback merged into the payload.
fn handle_set_plan_mode(
    app: &AppHandle,
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let enabled = mode_enabled_from_params(&params)?;
    ensure_mode_change_idle(host, session_id)?;
    let supervisor = host.ensure_started()?;
    let client = RuntimeClient::new(&supervisor);
    let result = client
        .session_set_mode(
            &SessionSetModeParams::Plan {
                session_id: session_id.to_string(),
                enabled,
            },
            WIRE_CALL_TIMEOUT,
        )
        .map_err(|err| format!("runtime session.setMode failed: {err}"))?;
    let mut modes = modes_for(session_id);
    modes.plan_mode = result.plan_mode.unwrap_or(enabled);
    set_modes(session_id, modes);
    emit_mode_response(app, session_id, id);
    emit_wire_message(
        app,
        session_id,
        wire_event_message(
            "StatusUpdate",
            mode_status_payload_with_result(&modes, &result),
        ),
    );
    Ok(())
}

/// `set_permission_mode` — engine permission mode via `session.setMode`. No
/// idle gate: permission hot-switches mid-turn (issue #13 parity), and the
/// engine applies it to subsequent permission checks immediately.
fn handle_set_permission_mode(
    app: &AppHandle,
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let next = permission_mode_from_params(&params)?;
    let supervisor = host.ensure_started()?;
    let client = RuntimeClient::new(&supervisor);
    let result = client
        .session_set_mode(
            &SessionSetModeParams::Permission {
                session_id: session_id.to_string(),
                permission_mode: next,
            },
            WIRE_CALL_TIMEOUT,
        )
        .map_err(|err| format!("runtime session.setMode failed: {err}"))?;
    let mut modes = modes_for(session_id);
    modes.permission_mode = next;
    set_modes(session_id, modes);
    emit_mode_response(app, session_id, id);
    emit_wire_message(
        app,
        session_id,
        wire_event_message(
            "StatusUpdate",
            mode_status_payload_with_result(&modes, &result),
        ),
    );
    Ok(())
}

/// `set_swarm_mode` — pure desktop state (no engine RPC, ACP parity):
/// persisted in the Kimi session state and reflected in the mode StatusUpdate.
fn handle_set_swarm_mode(
    app: &AppHandle,
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let enabled = mode_enabled_from_params(&params)?;
    ensure_mode_change_idle(host, session_id)?;
    session_store::update_session_swarm_mode(session_id, enabled)?;
    let mut modes = modes_for(session_id);
    modes.swarm_mode = enabled;
    set_modes(session_id, modes);
    emit_mode_response(app, session_id, id);
    emit_wire_message(
        app,
        session_id,
        wire_event_message("StatusUpdate", modes.payload()),
    );
    Ok(())
}

/// `set_goal_mode` — pure desktop state (no engine RPC, ACP parity): persisted
/// in the Kimi session state and reflected in the mode StatusUpdate.
fn handle_set_goal_mode(
    app: &AppHandle,
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let enabled = mode_enabled_from_params(&params)?;
    ensure_mode_change_idle(host, session_id)?;
    session_store::update_session_goal_mode(session_id, enabled)?;
    let mut modes = modes_for(session_id);
    modes.goal_mode = enabled;
    set_modes(session_id, modes);
    emit_mode_response(app, session_id, id);
    emit_wire_message(
        app,
        session_id,
        wire_event_message("StatusUpdate", modes.payload()),
    );
    Ok(())
}

/// `set_config_option` — the only runtime-writable config id is `model`, which
/// maps onto `sessions.update`. Any other id answers the ACP-shaped error line
/// (acp.rs `emit_config_option_error`); the success reply keeps the
/// `{status:"ok"}` shape (acp.rs:2126-2138).
fn handle_set_config_option(
    app: &AppHandle,
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
    params: Value,
) -> Result<(), String> {
    let config_id = params
        .get("configId")
        .or_else(|| params.get("config_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(config_id) = config_id else {
        emit_config_option_error(app, session_id, id, "Missing configId");
        return Ok(());
    };
    let Some(value) = params.get("value").cloned() else {
        emit_config_option_error(app, session_id, id, "Missing value");
        return Ok(());
    };
    if config_id != "model" {
        emit_config_option_error(
            app,
            session_id,
            id,
            &format!("Config option `{config_id}` is not declared for this session"),
        );
        return Ok(());
    }
    let Some(model) = value
        .as_str()
        .map(str::trim)
        .filter(|model| !model.is_empty())
    else {
        emit_config_option_error(
            app,
            session_id,
            id,
            "Config option `model` requires a string value",
        );
        return Ok(());
    };
    if !host.in_flight_turns(session_id).is_empty() {
        emit_config_option_error(
            app,
            session_id,
            id,
            "Session is busy; wait for completion before changing modes.",
        );
        return Ok(());
    }
    let supervisor = host.ensure_started()?;
    let client = RuntimeClient::new(&supervisor);
    if let Err(err) = client.sessions_update(
        &SessionsUpdateParams {
            session_id: session_id.to_string(),
            model: Some(model.to_string()),
            cwd: None,
        },
        WIRE_CALL_TIMEOUT,
    ) {
        emit_config_option_error(
            app,
            session_id,
            id,
            &format!("runtime sessions.update failed: {err}"),
        );
        return Ok(());
    }
    // Model applied: merge into the host config snapshot cache and surface the
    // option state. The engine re-emits `session.config` after setModel, which
    // refreshes the host snapshot through the pump; this emit is the immediate
    // command-side feedback (same ConfigOptionUpdate shape).
    let snapshot = host
        .session_config_snapshot(session_id)
        .map(|snapshot| config_snapshot_with_model(&snapshot, model))
        .unwrap_or_else(|| json!({ "model": model }));
    emit_wire_message(
        app,
        session_id,
        session_config_snapshot_wire(session_id, &snapshot),
    );
    if let Some(id) = id {
        emit_wire_message(
            app,
            session_id,
            json!({ "jsonrpc": "2.0", "id": id, "result": { "status": "ok" } }).to_string(),
        );
    }
    Ok(())
}

/// Result answers: question responses (result carries `answers`) go to
/// `host.respond_question`; approval decisions map onto the runtime vocabulary
/// (`approve` -> `approved`, `approve_for_session` -> `approved` + session
/// scope, `reject` -> `rejected` + optional feedback) and go to
/// `host.respond_approval`, which echoes the `ApprovalRequestResolved` line.
fn handle_permission_response(
    host: &RuntimeHost,
    session_id: &str,
    id: Option<Value>,
    result: Option<&Value>,
) -> Result<(), String> {
    let wire_id = wire_id_to_string(id.as_ref()).unwrap_or_default();
    let Some(result) = result else {
        return Ok(());
    };
    if result.get("answers").is_some() {
        let mut answers = Map::new();
        if let Some(record) = result.get("answers").and_then(Value::as_object) {
            for (key, value) in record {
                answers.insert(key.clone(), value.clone());
            }
        }
        host.respond_question(QuestionRespondParams {
            session_id: session_id.to_string(),
            question_id: wire_id,
            result: QuestionResult::Answers(answers),
        })?;
        return Ok(());
    }
    let response = result
        .get("response")
        .and_then(Value::as_str)
        .unwrap_or("reject");
    let (decision, scope, feedback): (ApprovalDecision, Option<ApprovalScope>, Option<String>) =
        match response {
            "approve" => (ApprovalDecision::Approved, None, None),
            "approve_for_session" => (
                ApprovalDecision::Approved,
                Some(ApprovalScope::Session),
                None,
            ),
            "reject" => {
                let feedback = result
                    .get("feedback")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .filter(|text| !text.trim().is_empty());
                (ApprovalDecision::Rejected, None, feedback)
            }
            _ => (ApprovalDecision::Rejected, None, None),
        };
    host.respond_approval(ApprovalRespondParams {
        session_id: session_id.to_string(),
        approval_id: wire_id,
        decision,
        scope,
        feedback,
        selected_label: None,
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Wire line helpers (shapes pinned by acp.rs / `src/hooks/wireTypes.ts`)
// ---------------------------------------------------------------------------

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

/// The wire request id, normalized the way acp.rs normalized prompt/result ids.
fn wire_id_to_string(id: Option<&Value>) -> Option<String> {
    id.map(|value| match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => value.to_string(),
    })
}

/// Mode reply line. The frontend consumes mode state exclusively from the
/// StatusUpdate event, so the JSON-RPC reply only acknowledges the request.
fn emit_mode_response(app: &AppHandle, session_id: &str, id: Option<Value>) {
    if let Some(id) = id {
        emit_wire_message(
            app,
            session_id,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "status": "ok" },
            })
            .to_string(),
        );
    }
}

/// ACP-shaped config-option error line (acp.rs `emit_config_option_error`).
fn emit_config_option_error(app: &AppHandle, session_id: &str, id: Option<Value>, message: &str) {
    let Some(id) = id else {
        return;
    };
    emit_wire_message(
        app,
        session_id,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32000, "message": message },
        })
        .to_string(),
    );
}

// ---------------------------------------------------------------------------
// Desktop mode state
// ---------------------------------------------------------------------------

/// Desktop mode state for one session. The host has no mode fields (the
/// ACP-era worker carried these), so the desktop keeps them here: seeded from
/// persistence on first use and kept in step by the mode handlers.
/// Plan/permission also persist engine-side through `session.setMode` (the
/// engine journal `session_store` reads); swarm/goal persist through
/// `session_store::update_session_*_mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WireModes {
    plan_mode: bool,
    permission_mode: SessionPermissionMode,
    swarm_mode: bool,
    goal_mode: bool,
}

impl Default for WireModes {
    fn default() -> Self {
        Self {
            plan_mode: false,
            permission_mode: SessionPermissionMode::Manual,
            swarm_mode: false,
            goal_mode: false,
        }
    }
}

impl WireModes {
    /// Seed from the same sources acp.rs `resolve_initial_runtime_modes` used:
    /// persisted Plan/permission (engine journal + global defaults) and
    /// desktop swarm/goal session state.
    fn from_resolved(session_id: &str) -> Self {
        match session_store::resolved_runtime_modes(session_id) {
            Ok(modes) => Self {
                plan_mode: modes.plan_mode,
                permission_mode: permission_mode_from_str(&modes.permission_mode)
                    .unwrap_or(SessionPermissionMode::Manual),
                swarm_mode: modes.swarm_mode,
                goal_mode: modes.goal_mode,
            },
            Err(err) => {
                eprintln!("[wire] failed to read persisted runtime modes for {session_id}: {err}");
                Self::default()
            }
        }
    }

    /// ACP `mode_status_payload` shape (acp.rs:1654-1668).
    fn payload(&self) -> Value {
        json!({
            "context_usage": null,
            "token_usage": null,
            "plan_mode": self.plan_mode,
            "permission_mode": permission_mode_wire(self.permission_mode),
            "swarm_mode": self.swarm_mode,
            "goal_mode": self.goal_mode,
        })
    }
}

static SESSION_MODES: OnceLock<Mutex<HashMap<String, WireModes>>> = OnceLock::new();

fn session_modes() -> &'static Mutex<HashMap<String, WireModes>> {
    SESSION_MODES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn modes_for(session_id: &str) -> WireModes {
    let mut store = session_modes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *store
        .entry(session_id.to_string())
        .or_insert_with(|| WireModes::from_resolved(session_id))
}

fn set_modes(session_id: &str, modes: WireModes) {
    session_modes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(session_id.to_string(), modes);
}

/// `session.setMode` result merged into the mode payload: plan/permission come
/// from the engine readback, swarm/goal/context/token from the local state
/// (acp.rs `emit_mode_status_wire` parity).
fn mode_status_payload_with_result(modes: &WireModes, result: &SessionSetModeResult) -> Value {
    json!({
        "context_usage": null,
        "token_usage": null,
        "plan_mode": result.plan_mode.unwrap_or(modes.plan_mode),
        "permission_mode": result
            .permission_mode
            .map(permission_mode_wire)
            .unwrap_or_else(|| permission_mode_wire(modes.permission_mode)),
        "swarm_mode": modes.swarm_mode,
        "goal_mode": modes.goal_mode,
    })
}

fn permission_mode_from_str(value: &str) -> Option<SessionPermissionMode> {
    match value {
        "manual" | "ask" | "default" => Some(SessionPermissionMode::Manual),
        "auto" => Some(SessionPermissionMode::Auto),
        "yolo" => Some(SessionPermissionMode::Yolo),
        _ => None,
    }
}

fn permission_mode_wire(mode: SessionPermissionMode) -> &'static str {
    match mode {
        SessionPermissionMode::Manual => "manual",
        SessionPermissionMode::Auto => "auto",
        SessionPermissionMode::Yolo => "yolo",
    }
}

fn mode_enabled_from_params(params: &Value) -> Result<bool, String> {
    params
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "mode update requires boolean params.enabled".to_string())
}

fn permission_mode_from_params(params: &Value) -> Result<SessionPermissionMode, String> {
    params
        .get("mode")
        .and_then(Value::as_str)
        .and_then(permission_mode_from_str)
        .ok_or_else(|| {
            "permission mode update requires params.mode = manual, yolo, or auto".to_string()
        })
}

/// acp `ensure_mode_change_idle` parity: plan/swarm/goal changes wait for an
/// idle session; permission hot-switches mid-turn and skips this gate.
fn ensure_mode_change_idle(host: &RuntimeHost, session_id: &str) -> Result<(), String> {
    if host.in_flight_turns(session_id).is_empty() {
        Ok(())
    } else {
        Err("Session is busy; wait for completion before changing modes.".to_string())
    }
}

// ---------------------------------------------------------------------------
// Usage / config snapshots
// ---------------------------------------------------------------------------

/// `emit_usage_status_wire` with no prompt result (acp.rs:1720-1772): the
/// context/token usage comes from the latest `usage.record` in wire.jsonl.
/// Returns `None` when there is no record — the ACP path then skips the emit.
fn usage_status_payload(session_id: &str) -> Option<Value> {
    let from_wire = match session_store::latest_turn_usage(session_id) {
        Ok(snapshot) => snapshot,
        Err(err) => {
            eprintln!("[wire] failed to read usage.record for {session_id}: {err}");
            None
        }
    };
    let context_source = from_wire.clone();
    let token_source = from_wire;
    let context_source = context_source?;
    let used = context_source.context_tokens();
    let model = context_source
        .model
        .as_deref()
        .or(token_source.as_ref().and_then(|u| u.model.as_deref()))
        .unwrap_or("");
    let size = global_config::max_context_size_for_model(model);
    let context_usage = size
        .filter(|s| *s > 0)
        .map(|s| ((used as f64) / (s as f64)).clamp(0.0, 1.0));
    let token_usage = token_source
        .as_ref()
        .map(SessionUsageSnapshot::to_token_usage_json)
        .unwrap_or(Value::Null);
    Some(json!({
        "context_usage": context_usage,
        "token_usage": token_usage,
        "context_tokens": used,
        "max_context_tokens": size,
    }))
}

/// `session.config` -> ConfigOptionUpdate wire line, mirroring
/// `runtime/translate/fidelity.rs::translate_session_config` (options form
/// first, minimal single-record `model` form otherwise).
fn session_config_snapshot_wire(session_id: &str, payload: &Value) -> String {
    if let Some(options) = payload.get("options").and_then(Value::as_array) {
        let mapped = options
            .iter()
            .filter_map(|option| {
                let id = option.get("id").and_then(Value::as_str)?;
                Some(json!({
                    "id": id,
                    "optionType": option
                        .get("optionType")
                        .or_else(|| option.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    "label": option.get("label").cloned(),
                    "currentValue": option
                        .get("currentValue")
                        .or_else(|| option.get("current_value"))
                        .cloned(),
                    "options": option.get("options").cloned(),
                }))
            })
            .collect::<Vec<_>>();
        return wire_event_message(
            "ConfigOptionUpdate",
            json!({
                "session_id": session_id,
                "status": "known",
                "options": mapped,
            }),
        );
    }
    wire_event_message(
        "ConfigOptionUpdate",
        json!({
            "session_id": session_id,
            "status": "known",
            "options": [{
                "id": "model",
                "optionType": "unknown",
                "label": Value::Null,
                "currentValue": payload.get("model").cloned().unwrap_or(Value::Null),
                "options": Value::Null,
            }],
        }),
    )
}

/// Clone a `session.config` payload with the `model` option set to `model`,
/// preserving any declared option set (the frontend replaces its whole config
/// state on every ConfigOptionUpdate, so the command must not narrow it).
fn config_snapshot_with_model(payload: &Value, model: &str) -> Value {
    if let Some(options) = payload.get("options").and_then(Value::as_array) {
        let mut updated = payload.clone();
        if let Some(updated_options) = updated.get_mut("options").and_then(Value::as_array_mut) {
            if let Some(option) = updated_options
                .iter_mut()
                .find(|option| option.get("id").and_then(Value::as_str) == Some("model"))
            {
                if let Some(map) = option.as_object_mut() {
                    map.insert("currentValue".to_string(), json!(model));
                }
            } else {
                updated_options.push(json!({ "id": "model", "currentValue": model }));
            }
        }
        debug_assert_eq!(
            updated
                .get("options")
                .and_then(Value::as_array)
                .map(|items| items.len()),
            Some(options.len())
        );
        updated
    } else {
        json!({ "model": model })
    }
}

// ---------------------------------------------------------------------------
// Prompt input building (session_compat.rs prompt-builder parity)
// ---------------------------------------------------------------------------

/// Build the `turn.start` input from the expanded wire prompt params, mirroring
/// the ACP-era builder: a leading slash command stays a single-block prompt
/// (never pollutes slash routing with compat blocks); otherwise the user input
/// is kept and desktop swarm/goal compat reminders are appended as trailing
/// text parts (the engine has no swarm/goal session-mode fields).
fn build_turn_input(
    params: &Value,
    swarm_mode: bool,
    goal_mode: bool,
) -> Result<PromptInput, String> {
    if let Some(slash) = slash_command_text(params) {
        return Ok(PromptInput::Text(slash));
    }
    let mut parts: Vec<ContentPart> = match params.get("user_input").cloned().unwrap_or(Value::Null)
    {
        Value::String(text) => vec![ContentPart::text(text)],
        Value::Array(items) => items
            .iter()
            .map(content_part_from_value)
            .collect::<Result<Vec<_>, _>>()?,
        other => vec![ContentPart::text(other.to_string())],
    };
    if swarm_mode {
        parts.push(ContentPart::text(desktop_compat_prompt_text(
            "swarm",
            SWARM_COMPAT_INSTRUCTION,
        )));
    }
    if let Some((kind, instruction)) = goal_compat_instruction(params, goal_mode) {
        parts.push(ContentPart::text(desktop_compat_prompt_text(
            kind,
            instruction,
        )));
    }
    Ok(PromptInput::Parts(parts))
}

fn slash_command_text(params: &Value) -> Option<String> {
    match params.get("user_input") {
        Some(Value::String(s)) if s.trim().starts_with('/') => Some(s.trim().to_string()),
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

fn goal_compat_instruction(
    params: &Value,
    goal_mode: bool,
) -> Option<(&'static str, &'static str)> {
    match params.get("goal_action").and_then(Value::as_str) {
        Some("create") => Some(("goal-create", GOAL_CREATE_COMPAT_INSTRUCTION)),
        Some("replace") => Some(("goal-replace", GOAL_REPLACE_COMPAT_INSTRUCTION)),
        Some("resume") => Some(("goal-resume", GOAL_RESUME_COMPAT_INSTRUCTION)),
        _ if goal_mode => Some(("goal", GOAL_MODE_COMPAT_INSTRUCTION)),
        _ => None,
    }
}

/// Map one wire content part onto the runtime `ContentPart` shape. The engine
/// prompt contract accepts text / image_url / video_url parts only; unknown
/// part types fail clearly instead of surfacing a deep engine error.
fn content_part_from_value(part: &Value) -> Result<ContentPart, String> {
    let part_type = part.get("type").and_then(Value::as_str).unwrap_or("text");
    match part_type {
        "text" => Ok(ContentPart::text(
            part.get("text").and_then(Value::as_str).unwrap_or(""),
        )),
        "think" => Ok(ContentPart::think(
            part.get("think").and_then(Value::as_str).unwrap_or(""),
        )),
        "image_url" => {
            let url = part
                .pointer("/image_url/url")
                .and_then(Value::as_str)
                .ok_or_else(|| "turn input image_url part requires a non-empty url".to_string())?;
            let id = part
                .pointer("/image_url/id")
                .and_then(Value::as_str)
                .map(str::to_string);
            Ok(ContentPart::image(url.to_string(), id))
        }
        "video_url" => {
            let url = part
                .pointer("/video_url/url")
                .and_then(Value::as_str)
                .ok_or_else(|| "turn input video_url part requires a non-empty url".to_string())?;
            Ok(ContentPart {
                part_type: "video_url".to_string(),
                video_url: Some(MediaRef {
                    url: url.to_string(),
                    id: None,
                }),
                ..ContentPart::default()
            })
        }
        other => Err(format!(
            "turn input part type `{other}` is not supported by the engine prompt contract"
        )),
    }
}

// ---------------------------------------------------------------------------
// Goal bridge read side
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::client::SessionModeKind;

    fn input_json(input: &PromptInput) -> Value {
        serde_json::to_value(input).expect("prompt input serializes")
    }

    #[test]
    fn wire_id_maps_string_number_and_other() {
        assert_eq!(
            wire_id_to_string(Some(&json!("req-1"))).as_deref(),
            Some("req-1")
        );
        assert_eq!(wire_id_to_string(Some(&json!(42))).as_deref(), Some("42"));
        assert_eq!(
            wire_id_to_string(Some(&json!(true))).as_deref(),
            Some("true")
        );
        assert_eq!(wire_id_to_string(None), None);
    }

    #[test]
    fn mode_enabled_requires_boolean() {
        assert!(mode_enabled_from_params(&json!({ "enabled": true })).unwrap());
        assert!(mode_enabled_from_params(&json!({ "enabled": "yes" })).is_err());
        assert!(mode_enabled_from_params(&json!({})).is_err());
    }

    #[test]
    fn permission_mode_accepts_wire_values_and_aliases() {
        assert_eq!(
            permission_mode_from_params(&json!({ "mode": "manual" })).unwrap(),
            SessionPermissionMode::Manual
        );
        assert_eq!(
            permission_mode_from_params(&json!({ "mode": "auto" })).unwrap(),
            SessionPermissionMode::Auto
        );
        assert_eq!(
            permission_mode_from_params(&json!({ "mode": "yolo" })).unwrap(),
            SessionPermissionMode::Yolo
        );
        assert_eq!(
            permission_mode_from_params(&json!({ "mode": "ask" })).unwrap(),
            SessionPermissionMode::Manual
        );
        assert_eq!(
            permission_mode_from_params(&json!({ "mode": "default" })).unwrap(),
            SessionPermissionMode::Manual
        );
        assert!(permission_mode_from_params(&json!({ "mode": "anything" })).is_err());
        assert!(permission_mode_from_params(&json!({})).is_err());
    }

    #[test]
    fn slash_command_stays_a_single_text_block() {
        let input = build_turn_input(&json!({ "user_input": "  /compact" }), true, true).unwrap();
        assert_eq!(input_json(&input), json!("/compact"));
    }

    #[test]
    fn plain_prompt_keeps_user_input_without_compat_blocks() {
        let input = build_turn_input(&json!({ "user_input": "hello" }), false, false).unwrap();
        assert_eq!(
            input_json(&input),
            json!([{ "type": "text", "text": "hello" }])
        );
    }

    #[test]
    fn swarm_and_goal_modes_append_compat_blocks() {
        let input = build_turn_input(&json!({ "user_input": "do it" }), true, true).unwrap();
        let value = input_json(&input);
        let parts = value.as_array().unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0]["text"], "do it");
        assert!(parts[1]["text"]
            .as_str()
            .unwrap()
            .contains("kind=\"swarm\""));
        assert!(parts[2]["text"].as_str().unwrap().contains("kind=\"goal\""));
    }

    #[test]
    fn goal_action_selects_the_compat_kind() {
        for (action, kind) in [
            ("create", "goal-create"),
            ("replace", "goal-replace"),
            ("resume", "goal-resume"),
        ] {
            let input = build_turn_input(
                &json!({ "user_input": "task", "goal_action": action }),
                false,
                false,
            )
            .unwrap();
            let value = input_json(&input);
            let parts = value.as_array().unwrap();
            assert_eq!(parts.len(), 2, "action {action}");
            assert!(parts[1]["text"]
                .as_str()
                .unwrap()
                .contains(&format!("kind=\"{kind}\"")));
        }
    }

    #[test]
    fn goal_mode_without_action_appends_the_goal_block() {
        let input = build_turn_input(&json!({ "user_input": "task" }), false, true).unwrap();
        let value = input_json(&input);
        let parts = value.as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert!(parts[1]["text"].as_str().unwrap().contains("kind=\"goal\""));
    }

    #[test]
    fn content_part_maps_text_and_media() {
        let text = content_part_from_value(&json!({ "type": "text", "text": "hi" })).unwrap();
        assert_eq!(text.text.as_deref(), Some("hi"));

        let image = content_part_from_value(&json!({
            "type": "image_url",
            "image_url": { "url": "data:image/png;base64,AA", "id": "up-1" },
        }))
        .unwrap();
        assert_eq!(image.part_type, "image_url");
        assert_eq!(
            image.image_url.as_ref().unwrap().url,
            "data:image/png;base64,AA"
        );
        assert_eq!(
            image.image_url.as_ref().unwrap().id.as_deref(),
            Some("up-1")
        );

        let video = content_part_from_value(&json!({
            "type": "video_url",
            "video_url": { "url": "https://example.com/v.mp4" },
        }))
        .unwrap();
        assert_eq!(video.part_type, "video_url");
        assert_eq!(
            video.video_url.as_ref().unwrap().url,
            "https://example.com/v.mp4"
        );
    }

    #[test]
    fn content_part_rejects_unknown_types() {
        let err =
            content_part_from_value(&json!({ "type": "audio_url", "audio_url": {} })).unwrap_err();
        assert!(err.contains("audio_url"));
        let err =
            content_part_from_value(&json!({ "type": "image_url", "image_url": {} })).unwrap_err();
        assert!(err.contains("non-empty url"));
    }

    #[test]
    fn mode_status_payload_matches_acp_shape() {
        let modes = WireModes {
            plan_mode: true,
            permission_mode: SessionPermissionMode::Auto,
            swarm_mode: true,
            goal_mode: false,
        };
        let payload = modes.payload();
        assert_eq!(payload["context_usage"], Value::Null);
        assert_eq!(payload["token_usage"], Value::Null);
        assert_eq!(payload["plan_mode"], true);
        assert_eq!(payload["permission_mode"], "auto");
        assert_eq!(payload["swarm_mode"], true);
        assert_eq!(payload["goal_mode"], false);
    }

    #[test]
    fn mode_status_payload_merges_set_mode_result() {
        let modes = WireModes {
            plan_mode: false,
            permission_mode: SessionPermissionMode::Manual,
            swarm_mode: true,
            goal_mode: true,
        };
        let plan_result = SessionSetModeResult {
            session_id: "s1".to_string(),
            mode: SessionModeKind::Plan,
            plan_mode: Some(true),
            permission_mode: None,
        };
        let payload = mode_status_payload_with_result(&modes, &plan_result);
        assert_eq!(payload["plan_mode"], true);
        assert_eq!(payload["permission_mode"], "manual");
        assert_eq!(payload["swarm_mode"], true);
        assert_eq!(payload["goal_mode"], true);

        let permission_result = SessionSetModeResult {
            session_id: "s1".to_string(),
            mode: SessionModeKind::Permission,
            plan_mode: None,
            permission_mode: Some(SessionPermissionMode::Yolo),
        };
        let payload = mode_status_payload_with_result(&modes, &permission_result);
        assert_eq!(payload["plan_mode"], false);
        assert_eq!(payload["permission_mode"], "yolo");
    }

    #[test]
    fn config_snapshot_wire_builds_options_and_minimal_forms() {
        let line = session_config_snapshot_wire("s1", &json!({ "model": "kimi-k2" }));
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["method"], "event");
        assert_eq!(value["params"]["type"], "ConfigOptionUpdate");
        assert_eq!(value["params"]["payload"]["session_id"], "s1");
        assert_eq!(value["params"]["payload"]["status"], "known");
        let options = value["params"]["payload"]["options"].as_array().unwrap();
        assert_eq!(options.len(), 1);
        assert_eq!(options[0]["id"], "model");
        assert_eq!(options[0]["currentValue"], "kimi-k2");

        let line = session_config_snapshot_wire(
            "s1",
            &json!({
                "options": [
                    { "id": "model", "currentValue": "kimi-k2", "options": null },
                    { "id": "thinking", "type": "boolean", "current_value": true, "label": "Thinking" },
                ],
            }),
        );
        let value: Value = serde_json::from_str(&line).unwrap();
        let options = value["params"]["payload"]["options"].as_array().unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["optionType"], "unknown");
        assert_eq!(options[1]["optionType"], "boolean");
        assert_eq!(options[1]["currentValue"], true);
        assert_eq!(options[1]["label"], "Thinking");
    }

    #[test]
    fn config_snapshot_with_model_preserves_declared_options() {
        let snapshot = json!({
            "options": [
                { "id": "model", "currentValue": "kimi-k2" },
                { "id": "thinking", "current_value": true },
            ],
        });
        let updated = config_snapshot_with_model(&snapshot, "kimi-k3");
        let options = updated["options"].as_array().unwrap();
        assert_eq!(options.len(), 2, "declared options must not be narrowed");
        assert_eq!(options[0]["id"], "model");
        assert_eq!(options[0]["currentValue"], "kimi-k3");
        assert_eq!(
            options[1]["current_value"], true,
            "non-model option preserved verbatim"
        );

        let minimal = config_snapshot_with_model(&json!({ "model": "kimi-k2" }), "kimi-k3");
        assert_eq!(minimal, json!({ "model": "kimi-k3" }));
    }
}
