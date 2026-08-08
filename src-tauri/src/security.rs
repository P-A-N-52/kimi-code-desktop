//! Shared security validation helpers for command paths, URLs, and local paths.

use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// Allowed protocols for URLs opened in the system browser.
pub fn validate_http_external_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL must not be empty".to_string());
    }

    let scheme_end = trimmed
        .find("://")
        .ok_or_else(|| "URL must include a scheme".to_string())?;
    let scheme = &trimmed[..scheme_end];
    match scheme.to_ascii_lowercase().as_str() {
        "http" | "https" => {
            let rest = &trimmed[scheme_end + 3..];
            if rest.is_empty() {
                return Err("URL must include a host".to_string());
            }
            Ok(())
        }
        _ => Err(format!(
            "Unsupported URL scheme '{scheme}'; only http and https are allowed"
        )),
    }
}

/// Validate a local absolute path suitable for opening in the file manager.
pub fn validate_local_absolute_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path must not be empty".to_string());
    }

    let path_obj = Path::new(trimmed);
    if !path_obj.is_absolute() {
        return Err("Path must be absolute".to_string());
    }

    if is_unc_path(path_obj) {
        return Err("UNC network paths are not allowed".to_string());
    }

    if path_obj
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Path must not contain '..' components".to_string());
    }

    let canonical = path_obj
        .canonicalize()
        .map_err(|e| format!("Path does not exist or is not accessible: {e}"))?;

    if is_unc_path(&canonical) {
        return Err("UNC network paths are not allowed".to_string());
    }

    Ok(canonical)
}

/// Validate an absolute path for writing a new file (parent may not exist yet).
pub fn validate_local_write_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path must not be empty".to_string());
    }

    let path_obj = Path::new(trimmed);
    if !path_obj.is_absolute() {
        return Err("Path must be absolute".to_string());
    }

    if is_unc_path(path_obj) {
        return Err("UNC network paths are not allowed".to_string());
    }

    if path_obj
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Path must not contain '..' components".to_string());
    }

    Ok(path_obj.to_path_buf())
}

/// Validate a filesystem path that will be executed directly.
pub fn validate_executable_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!(
            "Executable path must be absolute: {}",
            path.display()
        ));
    }

    if is_unc_path(path) {
        return Err(format!(
            "UNC network paths are not allowed: {}",
            path.display()
        ));
    }

    let metadata = std::fs::metadata(path).map_err(|e| {
        format!(
            "Executable path does not exist or is not accessible: {} ({e})",
            path.display()
        )
    })?;

    if !metadata.is_file() {
        return Err(format!(
            "Executable path must be a regular file: {}",
            path.display()
        ));
    }

    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize executable path: {e}"))?;

    if is_in_temp_dir(&canonical) {
        return Err(format!(
            "Executable path must not be located in a temporary directory: {}",
            canonical.display()
        ));
    }

    Ok(canonical)
}

/// Validate MCP config JSON, including stdio command paths and remote URLs.
pub fn validate_mcp_config_json(value: &Value) -> Result<(), String> {
    let servers = value
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| "MCP config must contain an object at mcpServers".to_string())?;

    for (name, server) in servers {
        let transport = server
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("stdio");

        match transport {
            "http" | "sse" => {
                let url = server
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("MCP server '{name}' is missing url"))?;
                validate_http_external_url(url)?;
            }
            _ => {
                if let Some(command) = server.get("command").and_then(Value::as_str) {
                    validate_mcp_command_path(name, command)?;
                }
            }
        }
    }

    Ok(())
}

fn validate_mcp_command_path(server_name: &str, command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(format!("MCP server '{server_name}' has an empty command"));
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        validate_executable_path(path).map(|_| ())?;
    }

    Ok(())
}

