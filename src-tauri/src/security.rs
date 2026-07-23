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

/// Validate an explicit `KIMI_CODE_BIN` path before launching the CLI.
pub fn validate_kimi_code_bin_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("KIMI_CODE_BIN must not be empty".to_string());
    }

    let path_obj = Path::new(trimmed);
    if !path_obj.is_absolute() {
        return Err("KIMI_CODE_BIN must be an absolute path".to_string());
    }

    validate_executable_path(path_obj)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
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
    fn rejects_relative_kimi_code_bin() {
        assert!(validate_kimi_code_bin_path("kimi").is_err());
        assert!(validate_kimi_code_bin_path("./kimi").is_err());
    }

    #[test]
    fn rejects_temp_kimi_code_bin() {
        let dir = TempDir::new().expect("tempdir");
        let exe = dir.path().join("kimi.exe");
        std::fs::write(&exe, b"fake").expect("write fake exe");
        let err = validate_kimi_code_bin_path(&exe.to_string_lossy()).expect_err("temp exe");
        assert!(err.contains("temporary"));
    }

    #[test]
    fn accepts_regular_file_outside_temp() {
        let parent = std::env::current_dir().expect("cwd");
        let exe = parent.join("security-test-kimi-bin.exe");
        let mut file = std::fs::File::create(&exe).expect("create exe");
        file.write_all(b"fake").expect("write exe");

        let result = validate_kimi_code_bin_path(&exe.to_string_lossy());
        let _ = std::fs::remove_file(&exe);
        result.expect("regular file outside temp should be accepted");
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
}
