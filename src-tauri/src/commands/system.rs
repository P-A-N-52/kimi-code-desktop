use crate::git_diff;
use crate::goal_queue;
use crate::goal_store;
use crate::runtime::host::RuntimeHost;
use crate::security::{
    validate_http_external_url, validate_local_absolute_path, validate_local_write_path,
};
use crate::session_files;
use crate::session_store;
use crate::skills;
use serde_json::{json, Value};
use std::fs;
use std::process::Command;
use tauri::Manager;

#[tauri::command]
pub fn get_session_goal_snapshot(session_id: String) -> Result<Option<Value>, String> {
    goal_store::session_goal_snapshot(&session_id)
}

#[tauri::command]
pub fn get_session_goal_queue(session_id: String) -> Result<goal_queue::GoalQueueSnapshot, String> {
    goal_queue::read(&session_id)
}

#[tauri::command]
pub fn append_session_goal_queue(
    session_id: String,
    objective: String,
) -> Result<goal_queue::GoalQueueSnapshot, String> {
    goal_queue::append(&session_id, &objective)
}

#[tauri::command]
pub fn update_session_goal_queue(
    session_id: String,
    goal_id: String,
    objective: String,
) -> Result<goal_queue::GoalQueueSnapshot, String> {
    goal_queue::update(&session_id, &goal_id, &objective)
}

#[tauri::command]
pub fn remove_session_goal_queue(
    session_id: String,
    goal_id: String,
) -> Result<goal_queue::GoalQueueSnapshot, String> {
    goal_queue::remove(&session_id, &goal_id)
}

#[tauri::command]
pub fn move_session_goal_queue(
    session_id: String,
    goal_id: String,
    direction: goal_queue::GoalQueueMoveDirection,
) -> Result<goal_queue::GoalQueueSnapshot, String> {
    goal_queue::move_item(&session_id, &goal_id, direction)
}

/// Side effects decided by [`decide_goal_control`] for one Goal lifecycle
/// action against the current journal snapshot (pure, unit-tested).
#[derive(Debug)]
enum GoalControlStep {
    /// Terminal result without side effects (early return).
    Return(Option<Value>),
    /// Pause: cancel in-flight turns when present, then append the pause
    /// record when the journal reports the goal active.
    Pause {
        cancel_in_flight: bool,
        append_pause: bool,
    },
    /// Cancel: append the clear record. The runtime mapping deliberately
    /// leaves a running turn alone — the engine owns the Goal and there is
    /// no desktop worker lifecycle to stop (the ACP version cancelled the
    /// prompt and stopped the worker here).
    Cancel,
}

/// Pure decision table for [`control_session_goal`], mirroring the ACP-era
/// `control_goal` contract (`acp.rs`) minus the worker lifecycle:
///
/// - pause: already `paused`/`blocked` -> early return; otherwise cancel
///   in-flight turns (runtime `turn.cancel` replaces the ACP prompt cancel)
///   and append `goal.update paused` only while the journal reports the
///   goal `active`.
/// - resume: a no-op in the runtime (the next prompt resumes the Goal
///   natively through the engine's Goal tools); `active` returns early and
///   `complete` is an explicit error, matching the ACP contract.
/// - cancel: append `goal.clear`.
fn decide_goal_control(
    action: &str,
    snapshot: Option<&Value>,
    has_in_flight: bool,
) -> Result<GoalControlStep, String> {
    if !matches!(action, "pause" | "resume" | "cancel") {
        return Err(format!("Unsupported Goal control: {action}"));
    }
    let Some(snapshot) = snapshot else {
        return Ok(GoalControlStep::Return(None));
    };
    let status = snapshot.get("status").and_then(Value::as_str);
    match action {
        "pause" if matches!(status, Some("paused" | "blocked")) => {
            Ok(GoalControlStep::Return(Some(snapshot.clone())))
        }
        "resume" => {
            if status == Some("active") {
                Ok(GoalControlStep::Return(Some(snapshot.clone())))
            } else if status == Some("complete") {
                Err("A completed Goal cannot be resumed; create a new Goal instead.".to_string())
            } else {
                // paused / blocked / unset: no-op; the next prompt resumes natively.
                Ok(GoalControlStep::Return(Some(snapshot.clone())))
            }
        }
        "pause" => Ok(GoalControlStep::Pause {
            cancel_in_flight: has_in_flight,
            append_pause: status == Some("active"),
        }),
        "cancel" => Ok(GoalControlStep::Cancel),
        _ => unreachable!("validated above"),
    }
}

