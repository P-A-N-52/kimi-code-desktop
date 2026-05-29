use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;

pub fn send_approval_notification(
    app: &tauri::AppHandle,
    session_id: &str,
    request_id: &str,
    description: &str,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title("Approval Request")
        .body(description)
        .show()
        .map_err(|e| e.to_string())?;

    app.emit(
        "notification:approval",
        serde_json::json!({
            "session_id": session_id,
            "request_id": request_id,
            "description": description
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn send_task_complete_notification(
    app: &tauri::AppHandle,
    session_id: &str,
    title: &str,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title("Task Complete")
        .body(title)
        .show()
        .map_err(|e| e.to_string())?;

    app.emit(
        "notification:task-complete",
        serde_json::json!({
            "session_id": session_id,
            "title": title
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
