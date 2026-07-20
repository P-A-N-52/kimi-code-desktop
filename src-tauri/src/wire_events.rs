use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const WIRE_EVENT_NAME: &str = "wire:message";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeStatus {
    pub session_id: String,
    pub state: String,
    pub seq: u64,
    pub worker_id: Option<String>,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RestartWorkersSummary {
    pub restarted_session_ids: Vec<String>,
    pub skipped_busy_session_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
struct WireMessagePayload {
    session_id: String,
    message: String,
}

pub(crate) fn emit_wire_message(app: &AppHandle, session_id: &str, message: String) {
    let _ = app.emit(
        WIRE_EVENT_NAME,
        WireMessagePayload {
            session_id: session_id.to_string(),
            message,
        },
    );
}
