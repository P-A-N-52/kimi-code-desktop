//! Read `~/.kimi-code/mcp.json` and convert `mcpServers` to the ACP array shape.

use crate::runtime_check;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

pub fn mcp_config_path() -> Result<PathBuf, String> {
    Ok(runtime_check::kimi_code_home_dir()?.join("mcp.json"))
}

pub fn load_mcp_config_json() -> Result<Value, String> {
    let path = mcp_config_path()?;
    if !path.exists() {
        return Ok(json!({ "mcpServers": {} }));
    }

    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&content).map_err(|e| format!("Invalid MCP config JSON: {}", e))
}

pub fn mcp_servers_for_acp() -> Vec<Value> {
    match load_mcp_config_json().map(|config| convert_mcp_servers_to_acp(&config)) {
        Ok(servers) => servers,
        Err(err) => {
            eprintln!("[WARN] Failed to load MCP config: {err}");
            Vec::new()
        }
    }
}

fn convert_mcp_servers_to_acp(config: &Value) -> Vec<Value> {
    let Some(servers) = config.get("mcpServers").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for (name, server_config) in servers {
        if !is_server_enabled(server_config) {
            continue;
        }
        if let Some(acp_server) = convert_single_server(name, server_config) {
            result.push(acp_server);
        }
    }
    result
}

fn is_server_enabled(config: &Value) -> bool {
    if config.get("disabled").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if config.get("enabled").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    true
}

fn convert_single_server(name: &str, config: &Value) -> Option<Value> {
    let transport = config
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("stdio");

    match transport {
        "http" => {
            let url = config.get("url").and_then(Value::as_str)?;
            let mut server = json!({
                "type": "http",
                "name": name,
                "url": url,
                "headers": config.get("headers").cloned().unwrap_or(json!([])),
            });
            if let Some(env) = config.get("env") {
                if let Some(obj) = server.as_object_mut() {
                    obj.insert("env".to_string(), env.clone());
                }
            }
            Some(server)
        }
        "sse" => {
            let url = config.get("url").and_then(Value::as_str)?;
            let mut server = json!({
                "type": "sse",
                "name": name,
                "url": url,
                "headers": config.get("headers").cloned().unwrap_or(json!([])),
            });
            if let Some(env) = config.get("env") {
                if let Some(obj) = server.as_object_mut() {
                    obj.insert("env".to_string(), env.clone());
                }
            }
            Some(server)
        }
        _ => {
            let command = config.get("command").and_then(Value::as_str)?;
            let server = json!({
                "name": name,
                "command": command,
                "args": config.get("args").cloned().unwrap_or(json!([])),
                "env": config.get("env").cloned().unwrap_or(json!([])),
            });
            Some(server)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn write_fixture(dir: &TempDir, content: &str) -> PathBuf {
        let path = dir.path().join("mcp.json");
        let mut file = std::fs::File::create(&path).expect("create fixture");
        file.write_all(content.as_bytes()).expect("write fixture");
        path
    }

    #[test]
    fn converts_stdio_servers_to_acp_shape() {
        let config = json!({
            "mcpServers": {
                "local": {
                    "command": "node",
                    "args": ["server.mjs"],
                    "transport": "stdio"
                }
            }
        });
        let servers = convert_mcp_servers_to_acp(&config);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "local");
        assert_eq!(servers[0]["command"], "node");
        assert_eq!(servers[0]["args"], json!(["server.mjs"]));
    }

    #[test]
    fn skips_disabled_servers() {
        let config = json!({
            "mcpServers": {
                "enabled": { "command": "node" },
                "disabled": { "command": "node", "disabled": true },
                "off": { "command": "node", "enabled": false }
            }
        });
        let servers = convert_mcp_servers_to_acp(&config);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "enabled");
    }

    #[test]
    fn converts_http_transport_servers() {
        let config = json!({
            "mcpServers": {
                "remote": {
                    "transport": "http",
                    "url": "https://example.com/mcp",
                    "headers": [{ "name": "Authorization", "value": "token" }]
                }
            }
        });
        let servers = convert_mcp_servers_to_acp(&config);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["type"], "http");
        assert_eq!(servers[0]["name"], "remote");
        assert_eq!(servers[0]["url"], "https://example.com/mcp");
    }

    #[test]
    fn loads_test_fixture_mcp_json() {
        let content = include_str!("test-fixtures/mcp.json");
        let config: Value = serde_json::from_str(content).expect("parse fixture");
        let servers = convert_mcp_servers_to_acp(&config);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "codex_mcp_smoke");
        assert_eq!(servers[0]["command"], "node");
    }

    #[test]
    fn loads_fixture_mcp_json_from_disk() {
        let dir = TempDir::new().expect("tempdir");
        write_fixture(
            &dir,
            r#"{
  "mcpServers": {
    "codex_mcp_smoke": {
      "command": "node",
      "args": ["server.mjs"],
      "transport": "stdio"
    }
  }
}"#,
        );

        let content = fs::read_to_string(dir.path().join("mcp.json")).expect("read fixture");
        let config: Value = serde_json::from_str(&content).expect("parse fixture");
        let servers = convert_mcp_servers_to_acp(&config);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "codex_mcp_smoke");
        assert_eq!(servers[0]["command"], "node");
    }

    #[test]
    fn empty_mcp_servers_returns_empty_array() {
        let config = json!({ "mcpServers": {} });
        assert!(convert_mcp_servers_to_acp(&config).is_empty());
    }
}
