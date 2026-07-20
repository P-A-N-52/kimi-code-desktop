//! Pure-Rust session file browser helpers (work_dir listing, read, upload).

use crate::acp_desktop::{fetch_all_acp_sessions, find_session_in_list, AcpDesktopClient};
use crate::acp_translate::normalize_workspace_path;
use crate::runtime_check;
use crate::session_store;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const MAX_DESKTOP_API_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_SAFE_FILENAME_LENGTH: usize = 255;

pub fn resolve_session_file(workspace: &Path, rel_path: &str) -> Result<PathBuf, String> {
    normalize_workspace_path(rel_path, workspace)
}

pub async fn resolve_session_work_dir(
    app: &AppHandle,
    acp_desktop: &AcpDesktopClient,
    session_id: &str,
) -> Result<PathBuf, String> {
    let raw_sessions = fetch_all_acp_sessions(acp_desktop, app).await?;
    if let Some(session) = find_session_in_list(&raw_sessions, session_id) {
        if let Some(cwd) = session.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() {
                return Ok(PathBuf::from(cwd));
            }
        }
    }

    if let Some(session_dir) = session_store::find_session_dir_by_id(session_id)? {
        if let Some(work_dir) = resolve_work_dir_from_session_dir(&session_dir)? {
            return Ok(work_dir);
        }
    }

    Err("Session not found".to_string())
}

fn resolve_work_dir_from_session_dir(session_dir: &Path) -> Result<Option<PathBuf>, String> {
    let hash_key = session_dir
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str());
    let Some(hash_key) = hash_key else {
        return Ok(None);
    };

    let work_dirs = work_dir_by_hash()?;
    Ok(work_dirs.get(hash_key).map(PathBuf::from))
}

fn work_dir_by_hash() -> Result<HashMap<String, String>, String> {
    let metadata_path = runtime_check::kimi_code_home_dir()?.join("kimi.json");
    if !metadata_path.is_file() {
        return Ok(HashMap::new());
    }

    let content = fs::read_to_string(&metadata_path)
        .map_err(|err| format!("Failed to read {}: {err}", metadata_path.display()))?;
    let metadata: Value = serde_json::from_str(&content)
        .map_err(|err| format!("Failed to parse {}: {err}", metadata_path.display()))?;

    let mut result = HashMap::new();
    if let Some(entries) = metadata.get("work_dirs").and_then(Value::as_array) {
        for entry in entries {
            if let Some(path) = entry.get("path").and_then(Value::as_str) {
                let hash = format!("{:x}", md5::compute(path.as_bytes()));
                result.insert(hash, path.to_string());
            }
        }
    }
    Ok(result)
}

pub fn list_directory_entries(dir_path: &Path) -> Result<Vec<Value>, String> {
    if !dir_path.exists() {
        return Err("Path not found".to_string());
    }
    if !dir_path.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(dir_path)
        .map_err(|err| format!("Failed to read directory {}: {err}", dir_path.display()))?;

    for entry in read_dir {
        let entry = entry.map_err(|err| {
            format!(
                "Failed to read directory entry in {}: {err}",
                dir_path.display()
            )
        })?;
        let file_type = entry.file_type().map_err(|err| {
            format!(
                "Failed to read file type for {}: {err}",
                entry.path().display()
            )
        })?;
        let name = entry.file_name().to_string_lossy().into_owned();

        if file_type.is_dir() {
            entries.push(json!({
                "name": name,
                "type": "directory",
            }));
        } else {
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            entries.push(json!({
                "name": name,
                "type": "file",
                "size": size,
            }));
        }
    }

    entries.sort_by(|left, right| {
        let left_is_file = left.get("type").and_then(Value::as_str) == Some("file");
        let right_is_file = right.get("type").and_then(Value::as_str) == Some("file");
        left_is_file.cmp(&right_is_file).then_with(|| {
            left.get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(right.get("name").and_then(Value::as_str).unwrap_or(""))
        })
    });

    Ok(entries)
}

pub fn read_session_file_payload(file_path: &Path) -> Result<Value, String> {
    if !file_path.exists() {
        return Err("File not found".to_string());
    }
    if file_path.is_dir() {
        return Err("Path is a directory, use list_session_directory".to_string());
    }

    ensure_file_within_api_limit(file_path)?;
    let content = fs::read(file_path)
        .map_err(|err| format!("Failed to read {}: {err}", file_path.display()))?;

    Ok(json!({
        "data": base64::engine::general_purpose::STANDARD.encode(content),
        "encoding": "base64",
        "content_type": guess_content_type(file_path),
        "filename": file_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }))
}

