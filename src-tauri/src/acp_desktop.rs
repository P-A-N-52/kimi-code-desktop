//! Shared long-lived `kimi acp` subprocess for non-wire Tauri commands.

use crate::acp::{
    ensure_acp_authenticated, spawn_acp_probe_worker, AcpRpcSession, AcpWorker, JsonRpcResponse,
};
use crate::mcp_config;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

pub fn shape_acp_session_to_legacy(acp: &Value) -> Value {
    json!({
        "session_id": acp.get("sessionId").and_then(Value::as_str).unwrap_or(""),
        "title": acp.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
        "work_dir": acp.get("cwd").and_then(Value::as_str),
        "last_updated": acp.get("updatedAt").cloned().unwrap_or(Value::Null),
        "archived": acp.get("archived").and_then(Value::as_bool).unwrap_or(false),
    })
}

pub fn session_list_params(
    _limit: u64,
    _offset: u64,
    _q: Option<&str>,
    _archived: Option<bool>,
) -> Value {
    json!({})
}

pub fn session_new_params(work_dir: &str, _resume: bool) -> Value {
    json!({
        "cwd": work_dir,
        "mcpServers": mcp_config::mcp_servers_for_acp(),
    })
}

pub fn filter_sessions(
    sessions: Vec<Value>,
    q: Option<&str>,
    archived: Option<bool>,
) -> Vec<Value> {
    sessions
        .into_iter()
        .filter(|session| {
            if let Some(archived_filter) = archived {
                let session_archived = session
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if session_archived != archived_filter {
                    return false;
                }
            }
            if let Some(query) = q {
                let query = query.to_ascii_lowercase();
                let title = session
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !title.contains(&query) {
                    return false;
                }
            }
            true
        })
        .collect()
}

pub fn find_session_in_list(sessions: &[Value], session_id: &str) -> Option<Value> {
    sessions
        .iter()
        .find(|item| item.get("sessionId").and_then(Value::as_str) == Some(session_id))
        .cloned()
}

struct DesktopAcpSession {
    _worker: Arc<AcpWorker>,
    rpc: AcpRpcSession,
}

pub struct AcpDesktopClient {
    inner: Mutex<Option<DesktopAcpSession>>,
}

impl AcpDesktopClient {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub async fn request(
        &self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> Result<JsonRpcResponse, String> {
        let mut guard = self.inner.lock().await;
        if guard
            .as_ref()
            .map_or(true, |session| !session.rpc.is_alive())
        {
            let (mut rpc, worker) = spawn_acp_probe_worker(app)?;
            if let Err(err) = ensure_acp_authenticated(&mut rpc).await {
                let _ = rpc.shutdown();
                return Err(err);
            }
            *guard = Some(DesktopAcpSession {
                _worker: worker,
                rpc,
            });
        }
        let result = guard.as_mut().unwrap().rpc.request(method, params).await;
        if result.is_err() {
            if let Some(session) = guard.take() {
                let _ = session.rpc.shutdown();
            }
        }
        result
    }
}

impl Default for AcpDesktopClient {
    fn default() -> Self {
        Self::new()
    }
}

pub async fn fetch_all_acp_sessions(
    client: &AcpDesktopClient,
    app: &AppHandle,
) -> Result<Vec<Value>, String> {
    const MAX_ACP_SESSION_PAGES: usize = 100;
    const MAX_ACP_SESSIONS: usize = 10_000;

    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    let mut page_count = 0usize;

    loop {
        page_count += 1;
        if page_count > MAX_ACP_SESSION_PAGES {
            return Err(format!(
                "ACP session/list exceeded maximum page count ({MAX_ACP_SESSION_PAGES})"
            ));
        }

        let params = match cursor.as_ref() {
            Some(cursor) => json!({ "cursor": cursor }),
            None => json!({}),
        };
        let response = client.request(app, "session/list", params).await?;
        if response.error.is_some() {
            return Err(format!(
                "ACP session/list failed: {}",
                response
                    .error
                    .as_ref()
                    .and_then(|error| error.message.clone())
                    .unwrap_or_else(|| "unknown error".to_string())
            ));
        }

        let result = response.result.unwrap_or(Value::Null);
        if let Some(sessions) = result.get("sessions").and_then(Value::as_array) {
            all.extend(sessions.iter().cloned());
        }

        if all.len() > MAX_ACP_SESSIONS {
            return Err(format!(
                "ACP session/list exceeded maximum session count ({MAX_ACP_SESSIONS})"
            ));
        }

        cursor = result.get("nextCursor").and_then(|value| {
            if value.is_null() {
                None
            } else {
                value.as_str().map(str::to_string)
            }
        });
        if cursor.is_none() {
            break;
        }
    }

    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shape_acp_session_to_legacy_maps_fields() {
        let acp = json!({
            "sessionId": "id-1",
            "title": "My chat",
            "cwd": "C:\\proj",
            "updatedAt": "2026-07-08T12:00:00Z"
        });
        let legacy = shape_acp_session_to_legacy(&acp);
        assert_eq!(legacy["session_id"], "id-1");
        assert_eq!(legacy["title"], "My chat");
        assert_eq!(legacy["work_dir"], "C:\\proj");
    }

    #[test]
    fn desktop_client_builds_session_list_params() {
        let params = session_list_params(100, 0, None, None);
        assert_eq!(params, json!({}));
    }

    #[test]
    fn filter_sessions_by_query_matches_title() {
        let sessions = vec![
            shape_acp_session_to_legacy(&json!({"sessionId":"1","title":"Alpha","cwd":"/a"})),
            shape_acp_session_to_legacy(&json!({"sessionId":"2","title":"Beta","cwd":"/b"})),
        ];
        let filtered = filter_sessions(sessions, Some("alp"), None);
        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn find_session_in_list_returns_match() {
        let sessions = vec![
            json!({"sessionId":"1","title":"Alpha"}),
            json!({"sessionId":"2","title":"Beta"}),
        ];
        let found = find_session_in_list(&sessions, "2").expect("found");
        assert_eq!(found["title"], "Beta");
    }

    #[test]
    fn create_session_params_include_cwd() {
        let p = session_new_params(r"C:\proj", false);
        assert_eq!(p["cwd"], "C:\\proj");
    }
}