fn is_unc_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let lower = text.to_ascii_lowercase();
    lower.starts_with(r"\\?\unc\")
        || lower.starts_with(r"\\.\")
        || (lower.starts_with(r"\\") && !lower.starts_with(r"\\?\"))
}

fn is_in_temp_dir(path: &Path) -> bool {
    let Ok(canonical) = path.canonicalize() else {
        return false;
    };

    if let Ok(temp_dir) = std::env::temp_dir().canonicalize() {
        if canonical.starts_with(&temp_dir) {
            return true;
        }
    }

    for var in ["TEMP", "TMP", "TMPDIR"] {
        if let Ok(dir) = std::env::var(var) {
            if let Ok(temp_path) = PathBuf::from(dir).canonicalize() {
                if canonical.starts_with(&temp_path) {
                    return true;
                }
            }
        }
    }

    if let Some(path_str) = canonical.to_str() {
        if path_str.contains("/var/folders/") || path_str.starts_with("/tmp/") {
            return true;
        }
    }

    false
}

/// Resolve a user-supplied session-file path (absolute or workspace-relative)
/// against the canonical session workspace root. Any path that escapes above
/// the workspace root — lexically, canonically, or via a dangling symlink — is
/// rejected. Moved here from `the pre-cutover ACP translation module` during the M4 cutover; the
/// ACP copy stays until W3 deletes the ACP modules.
pub fn normalize_workspace_path(raw: &str, workspace: &Path) -> Result<PathBuf, String> {
    let workspace_root = std::fs::canonicalize(workspace).map_err(|err| {
        format!(
            "Session workspace `{}` is not accessible: {err}",
            workspace.display()
        )
    })?;

    let logical = if Path::new(raw).is_absolute() {
        normalize_path(Path::new(raw))
    } else {
        normalize_path(&workspace_root.join(raw))
    };

    ensure_path_under_workspace(logical, &workspace_root)
}

fn ensure_path_under_workspace(logical: PathBuf, workspace_root: &Path) -> Result<PathBuf, String> {
    if logical.exists() {
        let canonical = std::fs::canonicalize(&logical)
            .map_err(|err| format!("Path `{}` could not be resolved: {err}", logical.display()))?;
        return ensure_canonical_within_workspace(&canonical, workspace_root);
    }

    let mut ancestor = logical.clone();
    let mut suffix = PathBuf::new();
    while !ancestor.exists() {
        let file_name = ancestor
            .file_name()
            .ok_or_else(|| format!("Path `{}` is invalid", logical.display()))?;
        suffix = Path::new(file_name).join(suffix);
        if !ancestor.pop() {
            ancestor = workspace_root.to_path_buf();
            break;
        }
    }

    let canonical_ancestor = std::fs::canonicalize(&ancestor)
        .map_err(|err| format!("Path `{}` could not be resolved: {err}", logical.display()))?;
    ensure_canonical_within_workspace(&canonical_ancestor, workspace_root)?;
    Ok(canonical_ancestor.join(suffix))
}

fn ensure_canonical_within_workspace(
    path: &Path,
    workspace_root: &Path,
) -> Result<PathBuf, String> {
    if path.starts_with(workspace_root) {
        Ok(path.to_path_buf())
    } else {
        Err(format!(
            "Path `{}` is outside the session workspace `{}`",
            path.display(),
            workspace_root.display()
        ))
    }
}

/// Lexically normalize `..`/`.` components without touching the filesystem.
fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn accepts_http_and_https_urls() {
        validate_http_external_url("https://example.com/path").unwrap();
        validate_http_external_url("http://127.0.0.1:1420").unwrap();
    }

    #[test]
    fn rejects_non_http_external_urls() {
        assert!(validate_http_external_url("file:///etc/passwd").is_err());
        assert!(validate_http_external_url("javascript:alert(1)").is_err());
        assert!(validate_http_external_url("").is_err());
    }

    #[test]
    fn validates_local_absolute_path_for_existing_file() {
        let dir = TempDir::new().expect("tempdir");
        let file = dir.path().join("note.txt");
        std::fs::write(&file, b"hello").expect("write file");
        let validated = validate_local_absolute_path(&file.to_string_lossy()).expect("valid path");
        assert!(validated.is_file());
    }

    #[test]
    fn rejects_relative_and_parent_paths() {
        assert!(validate_local_absolute_path("relative/path").is_err());
        assert!(validate_local_absolute_path("/tmp/../etc/passwd").is_err());
        assert!(validate_local_write_path("relative/out.md").is_err());
        assert!(validate_local_write_path("/tmp/../etc/out.md").is_err());
    }

    #[test]
    fn accepts_absolute_write_paths_without_existing_file() {
        #[cfg(unix)]
        assert!(validate_local_write_path("/tmp/kimi-export-test.md").is_ok());
        #[cfg(windows)]
        assert!(validate_local_write_path(r"C:\Temp\kimi-export-test.md").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn detects_verbatim_unc_and_device_paths() {
        assert!(is_unc_path(Path::new(r"\\?\UNC\server\share\kimi.exe")));
        assert!(is_unc_path(Path::new(r"\\.\pipe\kimi")));
        assert!(!is_unc_path(Path::new(
            r"\\?\C:\Program Files\Kimi\kimi.exe"
        )));
    }

    #[test]
    fn validates_mcp_stdio_absolute_command() {
        let _dir = TempDir::new().expect("tempdir");
        let parent = std::env::current_dir().expect("cwd");
        let exe = parent.join("security-test-mcp-server.exe");
        std::fs::write(&exe, b"fake").expect("write exe");

        let config = json!({
            "mcpServers": {
                "local": { "command": exe.to_string_lossy() }
            }
        });
        let result = validate_mcp_config_json(&config);
        let _ = std::fs::remove_file(&exe);
        result.expect("absolute command outside temp should pass");
    }

    #[test]
    fn allows_mcp_stdio_command_on_path() {
        let config = json!({
            "mcpServers": {
                "local": { "command": "node", "args": ["server.mjs"] }
            }
        });
        validate_mcp_config_json(&config).expect("PATH command should pass");
    }

    #[test]
    fn validates_mcp_http_url_scheme() {
        let config = json!({
            "mcpServers": {
                "remote": {
                    "transport": "http",
                    "url": "https://example.com/mcp"
                }
            }
        });
        validate_mcp_config_json(&config).expect("https MCP url should pass");

        let bad = json!({
            "mcpServers": {
                "remote": {
                    "transport": "http",
                    "url": "file:///etc/passwd"
                }
            }
        });
        assert!(validate_mcp_config_json(&bad).is_err());
    }

    #[test]
    fn normalize_workspace_path_resolves_relative_inside_workspace() {
        let dir = TempDir::new().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("sub")).expect("nested dir");
        std::fs::write(dir.path().join("sub/note.md"), b"hello").expect("file");

        let resolved = normalize_workspace_path("sub/note.md", dir.path()).expect("relative path");
        assert_eq!(
            resolved,
            dir.path().join("sub/note.md").canonicalize().unwrap()
        );
    }

    #[test]
    fn normalize_workspace_path_accepts_absolute_inside_workspace() {
        let dir = TempDir::new().expect("tempdir");
        std::fs::write(dir.path().join("a.txt"), b"a").expect("file");

        let target = dir.path().join("a.txt").canonicalize().unwrap();
        let resolved =
            normalize_workspace_path(&target.to_string_lossy(), dir.path()).expect("absolute");
        assert_eq!(resolved, target);
    }

    #[test]
    fn normalize_workspace_path_rejects_escape_via_parent_components() {
        let dir = TempDir::new().expect("tempdir");
        let sep = std::path::MAIN_SEPARATOR;
        let err = normalize_workspace_path(&format!("..{sep}..{sep}etc{sep}passwd"), dir.path())
            .expect_err("escape must be rejected");
        assert!(err.contains("outside"));
    }

    #[cfg(unix)]
    #[test]
    fn normalize_workspace_path_rejects_symlink_escape() {
        let dir = TempDir::new().expect("tempdir");
        let outside = TempDir::new().expect("outside dir");
        std::fs::write(outside.path().join("secret.txt"), b"secret").expect("secret file");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).expect("symlink");
        let err = normalize_workspace_path("link/secret.txt", dir.path())
            .expect_err("symlink escape must be rejected");
        assert!(err.contains("outside"));
    }

    #[test]
    fn normalize_workspace_path_resolves_not_yet_created_file() {
        let dir = TempDir::new().expect("tempdir");
        let resolved = normalize_workspace_path("new/nested/file.txt", dir.path())
            .expect("dangling path stays inside the workspace");
        assert!(resolved.starts_with(dir.path().canonicalize().unwrap()));
        assert!(resolved.ends_with("file.txt"));
    }
}