/// Apply Goal lifecycle controls against the source runtime.
///
/// Runtime mapping (M4 W2): pause cancels in-flight turns (`turn.cancel`,
/// runtime parity for the ACP prompt cancel) and appends the engine journal's
/// `goal.update paused`; cancel appends `goal.clear`; resume is a no-op — the
/// next prompt resumes natively. The ACP-era worker stop/reconnect steps are
/// gone: runtime sessions are not desktop-owned workers, so Goal control does
/// not disturb the wire session.
///
/// Journal-write premise: `goal_store::append_pause` only ever runs while the
/// session has no in-flight turn (the cancel above drains it first), which is
/// the accepted dual-writer condition for the desktop writing the engine
/// journal directly (M4 plan §3.8).
#[tauri::command]
pub async fn control_session_goal(
    app: tauri::AppHandle,
    session_id: String,
    action: String,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<Value>, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let snapshot = goal_store::session_goal_snapshot(&session_id)?;
        let has_in_flight = !host.in_flight_turns(&session_id).is_empty();
        match decide_goal_control(&action, snapshot.as_ref(), has_in_flight)? {
            GoalControlStep::Return(result) => Ok(result),
            GoalControlStep::Pause {
                cancel_in_flight,
                append_pause,
            } => {
                if cancel_in_flight {
                    host.cancel_turn(&session_id, None)?;
                }
                if append_pause {
                    goal_store::append_pause(&session_id)?;
                }
                goal_store::session_goal_snapshot(&session_id)
            }
            GoalControlStep::Cancel => {
                goal_store::append_clear(&session_id)?;
                goal_store::session_goal_snapshot(&session_id)
            }
        }
    })
    .await
    .map_err(|e| format!("Failed to join control_session_goal: {e}"))?
}

#[tauri::command]
pub fn get_session_swarm_mode(session_id: String) -> Result<bool, String> {
    session_store::session_swarm_mode(&session_id)
}

#[tauri::command]
pub fn get_session_goal_mode(session_id: String) -> Result<bool, String> {
    session_store::session_goal_mode(&session_id)
}

#[tauri::command]
pub fn get_session_runtime_modes(session_id: String) -> Result<Value, String> {
    let modes = session_store::resolved_runtime_modes(&session_id)?;
    Ok(json!({
        "plan_mode": modes.plan_mode,
        "permission_mode": modes.permission_mode,
        "swarm_mode": modes.swarm_mode,
        "goal_mode": modes.goal_mode,
    }))
}

#[tauri::command]
pub fn migrate_session_swarm_mode(session_id: String, enabled: bool) -> Result<(), String> {
    session_store::update_session_swarm_mode(&session_id, enabled)?;
    Ok(())
}

#[tauri::command]
pub fn migrate_session_goal_mode(session_id: String, enabled: bool) -> Result<(), String> {
    session_store::update_session_goal_mode(&session_id, enabled)?;
    Ok(())
}

#[tauri::command]
pub fn list_available_skills() -> Result<Value, String> {
    skills::list_available_skills()
}

/// Native multi-select file picker. Returns absolute paths so the composer can
/// insert them as text tokens (browser file inputs do not expose real paths).
#[tauri::command]
pub fn pick_files() -> Result<Value, String> {
    let paths = rfd::FileDialog::new()
        .pick_files()
        .map(|files| {
            files
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!(paths))
}

/// Native folder picker for choosing a session work directory. Returns the
/// absolute path, or null when the user cancels.
#[tauri::command]
pub fn pick_folder() -> Result<Value, String> {
    match rfd::FileDialog::new()
        .set_title("选择工作目录")
        .pick_folder()
    {
        Some(path) => Ok(json!(path.to_string_lossy().to_string())),
        None => Ok(Value::Null),
    }
}

/// Save-dialog for Desktop-local exports (e.g. session Markdown). Returns
/// `{ saved: boolean, path: string | null }`; `saved` is false when cancelled.
#[tauri::command]
pub fn save_text_file_dialog(
    default_name: Option<String>,
    content: String,
) -> Result<Value, String> {
    let mut dialog = rfd::FileDialog::new().set_title("保存文件");
    if let Some(name) = default_name.as_deref() {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            dialog = dialog.set_file_name(trimmed);
        }
    }
    dialog = dialog
        .add_filter("Markdown", &["md"])
        .add_filter("Text", &["txt"]);

    match dialog.save_file() {
        Some(path) => {
            let path_str = path.to_string_lossy().to_string();
            let validated = validate_local_write_path(&path_str)?;
            if let Some(parent) = validated.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent)
                        .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
                }
            }
            fs::write(&validated, content.as_bytes())
                .map_err(|err| format!("Failed to write {}: {err}", validated.display()))?;
            Ok(json!({
                "saved": true,
                "path": path_str,
            }))
        }
        None => Ok(json!({
            "saved": false,
            "path": Value::Null,
        })),
    }
}

#[tauri::command]
pub async fn get_git_diff_stats(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let host = app.state::<RuntimeHost>();
        host.install_app(&app);
        let work_dir = session_files::resolve_session_work_dir_runtime(&app, &session_id)?;
        Ok(git_diff::get_git_diff_stats_for_work_dir(&work_dir))
    })
    .await
    .map_err(|e| format!("Failed to join get_git_diff_stats: {e}"))?
}

#[tauri::command]
pub fn show_window(window: tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.center();
    let _ = window.set_focus();
}