pub fn upload_session_file_to_dir(
    session_dir: &Path,
    filename: &str,
    data: &[u8],
) -> Result<Value, String> {
    if data.len() as u64 > MAX_DESKTOP_API_FILE_BYTES {
        return Err(format!(
            "File is too large for desktop API transfer ({} > {})",
            format_size(data.len() as u64),
            format_size(MAX_DESKTOP_API_FILE_BYTES)
        ));
    }

    let safe_name = sanitize_filename(filename);
    let upload_dir = session_dir.join("uploads");
    fs::create_dir_all(&upload_dir).map_err(|err| {
        format!(
            "Failed to create uploads directory {}: {err}",
            upload_dir.display()
        )
    })?;

    let extension = Path::new(&safe_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default();
    let stem = Path::new(&safe_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim_matches(['.', ' ']).is_empty())
        .unwrap_or("unnamed");
    let unique_name = format!("{stem}_{:06x}{extension}", unique_suffix());

    let upload_path = upload_dir.join(&unique_name);
    fs::write(&upload_path, data).map_err(|err| {
        format!(
            "Failed to write upload file {}: {err}",
            upload_path.display()
        )
    })?;

    Ok(json!({
        "path": upload_path.to_string_lossy(),
        "filename": unique_name,
        "size": data.len(),
    }))
}

fn ensure_file_within_api_limit(file_path: &Path) -> Result<(), String> {
    let size = file_path
        .metadata()
        .map_err(|err| format!("Unable to read file metadata: {err}"))?
        .len();
    if size > MAX_DESKTOP_API_FILE_BYTES {
        return Err(format!(
            "File is too large for desktop API transfer ({} > {})",
            format_size(size),
            format_size(MAX_DESKTOP_API_FILE_BYTES)
        ));
    }
    Ok(())
}

fn sanitize_filename(filename: &str) -> String {
    let safe_name: String = filename
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' '))
        .collect::<String>()
        .trim_matches(['.', ' '])
        .replace(' ', "_");
    let safe_name = if safe_name.is_empty() {
        "unnamed".to_string()
    } else {
        safe_name
    };
    safe_name.chars().take(MAX_SAFE_FILENAME_LENGTH).collect()
}

fn unique_suffix() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u32)
        .unwrap_or(0)
}

fn format_size(size: u64) -> String {
    format!("{:.1} MiB", size as f64 / (1024.0 * 1024.0))
}

fn guess_content_type(file_path: &Path) -> String {
    let extension = file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "txt" | "md" => "text/plain".to_string(),
        "html" | "htm" => "text/html".to_string(),
        "json" => "application/json".to_string(),
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "gif" => "image/gif".to_string(),
        "pdf" => "application/pdf".to_string(),
        "svg" => "image/svg+xml".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

/// Work directories recorded in `~/.kimi-code/kimi.json` (most recent first).
pub fn work_dirs_from_metadata() -> Result<Vec<String>, String> {
    let metadata_path = runtime_check::kimi_code_home_dir()?.join("kimi.json");
    if !metadata_path.is_file() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&metadata_path)
        .map_err(|err| format!("Failed to read {}: {err}", metadata_path.display()))?;
    let metadata: Value = serde_json::from_str(&content)
        .map_err(|err| format!("Failed to parse {}: {err}", metadata_path.display()))?;

    let mut work_dirs = Vec::new();
    if let Some(entries) = metadata.get("work_dirs").and_then(Value::as_array) {
        for entry in entries {
            if let Some(path) = entry.get("path").and_then(Value::as_str) {
                if !path.is_empty() {
                    work_dirs.push(path.to_string());
                }
            }
        }
    }
    Ok(work_dirs)
}

pub fn load_sent_upload_names(session_id: &str) -> HashSet<String> {
    let Some(session_dir) = session_store::find_session_dir_by_id(session_id)
        .ok()
        .flatten()
    else {
        return HashSet::new();
    };
    let marker = session_dir.join("uploads").join(".sent");
    if !marker.is_file() {
        return HashSet::new();
    }
    let Ok(content) = fs::read_to_string(&marker) else {
        return HashSet::new();
    };
    serde_json::from_str::<Vec<String>>(&content)
        .map(|names| names.into_iter().collect())
        .unwrap_or_default()
}

