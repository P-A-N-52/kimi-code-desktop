use crate::git_workspace;
use crate::runtime::host::RuntimeHost;
use crate::session_files;
use crate::session_plans;
use serde_json::Value;
use std::path::PathBuf;
use tauri::Manager;

fn session_git_work_dir(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let host = app.state::<RuntimeHost>();
    host.install_app(app);
    session_files::resolve_session_work_dir_runtime(app, session_id)
}

#[tauri::command]
pub async fn get_git_environment(
    app: tauri::AppHandle,
    session_id: String,
    base_ref: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work_dir = session_git_work_dir(&app, &session_id)?;
        git_workspace::environment(&work_dir, base_ref.as_deref())
    })
    .await
    .map_err(|error| format!("Failed to join Git environment lookup: {error}"))?
}

#[tauri::command]
pub async fn get_github_environment(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work_dir = session_git_work_dir(&app, &session_id)?;
        git_workspace::github_environment(&work_dir)
    })
    .await
    .map_err(|error| format!("Failed to join GitHub environment lookup: {error}"))?
}

#[tauri::command]
pub async fn compare_git_branches(
    app: tauri::AppHandle,
    session_id: String,
    left_ref: String,
    right_ref: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work_dir = session_git_work_dir(&app, &session_id)?;
        git_workspace::compare(&work_dir, &left_ref, &right_ref)
    })
    .await
    .map_err(|error| format!("Failed to join Git comparison: {error}"))?
}

#[tauri::command]
pub async fn get_git_comparison_file_diff(
    app: tauri::AppHandle,
    session_id: String,
    left_ref: String,
    right_ref: String,
    path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work_dir = session_git_work_dir(&app, &session_id)?;
        git_workspace::file_diff(&work_dir, &left_ref, &right_ref, &path)
    })
    .await
    .map_err(|error| format!("Failed to join Git file diff: {error}"))?
}

#[tauri::command]
pub async fn switch_git_branch(
    app: tauri::AppHandle,
    session_id: String,
    target_ref: String,
    expected_head: String,
    confirm_dirty: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work_dir = session_git_work_dir(&app, &session_id)?;
        git_workspace::switch_branch(&work_dir, &target_ref, &expected_head, confirm_dirty)
    })
    .await
    .map_err(|error| format!("Failed to join Git branch switch: {error}"))?
}

#[tauri::command]
pub async fn commit_git_changes(
    app: tauri::AppHandle,
    session_id: String,
    paths: Vec<String>,
    message: String,
    expected_head: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work_dir = session_git_work_dir(&app, &session_id)?;
        git_workspace::commit(&work_dir, &paths, &message, &expected_head)
    })
    .await
    .map_err(|error| format!("Failed to join Git commit: {error}"))?
}

#[tauri::command]
pub async fn push_git_branch(
    app: tauri::AppHandle,
    session_id: String,
    remote: String,
    branch: String,
    expected_head: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work_dir = session_git_work_dir(&app, &session_id)?;
        git_workspace::push(&work_dir, &remote, &branch, &expected_head)
    })
    .await
    .map_err(|error| format!("Failed to join Git push: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_github_pull_request(
    app: tauri::AppHandle,
    session_id: String,
    base_ref: String,
    head_ref: String,
    title: String,
    body: String,
    draft: bool,
    expected_head: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work_dir = session_git_work_dir(&app, &session_id)?;
        git_workspace::create_pull_request(
            &work_dir,
            &base_ref,
            &head_ref,
            &title,
            &body,
            draft,
            &expected_head,
        )
    })
    .await
    .map_err(|error| format!("Failed to join pull request creation: {error}"))?
}

#[tauri::command]
pub async fn list_session_plans(session_id: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || session_plans::list(&session_id))
        .await
        .map_err(|error| format!("Failed to join plan listing: {error}"))?
}

#[tauri::command]
pub async fn get_session_plan(session_id: String, plan_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || session_plans::read(&session_id, &plan_id))
        .await
        .map_err(|error| format!("Failed to join plan read: {error}"))?
}