#[tauri::command]
pub fn hide_window(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    validate_http_external_url(&url)?;
    open::that_detached(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let path_obj = validate_local_absolute_path(&path)?;
    let path = path_obj.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        if path_obj.is_file() {
            std::process::Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if path_obj.is_file() {
            command.arg("-R");
        }
        command.arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_in_editor(path: String, editor: String) -> Result<(), String> {
    let path_obj = validate_local_absolute_path(&path)?;
    let path = path_obj.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        let app = match editor.as_str() {
            "vscode" => "Visual Studio Code",
            "cursor" => "Cursor",
            _ => return Err(format!("Unsupported editor: {}", editor)),
        };
        Command::new("open")
            .args(["-a", app])
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    let bin = match editor.as_str() {
        "vscode" => "code",
        "cursor" => "cursor",
        _ => return Err(format!("Unsupported editor: {}", editor)),
    };

    #[cfg(not(target_os = "macos"))]
    open::with_detached(path, bin).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::validate_http_external_url;

    #[test]
    fn open_external_rejects_non_http_schemes() {
        assert!(validate_http_external_url("file:///etc/passwd").is_err());
        assert!(validate_http_external_url("javascript:alert(1)").is_err());
        validate_http_external_url("https://example.com").unwrap();
    }

    fn snapshot_with_status(status: &str) -> Value {
        json!({ "goalId": "g-1", "status": status })
    }

    fn snapshot_without_status() -> Value {
        json!({ "goalId": "g-1" })
    }

    #[test]
    fn goal_control_rejects_unknown_actions() {
        assert_eq!(
            decide_goal_control("explode", Some(&snapshot_with_status("active")), false)
                .expect_err("unknown action must fail"),
            "Unsupported Goal control: explode"
        );
        assert_eq!(
            decide_goal_control("explode", None, false).expect_err("unknown action must fail"),
            "Unsupported Goal control: explode"
        );
    }

    #[test]
    fn goal_control_without_goal_returns_none_for_every_action() {
        for action in ["pause", "resume", "cancel"] {
            let step = decide_goal_control(action, None, false).expect("decided");
            assert!(matches!(step, GoalControlStep::Return(None)), "{action}");
        }
    }

    #[test]
    fn goal_control_pause_when_already_paused_or_blocked_returns_early() {
        for status in ["paused", "blocked"] {
            let step = decide_goal_control("pause", Some(&snapshot_with_status(status)), true)
                .expect("decided");
            assert!(matches!(step, GoalControlStep::Return(Some(_))), "{status}");
        }
    }

    #[test]
    fn goal_control_pause_active_with_in_flight_cancels_then_appends_pause() {
        let step = decide_goal_control("pause", Some(&snapshot_with_status("active")), true)
            .expect("decided");
        assert!(matches!(
            step,
            GoalControlStep::Pause {
                cancel_in_flight: true,
                append_pause: true
            }
        ));
    }

    #[test]
    fn goal_control_pause_active_without_in_flight_only_appends_pause() {
        let step = decide_goal_control("pause", Some(&snapshot_with_status("active")), false)
            .expect("decided");
        assert!(matches!(
            step,
            GoalControlStep::Pause {
                cancel_in_flight: false,
                append_pause: true
            }
        ));
    }

    #[test]
    fn goal_control_pause_complete_cancels_but_does_not_append_pause() {
        let step = decide_goal_control("pause", Some(&snapshot_with_status("complete")), true)
            .expect("decided");
        assert!(matches!(
            step,
            GoalControlStep::Pause {
                cancel_in_flight: true,
                append_pause: false
            }
        ));
    }

    #[test]
    fn goal_control_pause_without_status_cancels_but_does_not_append_pause() {
        let step =
            decide_goal_control("pause", Some(&snapshot_without_status()), true).expect("decided");
        assert!(matches!(
            step,
            GoalControlStep::Pause {
                cancel_in_flight: true,
                append_pause: false
            }
        ));
    }

    #[test]
    fn goal_control_resume_active_returns_early() {
        let step = decide_goal_control("resume", Some(&snapshot_with_status("active")), true)
            .expect("decided");
        assert!(matches!(step, GoalControlStep::Return(Some(_))));
    }

    #[test]
    fn goal_control_resume_paused_is_a_noop() {
        let step = decide_goal_control("resume", Some(&snapshot_with_status("paused")), false)
            .expect("decided");
        assert!(matches!(step, GoalControlStep::Return(Some(_))));
    }

    #[test]
    fn goal_control_resume_complete_is_an_error() {
        let error = decide_goal_control("resume", Some(&snapshot_with_status("complete")), false)
            .expect_err("completed Goal must not resume");
        assert_eq!(
            error,
            "A completed Goal cannot be resumed; create a new Goal instead."
        );
    }

    #[test]
    fn goal_control_cancel_appends_clear() {
        let step = decide_goal_control("cancel", Some(&snapshot_with_status("active")), true)
            .expect("decided");
        assert!(matches!(step, GoalControlStep::Cancel));
        let no_goal_step = decide_goal_control("cancel", None, false).expect("decided");
        assert!(matches!(no_goal_step, GoalControlStep::Return(None)));
    }
}