fn persist_sent_upload_names(
    session_dir: &Path,
    sent_files: &HashSet<String>,
) -> Result<(), String> {
    let uploads_dir = session_dir.join("uploads");
    fs::create_dir_all(&uploads_dir)
        .map_err(|err| format!("Failed to create uploads directory: {err}"))?;
    let marker = uploads_dir.join(".sent");
    let names: Vec<String> = sent_files.iter().cloned().collect();
    let serialized = serde_json::to_string(&names)
        .map_err(|err| format!("Failed to serialize sent upload marker: {err}"))?;
    fs::write(&marker, serialized)
        .map_err(|err| format!("Failed to write {}: {err}", marker.display()))
}

const TEXT_FILE_EXTENSIONS: &[&str] = &[
    "txt", "md", "json", "yaml", "yml", "xml", "html", "css", "js", "ts", "py", "sh", "csv", "log",
    "rst", "toml", "ini",
];

/// Inject pending `uploads/` files into a legacy wire `prompt` params object.
pub fn expand_prompt_with_uploads(
    session_id: &str,
    params: &Value,
    sent_files: &mut HashSet<String>,
) -> Result<Value, String> {
    let Some(session_dir) = session_store::find_session_dir_by_id(session_id)? else {
        return Ok(params.clone());
    };
    let uploads_dir = session_dir.join("uploads");
    if !uploads_dir.is_dir() {
        return Ok(params.clone());
    }

    for name in load_sent_upload_names(session_id) {
        sent_files.insert(name);
    }

    let mut pending_files: Vec<PathBuf> = fs::read_dir(&uploads_dir)
        .map_err(|err| format!("Failed to read uploads directory: {err}"))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name != ".sent")
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| !sent_files.contains(name))
        })
        .collect();
    pending_files.sort_by_key(|path| path.file_name().map(|name| name.to_owned()));

    if pending_files.is_empty() {
        return Ok(params.clone());
    }

    let mut parts: Vec<Value> = Vec::new();
    let mut file_list_lines = vec!["<uploaded_files>".to_string()];
    for (index, file) in pending_files.iter().enumerate() {
        file_list_lines.push(format!("{}. {}", index + 1, file.display()));
    }
    file_list_lines.push("</uploaded_files>".to_string());
    parts.push(json!({
        "type": "text",
        "text": format!("{}\n\n", file_list_lines.join("\n")),
    }));

    for file in &pending_files {
        let mime_type = mime_guess::from_path(file)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        let ext = file
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let file_path = file.display().to_string();
        let filename = file
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("upload");

        if mime_type.starts_with("image/") {
            let bytes = fs::read(file).map_err(|err| {
                format!("Failed to read uploaded image {}: {err}", file.display())
            })?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            let data_url = format!("data:{mime_type};base64,{encoded}");
            parts.push(json!({
                "type": "text",
                "text": format!("<image path=\"{file_path}\" content_type=\"{mime_type}\">"),
            }));
            parts.push(json!({
                "type": "image_url",
                "image_url": { "url": data_url },
            }));
            parts.push(json!({ "type": "text", "text": "</image>\n\n" }));
        } else if mime_type.starts_with("video/") {
            parts.push(json!({
                "type": "text",
                "text": format!(
                    "<video path=\"{file_path}\" content_type=\"{mime_type}\"></video>\n\n"
                ),
            }));
        } else if TEXT_FILE_EXTENSIONS.contains(&ext.as_str()) || mime_type.starts_with("text/") {
            let text_content = fs::read_to_string(file)
                .map_err(|err| format!("Failed to read uploaded file {}: {err}", file.display()))?;
            parts.push(json!({
                "type": "text",
                "text": format!("<document path=\"{file_path}\" content_type=\"{mime_type}\">"),
            }));
            parts.push(json!({ "type": "text", "text": text_content }));
            parts.push(json!({ "type": "text", "text": "</document>\n\n" }));
        } else {
            let bytes = fs::read(file)
                .map_err(|err| format!("Failed to read uploaded file {}: {err}", file.display()))?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            parts.push(json!({
                "type": "text",
                "text": format!(
                    "<resource path=\"{file_path}\" filename=\"{filename}\" content_type=\"{mime_type}\" encoding=\"base64\">"
                ),
            }));
            parts.push(json!({ "type": "text", "text": encoded }));
            parts.push(json!({ "type": "text", "text": "</resource>\n\n" }));
        }
    }

    match params.get("user_input") {
        Some(Value::String(text))
            if text != "KIMI_FILE_UPLOAD_WITHOUT_MESSAGE" && !text.is_empty() =>
        {
            parts.push(json!({ "type": "text", "text": text }));
        }
        Some(Value::Array(existing)) => {
            parts.extend(existing.iter().cloned());
        }
        _ => {}
    }

    for file in pending_files {
        if let Some(name) = file.file_name().and_then(|value| value.to_str()) {
            sent_files.insert(name.to_string());
        }
    }
    persist_sent_upload_names(&session_dir, sent_files)?;

    Ok(json!({ "user_input": parts }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::lock::set_kimi_code_home;

    #[test]
    fn read_session_file_payload_encodes_binary_as_base64() {
        let temp = tempfile::tempdir().expect("tempdir");
        let file_path = temp.path().join("sample.bin");
        fs::write(&file_path, [0x00, 0x01, 0x02, 0xff]).expect("write");

        let payload = read_session_file_payload(&file_path).expect("payload");
        assert_eq!(payload["encoding"], "base64");
        assert_eq!(payload["data"], "AAEC/w==");
        assert_eq!(payload["content_type"], "application/octet-stream");
    }

    #[test]
    fn expand_prompt_with_uploads_embeds_binary_resource_block() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).expect("home");
        let session_id = "sess-binary";
        let session_dir = home.join("sessions").join("abc").join(session_id);
        let uploads = session_dir.join("uploads");
        std::fs::create_dir_all(&uploads).expect("uploads");
        std::fs::write(uploads.join("notes.pdf"), b"%PDF-1.4").expect("file");

        let _home_guard = set_kimi_code_home(&home);
        let mut sent = HashSet::new();
        let params = json!({ "user_input": "KIMI_FILE_UPLOAD_WITHOUT_MESSAGE" });
        let expanded = expand_prompt_with_uploads(session_id, &params, &mut sent).expect("expand");
        let parts = expanded["user_input"].as_array().expect("parts");
        let combined = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        assert!(combined.contains("<resource"));
        assert!(combined.contains("application/pdf"));
        assert!(sent.contains("notes.pdf"));
    }

    #[test]
    fn session_file_path_rejects_escape() {
        let workspace = std::env::temp_dir().join("kimi-session-files-workspace");
        std::fs::create_dir_all(&workspace).expect("temp workspace");
        let err = resolve_session_file(&workspace, r"..\..\etc\passwd").unwrap_err();
        assert!(err.contains("outside"));
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn resolve_work_dir_from_session_dir_uses_metadata_hash() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let work_dir = temp.path().join("project");
        std::fs::create_dir_all(&work_dir).expect("work dir");
        std::fs::create_dir_all(&home).expect("home");

        let hash = format!("{:x}", md5::compute(work_dir.to_string_lossy().as_bytes()));
        let session_dir = home.join("sessions").join(&hash).join("session-123");
        std::fs::create_dir_all(&session_dir).expect("session dir");

        std::fs::write(
            home.join("kimi.json"),
            format!(
                r#"{{"work_dirs":[{{"path":"{}"}}]}}"#,
                work_dir.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("metadata");

        let _home_guard = set_kimi_code_home(&home);
        let resolved = resolve_work_dir_from_session_dir(&session_dir)
            .expect("lookup")
            .expect("work dir");
        assert_eq!(resolved, work_dir);
    }

    #[test]
    fn list_directory_entries_sorts_directories_before_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("b.txt"), b"hello").expect("file");
        std::fs::create_dir_all(temp.path().join("a_dir")).expect("dir");

        let entries = list_directory_entries(temp.path()).expect("list");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["type"], "directory");
        assert_eq!(entries[0]["name"], "a_dir");
        assert_eq!(entries[1]["type"], "file");
        assert_eq!(entries[1]["name"], "b.txt");
    }

    #[test]
    fn expand_prompt_with_uploads_includes_text_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).expect("home");
        let session_id = "sess-upload";
        let session_dir = home.join("sessions").join("abc").join(session_id);
        let uploads = session_dir.join("uploads");
        std::fs::create_dir_all(&uploads).expect("uploads");
        std::fs::write(uploads.join("notes.txt"), "hello upload").expect("file");

        let _home_guard = set_kimi_code_home(&home);
        let mut sent = HashSet::new();
        let params = json!({ "user_input": "KIMI_FILE_UPLOAD_WITHOUT_MESSAGE" });
        let expanded = expand_prompt_with_uploads(session_id, &params, &mut sent).expect("expand");
        let parts = expanded["user_input"].as_array().expect("parts");
        let combined = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        assert!(combined.contains("<uploaded_files>"));
        assert!(combined.contains("hello upload"));
        assert!(sent.contains("notes.txt"));
    }
}
