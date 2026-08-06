use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(150);
const HYDRATION_POLL_INTERVAL: Duration = Duration::from_millis(100);
const HYDRATION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwarmProgressEvent {
    Started {
        agent_id: String,
        item: String,
        index: usize,
        parent_agent_id: Option<String>,
        depth: usize,
    },
    Activity {
        agent_id: String,
        activity: String,
    },
    Completed {
        agent_id: String,
        item: String,
        index: usize,
        failed: bool,
        reason: String,
    },
}

#[derive(Debug, Clone)]
struct AgentMetadata {
    id: String,
    item: String,
    parent_id: String,
    explicit_swarm_item: bool,
}

#[derive(Debug)]
struct AgentWatch {
    item: String,
    index: usize,
    depth: usize,
    wire: JsonlCursor,
    completed: bool,
}

#[derive(Debug, Default)]
struct JsonlCursor {
    offset: u64,
    partial: Vec<u8>,
}

impl JsonlCursor {
    /// Read only bytes appended since the previous poll. If the file was
    /// truncated, restart at byte zero so a replacement wire is not skipped.
    fn read_new_records(&mut self, path: &Path) -> Vec<Value> {
        let Ok(mut file) = File::open(path) else {
            return Vec::new();
        };
        let Ok(metadata) = file.metadata() else {
            return Vec::new();
        };
        if metadata.len() < self.offset {
            self.offset = 0;
            self.partial.clear();
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }

        let mut appended = Vec::new();
        if file.read_to_end(&mut appended).is_err() {
            return Vec::new();
        }
        self.offset = self.offset.saturating_add(appended.len() as u64);
        self.partial.extend_from_slice(&appended);

        let mut records = Vec::new();
        let mut consumed = 0;
        for (index, byte) in self.partial.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            if let Some(record) = parse_jsonl_record(&self.partial[consumed..index]) {
                records.push(record);
            }
            consumed = index + 1;
        }
        if consumed > 0 {
            self.partial.drain(..consumed);
        }

        // Kimi normally writes LF-delimited records, while accepting a valid
        // final record without LF keeps replay/tests and abrupt flushes useful.
        if let Some(record) = parse_jsonl_record(&self.partial) {
            records.push(record);
            self.partial.clear();
        }
        records
    }
}

fn parse_jsonl_record(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    (!text.is_empty())
        .then(|| serde_json::from_str::<Value>(text).ok())
        .flatten()
}

type ObserverKey = (String, String);
type ObserverRegistry = HashMap<ObserverKey, Arc<AtomicBool>>;

#[derive(Debug)]
struct HydrationWatch {
    cancel: Arc<AtomicBool>,
    baseline: HashSet<String>,
}

type HydrationRegistry = HashMap<ObserverKey, HydrationWatch>;

static OBSERVERS: OnceLock<Mutex<ObserverRegistry>> = OnceLock::new();
static HYDRATIONS: OnceLock<Mutex<HydrationRegistry>> = OnceLock::new();

fn observers() -> &'static Mutex<ObserverRegistry> {
    OBSERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hydrations() -> &'static Mutex<HydrationRegistry> {
    HYDRATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn start<F>(
    session_id: String,
    parent_tool_call_id: String,
    session_dir: PathBuf,
    planned_items: Vec<String>,
    emit: F,
) where
    F: Fn(SwarmProgressEvent) + Send + Sync + 'static,
{
    let baseline = capture_baseline(&session_dir);
    start_with_baseline(
        session_id,
        parent_tool_call_id,
        session_dir,
        planned_items,
        baseline,
        emit,
    );
}

pub fn capture_baseline(session_dir: &Path) -> HashSet<String> {
    read_swarm_agents(&session_dir.join("state.json"))
        .into_iter()
        .map(|agent| agent.id)
        .collect()
}

/// Wait briefly for the native `tool.call` record that carries complete Swarm
/// arguments. The main wire is scanned once, then only appended bytes are
/// read. Registration makes the wait cancellable by a terminal tool update or
/// worker shutdown before it can emit a late hydrated ToolCall.
pub fn start_input_hydration<F>(
    session_id: String,
    tool_call_id: String,
    session_dir: PathBuf,
    emit: F,
) where
    F: FnOnce(Value, HashSet<String>) + Send + 'static,
{
    let key = (session_id, tool_call_id.clone());
    let cancel = Arc::new(AtomicBool::new(false));
    let baseline = capture_baseline(&session_dir);
    if let Some(previous) = hydrations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(
            key.clone(),
            HydrationWatch {
                cancel: Arc::clone(&cancel),
                baseline: baseline.clone(),
            },
        )
    {
        previous.cancel.store(true, Ordering::SeqCst);
    }

    thread::spawn(move || {
        let wire_path = session_dir.join("agents").join("main").join("wire.jsonl");
        let started_at = Instant::now();
        let mut cursor = JsonlCursor::default();
        let mut emit = Some(emit);

        while !cancel.load(Ordering::SeqCst) && started_at.elapsed() < HYDRATION_TIMEOUT {
            let input = cursor
                .read_new_records(&wire_path)
                .into_iter()
                .rev()
                .find_map(|record| native_swarm_input_from_record(&record, &tool_call_id));
            if let Some(input) = input {
                let mut registry = hydrations()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let is_current = registry
                    .get(&key)
                    .is_some_and(|current| Arc::ptr_eq(&current.cancel, &cancel));
                if is_current && !cancel.load(Ordering::SeqCst) {
                    registry.remove(&key);
                    // Keep the registry lock through the callback. A terminal
                    // update that wins the lock cancels this callback; one
                    // that follows it therefore observes the hydration first.
                    if let Some(emit) = emit.take() {
                        emit(input, baseline);
                    }
                }
                return;
            }
            thread::sleep(HYDRATION_POLL_INTERVAL);
        }

        let mut registry = hydrations()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registry
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(&current.cancel, &cancel))
        {
            registry.remove(&key);
        }
    });
}

pub fn start_with_baseline<F>(
    session_id: String,
    parent_tool_call_id: String,
    session_dir: PathBuf,
    planned_items: Vec<String>,
    baseline: HashSet<String>,
    emit: F,
) where
    F: Fn(SwarmProgressEvent) + Send + Sync + 'static,
{
    let key = (session_id, parent_tool_call_id);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(previous) = observers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key.clone(), Arc::clone(&cancel))
    {
        previous.store(true, Ordering::SeqCst);
    }

    let emit = Arc::new(emit);
    // Capture the pre-swarm set before spawning the thread. Kimi can create
    // child agent directories within a few milliseconds of the tool call.
    thread::spawn(move || {
        observe_session_swarm(
            &session_dir,
            &planned_items,
            baseline,
            &cancel,
            emit.as_ref(),
        );
        let mut registry = observers()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registry
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &cancel))
        {
            registry.remove(&key);
        }
    });
}

pub fn stop(session_id: &str, parent_tool_call_id: &str) {
    let key = (session_id.to_string(), parent_tool_call_id.to_string());
    {
        if let Some(cancel) = observers()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key)
        {
            cancel.store(true, Ordering::SeqCst);
        }
    }
    cancel_hydration(session_id, parent_tool_call_id);
}

/// True when an observer is already registered for this swarm tool call.
/// Lets the ACP layer skip redundant starts (e.g. a rawInput-bearing
/// `tool_call_update` arriving after the `tool_call` already started one).
pub fn is_active(session_id: &str, parent_tool_call_id: &str) -> bool {
    observers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(&(session_id.to_string(), parent_tool_call_id.to_string()))
}

pub fn is_hydrating(session_id: &str, parent_tool_call_id: &str) -> bool {
    hydrations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(&(session_id.to_string(), parent_tool_call_id.to_string()))
}

/// Cancel a pending input hydration and return the baseline captured when it
/// started. Permission payloads can reuse that baseline when they provide the
/// complete input before the native wire record appears.
pub fn cancel_hydration(session_id: &str, parent_tool_call_id: &str) -> Option<HashSet<String>> {
    let key = (session_id.to_string(), parent_tool_call_id.to_string());
    let watch = hydrations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&key)?;
    watch.cancel.store(true, Ordering::SeqCst);
    Some(watch.baseline)
}

pub fn stop_session(session_id: &str) {
    {
        let mut registry = observers()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let keys = registry
            .keys()
            .filter(|(candidate, _)| candidate == session_id)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(cancel) = registry.remove(&key) {
                cancel.store(true, Ordering::SeqCst);
            }
        }
    }
    let mut registry = hydrations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let keys = registry
        .keys()
        .filter(|(candidate, _)| candidate == session_id)
        .cloned()
        .collect::<Vec<_>>();
    for key in keys {
        if let Some(watch) = registry.remove(&key) {
            watch.cancel.store(true, Ordering::SeqCst);
        }
    }
}

pub fn read_native_swarm_input(session_dir: &Path, tool_call_id: &str) -> Option<Value> {
    let wire_path = session_dir.join("agents").join("main").join("wire.jsonl");
    JsonlCursor::default()
        .read_new_records(&wire_path)
        .into_iter()
        .rev()
        .find_map(|record| native_swarm_input_from_record(&record, tool_call_id))
}

fn native_swarm_input_from_record(record: &Value, tool_call_id: &str) -> Option<Value> {
    if record.get("type").and_then(Value::as_str) != Some("context.append_loop_event") {
        return None;
    }
    let event = record.get("event")?;
    let native_id = event.get("toolCallId").and_then(Value::as_str)?;
    let matches_call = event.get("type").and_then(Value::as_str) == Some("tool.call")
        && tool_call_id_matches(tool_call_id, native_id)
        && event
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.eq_ignore_ascii_case("AgentSwarm"));
    matches_call.then(|| event.get("args").cloned().unwrap_or(Value::Null))
}

/// ACP may prefix the CLI's native tool call id (observed: `2:call_00_...` in
/// session/update vs `call_00_...` in the native wire.jsonl). Compare the
/// trailing id segment so hydration/defer can still locate the native record.
fn tool_call_id_matches(acp_id: &str, native_id: &str) -> bool {
    trailing_id_segment(acp_id) == trailing_id_segment(native_id)
}

fn trailing_id_segment(id: &str) -> &str {
    id.rsplit(':').next().unwrap_or(id)
}

pub fn read_permission_swarm_input(params: &Value) -> Option<(String, Value)> {
    let tool_call = params.get("toolCall")?;
    let tool_call_id = tool_call.get("toolCallId")?.as_str()?.to_string();

    let direct_input = ["rawInput", "input", "args"]
        .into_iter()
        .filter_map(|key| tool_call.get(key))
        .find_map(parse_swarm_input_value);
    let content_input = tool_call
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(permission_content_text)
        .find_map(parse_swarm_input_text);
    let input = direct_input.or(content_input)?;
    is_swarm_input(&input).then_some((tool_call_id, input))
}

fn parse_swarm_input_value(value: &Value) -> Option<Value> {
    if value.is_object() {
        return Some(value.clone());
    }
    value.as_str().and_then(parse_swarm_input_text)
}

fn permission_content_text(value: &Value) -> Option<&str> {
    match value.get("type").and_then(Value::as_str) {
        Some("content") => value
            .get("content")
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str),
        Some("text") => value.get("text").and_then(Value::as_str),
        _ => None,
    }
}

fn parse_swarm_input_text(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text.trim()).ok().or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        serde_json::from_str::<Value>(&text[start..=end]).ok()
    })
}

fn is_swarm_input(input: &Value) -> bool {
    let has_prompt = input.get("prompt_template").is_some()
        || input.get("promptTemplate").is_some()
        || input.get("resume_agent_ids").is_some()
        || input.get("resumeAgentIds").is_some();
    has_prompt
        && input
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
}

fn observe_session_swarm(
    session_dir: &Path,
    planned_items: &[String],
    baseline: HashSet<String>,
    cancel: &AtomicBool,
    emit: &dyn Fn(SwarmProgressEvent),
) {
    let state_path = session_dir.join("state.json");
    let mut watches = HashMap::<String, AgentWatch>::new();
    let mut assigned_indexes = HashSet::<usize>::new();

    // The CLI can create child agent directories before the ACP tool_call
    // notification reaches us, so capture_baseline may already contain the
    // agents of this very swarm. Adopt baseline agents that are still live
    // (their wire.jsonl exists and has not reached a terminal turn.ended) so
    // their intermediate progress is not skipped; agents that already ended
    // are true historical leftovers and stay excluded.
    let baseline_live = read_swarm_agents(&state_path)
        .into_iter()
        .filter(|agent| {
            baseline.contains(&agent.id) && !is_agent_terminated(session_dir, &agent.id)
        })
        .collect::<Vec<_>>();
    adopt_agents(
        &mut watches,
        &mut assigned_indexes,
        baseline_live,
        planned_items,
        emit,
    );

    while !cancel.load(Ordering::SeqCst) {
        let discovered = read_swarm_agents(&state_path)
            .into_iter()
            .filter(|agent| !baseline.contains(&agent.id) && !watches.contains_key(&agent.id))
            .collect::<Vec<_>>();
        adopt_agents(
            &mut watches,
            &mut assigned_indexes,
            discovered,
            planned_items,
            emit,
        );

        for (agent_id, watch) in &mut watches {
            if watch.completed {
                continue;
            }
            let wire_path = session_dir.join("agents").join(agent_id).join("wire.jsonl");
            let records = watch.wire.read_new_records(&wire_path);
            if records.is_empty() {
                continue;
            }

            let mut latest_activity = None;
            let mut terminal = None;
            for record in records {
                if let Some(activity) = summarize_wire_record(&record) {
                    latest_activity = Some(activity);
                }
                if record.get("type").and_then(Value::as_str) == Some("turn.ended") {
                    let reason = record
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("completed")
                        .to_string();
                    terminal = Some((reason != "completed", reason));
                }
            }

            if let Some(activity) = latest_activity {
                emit(SwarmProgressEvent::Activity {
                    agent_id: agent_id.clone(),
                    activity,
                });
            }
            if let Some((failed, reason)) = terminal {
                watch.completed = true;
                emit(SwarmProgressEvent::Completed {
                    agent_id: agent_id.clone(),
                    item: watch.item.clone(),
                    index: watch.index,
                    failed,
                    reason,
                });
            }
        }

        if !planned_items.is_empty()
            && watches.values().filter(|watch| watch.depth == 0).count() >= planned_items.len()
            && watches.values().all(|watch| watch.completed)
        {
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// Adopt newly discovered (or baseline-live) agent directories into watches,
/// emitting a `Started` event per agent. Agents whose parent is not yet watched
/// are deferred and retried once their parent appears, mirroring the nested
/// swarm ordering.
fn adopt_agents(
    watches: &mut HashMap<String, AgentWatch>,
    assigned_indexes: &mut HashSet<usize>,
    agents: Vec<AgentMetadata>,
    planned_items: &[String],
    emit: &dyn Fn(SwarmProgressEvent),
) {
    let mut discovered = agents;
    discovered.sort_by(|left, right| agent_id_order(&left.id).cmp(&agent_id_order(&right.id)));

    while !discovered.is_empty() {
        let mut deferred = Vec::new();
        let mut made_progress = false;
        for agent in discovered {
            let (index, parent_agent_id, depth) = if agent.parent_id == "main" {
                if !agent.explicit_swarm_item {
                    continue;
                }
                let Some(index) = planned_items
                    .iter()
                    .enumerate()
                    .find(|(index, item)| !assigned_indexes.contains(index) && *item == &agent.item)
                    .map(|(index, _)| index)
                else {
                    continue;
                };
                assigned_indexes.insert(index);
                (index, None, 0)
            } else if let Some(parent) = watches.get(&agent.parent_id) {
                (
                    parent.index,
                    Some(agent.parent_id.clone()),
                    parent.depth + 1,
                )
            } else {
                deferred.push(agent);
                continue;
            };
            made_progress = true;
            emit(SwarmProgressEvent::Started {
                agent_id: agent.id.clone(),
                item: agent.item.clone(),
                index,
                parent_agent_id: parent_agent_id.clone(),
                depth,
            });
            watches.insert(
                agent.id,
                AgentWatch {
                    item: agent.item,
                    index,
                    depth,
                    wire: JsonlCursor::default(),
                    completed: false,
                },
            );
        }
        if !made_progress {
            break;
        }
        discovered = deferred;
    }
}

/// True when the agent's wire.jsonl already contains a terminal `turn.ended`
/// record. A missing or empty wire.jsonl counts as live: the directory may
/// have just been created by the CLI.
fn is_agent_terminated(session_dir: &Path, agent_id: &str) -> bool {
    let Ok(content) =
        fs::read_to_string(session_dir.join("agents").join(agent_id).join("wire.jsonl"))
    else {
        return false;
    };
    content.lines().any(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .is_some_and(|record| record.get("type").and_then(Value::as_str) == Some("turn.ended"))
    })
}

fn read_swarm_agents(state_path: &Path) -> Vec<AgentMetadata> {
    let Ok(content) = fs::read_to_string(state_path) else {
        return Vec::new();
    };
    let Ok(state) = serde_json::from_str::<Value>(&content) else {
        return Vec::new();
    };
    let Some(agents) = state.get("agents").and_then(Value::as_object) else {
        return Vec::new();
    };

    agents
        .iter()
        .filter_map(|(id, agent)| {
            let labels = agent.get("labels");
            let parent = labels
                .and_then(|labels| labels.get("parentAgentId"))
                .or_else(|| agent.get("parentAgentId"))
                .and_then(Value::as_str);
            let explicit_swarm_item = agent
                .get("swarmItem")
                .or_else(|| labels.and_then(|labels| labels.get("swarmItem")))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty());
            let item = explicit_swarm_item
                .or_else(|| agent.get("description").and_then(Value::as_str))
                .or_else(|| {
                    labels
                        .and_then(|labels| labels.get("description"))
                        .and_then(Value::as_str)
                })
                .or_else(|| agent.get("name").and_then(Value::as_str))
                .unwrap_or(id);
            (id != "main" && parent.is_some()).then(|| AgentMetadata {
                id: id.clone(),
                item: item.to_string(),
                parent_id: parent.unwrap_or("main").to_string(),
                explicit_swarm_item: explicit_swarm_item.is_some(),
            })
        })
        .collect()
}

fn agent_id_order(id: &str) -> (u64, &str) {
    let number = id
        .strip_prefix("agent-")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(u64::MAX);
    (number, id)
}

fn summarize_wire_record(record: &Value) -> Option<String> {
    match record.get("type").and_then(Value::as_str)? {
        "turn.prompt" => Some("已接收任务".to_string()),
        "context.append_loop_event" => {
            let event = record.get("event")?;
            match event.get("type").and_then(Value::as_str)? {
                "step.begin" => Some("开始新步骤".to_string()),
                "content.part" => Some("正在分析".to_string()),
                "tool.call" => Some(format!(
                    "运行 {}",
                    event.get("name").and_then(Value::as_str).unwrap_or("工具")
                )),
                "tool.result" => Some("工具执行完成".to_string()),
                "step.end" => Some("步骤完成".to_string()),
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("desktop-swarm-{name}-{nonce}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn jsonl_cursor_reads_appends_once_and_recovers_after_truncation() {
        let root = temp_dir("jsonl-cursor");
        let path = root.join("wire.jsonl");
        let first = json!({ "type": "turn.prompt", "padding": "x".repeat(200) });
        let second =
            json!({ "type": "context.append_loop_event", "event": { "type": "step.begin" } });
        fs::write(&path, format!("{first}\n")).unwrap();

        let mut cursor = JsonlCursor::default();
        assert_eq!(cursor.read_new_records(&path), vec![first.clone()]);
        assert!(cursor.read_new_records(&path).is_empty());

        fs::write(&path, format!("{first}\n{second}\n")).unwrap();
        assert_eq!(cursor.read_new_records(&path), vec![second]);

        let terminal = json!({ "type": "turn.ended", "reason": "completed" });
        fs::write(&path, terminal.to_string()).unwrap();
        assert_eq!(cursor.read_new_records(&path), vec![terminal]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn hydration_reads_appended_input_and_emits_once() {
        let root = temp_dir("hydration-append");
        fs::create_dir_all(root.join("agents/main")).unwrap();
        let wire_path = root.join("agents/main/wire.jsonl");
        let metadata = json!({ "type": "metadata", "message": {} });
        fs::write(&wire_path, format!("{metadata}\n")).unwrap();

        let (tx, rx) = mpsc::channel();
        start_input_hydration(
            "session-hydration-append".to_string(),
            "2:call-swarm".to_string(),
            root.clone(),
            move |input, _baseline| tx.send(input).unwrap(),
        );
        let tool = json!({
            "type": "context.append_loop_event",
            "event": {
                "type": "tool.call",
                "toolCallId": "call-swarm",
                "name": "AgentSwarm",
                "args": { "items": ["Docs"], "prompt_template": "Review {{item}}" }
            }
        });
        fs::write(&wire_path, format!("{metadata}\n{tool}\n")).unwrap();

        let input = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(input["items"], json!(["Docs"]));
        assert!(rx.recv_timeout(HYDRATION_POLL_INTERVAL * 2).is_err());
        assert!(!is_hydrating("session-hydration-append", "2:call-swarm"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_stop_cancels_hydration_before_a_late_native_record() {
        let root = temp_dir("hydration-cancel");
        fs::create_dir_all(root.join("agents/main")).unwrap();
        let wire_path = root.join("agents/main/wire.jsonl");
        fs::write(&wire_path, "").unwrap();

        let (tx, rx) = mpsc::channel();
        start_input_hydration(
            "session-hydration-cancel".to_string(),
            "call-cancelled".to_string(),
            root.clone(),
            move |input, _baseline| tx.send(input).unwrap(),
        );
        assert!(is_hydrating("session-hydration-cancel", "call-cancelled"));
        stop("session-hydration-cancel", "call-cancelled");

        fs::write(
            &wire_path,
            format!(
                "{}\n",
                json!({
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "toolCallId": "call-cancelled",
                        "name": "AgentSwarm",
                        "args": { "items": ["Late"], "prompt_template": "Do {{item}}" }
                    }
                })
            ),
        )
        .unwrap();

        assert!(rx.recv_timeout(HYDRATION_POLL_INTERVAL * 3).is_err());
        assert!(!is_hydrating("session-hydration-cancel", "call-cancelled"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn worker_stop_cancels_every_pending_session_hydration() {
        let root = temp_dir("hydration-stop-session");
        fs::create_dir_all(root.join("agents/main")).unwrap();
        fs::write(root.join("agents/main/wire.jsonl"), "").unwrap();

        for tool_call_id in ["swarm-a", "swarm-b"] {
            start_input_hydration(
                "session-hydration-stop".to_string(),
                tool_call_id.to_string(),
                root.clone(),
                |_input, _baseline| panic!("cancelled hydration must not emit"),
            );
            assert!(is_hydrating("session-hydration-stop", tool_call_id));
        }
        stop_session("session-hydration-stop");
        assert!(!is_hydrating("session-hydration-stop", "swarm-a"));
        assert!(!is_hydrating("session-hydration-stop", "swarm-b"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_swarm_descendants_using_label_parent_precedence() {
        let root = temp_dir("state");
        fs::write(
            root.join("state.json"),
            json!({
                "agents": {
                    "main": { "type": "main" },
                    "agent-2": {
                        "parentAgentId": "main",
                        "swarmItem": "Docs"
                    },
                    "agent-3": {
                        "parentAgentId": "main",
                        "labels": {
                            "parentAgentId": "agent-2",
                            "swarmItem": "Nested"
                        }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            read_swarm_agents(&root.join("state.json"))
                .into_iter()
                .map(|agent| (agent.id, agent.item, agent.parent_id))
                .collect::<Vec<_>>(),
            vec![
                (
                    "agent-2".to_string(),
                    "Docs".to_string(),
                    "main".to_string()
                ),
                (
                    "agent-3".to_string(),
                    "Nested".to_string(),
                    "agent-2".to_string()
                )
            ]
        );
        assert_eq!(
            capture_baseline(&root),
            HashSet::from(["agent-2".to_string(), "agent-3".to_string()])
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_native_swarm_args_by_tool_call_id() {
        let root = temp_dir("native-input");
        fs::create_dir_all(root.join("agents/main")).unwrap();
        fs::write(
            root.join("agents/main/wire.jsonl"),
            [
                json!({
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "toolCallId": "other",
                        "name": "AgentSwarm",
                        "args": { "items": ["wrong"] }
                    }
                })
                .to_string(),
                json!({
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "toolCallId": "swarm-1",
                        "name": "AgentSwarm",
                        "args": { "items": ["Auth", "Docs"], "prompt_template": "Review {{item}}" }
                    }
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        assert_eq!(
            read_native_swarm_input(&root, "swarm-1").unwrap()["items"],
            json!(["Auth", "Docs"])
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_native_swarm_args_with_acp_prefixed_tool_call_id() {
        // Real shape from CLI 0.33: session/update carries "2:call_00_..." while
        // the native wire.jsonl record uses "call_00_...". Hydration must still
        // match so the progress observer starts instead of deferring forever.
        let root = temp_dir("native-input-prefix");
        fs::create_dir_all(root.join("agents/main")).unwrap();
        fs::write(
            root.join("agents/main/wire.jsonl"),
            json!({
                "type": "context.append_loop_event",
                "event": {
                    "type": "tool.call",
                    "toolCallId": "call_00_ksLloxvYq2CoxwKY7dlu9116",
                    "name": "AgentSwarm",
                    "args": {
                        "items": ["scripts", "dependencies", "devDependencies"],
                        "prompt_template": "Summarize {{item}}"
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let input = read_native_swarm_input(&root, "2:call_00_ksLloxvYq2CoxwKY7dlu9116").unwrap();
        assert_eq!(
            input["items"],
            json!(["scripts", "dependencies", "devDependencies"])
        );
        assert!(read_native_swarm_input(&root, "2:call_00_other").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_swarm_args_from_permission_content() {
        let params = json!({
            "toolCall": {
                "toolCallId": "swarm-permission",
                "title": "AgentSwarm",
                "content": [{
                    "type": "content",
                    "content": {
                        "type": "text",
                        "text": "{\"description\":\"A/B\",\"items\":[\"A\",\"B\"],\"prompt_template\":\"Do {{item}}\"}"
                    }
                }]
            }
        });

        let (tool_call_id, input) = read_permission_swarm_input(&params).unwrap();
        assert_eq!(tool_call_id, "swarm-permission");
        assert_eq!(input["items"], json!(["A", "B"]));
    }

    #[test]
    fn ignores_non_swarm_permission_json() {
        let params = json!({
            "toolCall": {
                "toolCallId": "write-permission",
                "content": [{
                    "type": "text",
                    "text": "{\"path\":\"README.md\"}"
                }]
            }
        });

        assert!(read_permission_swarm_input(&params).is_none());
    }

    #[test]
    fn emits_real_start_activity_and_completion() {
        let root = temp_dir("timeline");
        fs::create_dir_all(root.join("agents")).unwrap();
        fs::write(
            root.join("state.json"),
            json!({ "agents": { "main": {} } }).to_string(),
        )
        .unwrap();

        let (tx, rx) = mpsc::channel();
        start(
            "session-test".to_string(),
            "swarm-test".to_string(),
            root.clone(),
            vec!["Docs".to_string()],
            move |event| {
                tx.send(event).unwrap();
            },
        );

        thread::sleep(POLL_INTERVAL + Duration::from_millis(50));
        fs::create_dir_all(root.join("agents/agent-0")).unwrap();
        fs::write(
            root.join("state.json"),
            json!({
                "agents": {
                    "main": {},
                    "agent-0": {
                        "parentAgentId": "main",
                        "labels": { "swarmItem": "Docs" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("agents/agent-0/wire.jsonl"),
            [
                json!({ "type": "turn.prompt" }).to_string(),
                json!({
                    "type": "context.append_loop_event",
                    "event": { "type": "tool.call", "name": "Read" }
                })
                .to_string(),
                json!({ "type": "turn.ended", "reason": "completed" }).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let events = (0..3)
            .map(|_| rx.recv_timeout(Duration::from_secs(3)).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            events,
            vec![
                SwarmProgressEvent::Started {
                    agent_id: "agent-0".to_string(),
                    item: "Docs".to_string(),
                    index: 0,
                    parent_agent_id: None,
                    depth: 0,
                },
                SwarmProgressEvent::Activity {
                    agent_id: "agent-0".to_string(),
                    activity: "运行 Read".to_string(),
                },
                SwarmProgressEvent::Completed {
                    agent_id: "agent-0".to_string(),
                    item: "Docs".to_string(),
                    index: 0,
                    failed: false,
                    reason: "completed".to_string(),
                },
            ]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn emits_nested_agent_with_root_index_and_depth() {
        let root = temp_dir("nested-timeline");
        fs::create_dir_all(root.join("agents")).unwrap();
        fs::write(
            root.join("state.json"),
            json!({ "agents": { "main": {} } }).to_string(),
        )
        .unwrap();

        let (tx, rx) = mpsc::channel();
        start(
            "session-nested".to_string(),
            "swarm-nested".to_string(),
            root.clone(),
            vec!["Docs".to_string()],
            move |event| {
                tx.send(event).unwrap();
            },
        );

        thread::sleep(POLL_INTERVAL + Duration::from_millis(50));
        fs::write(
            root.join("state.json"),
            json!({
                "agents": {
                    "main": {},
                    "agent-0": {
                        "parentAgentId": "main",
                        "labels": { "parentAgentId": "main", "swarmItem": "Docs" }
                    },
                    "agent-1": {
                        "parentAgentId": "main",
                        "labels": { "parentAgentId": "agent-0", "swarmItem": "Nested review" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            SwarmProgressEvent::Started {
                agent_id: "agent-0".to_string(),
                item: "Docs".to_string(),
                index: 0,
                parent_agent_id: None,
                depth: 0,
            }
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            SwarmProgressEvent::Started {
                agent_id: "agent-1".to_string(),
                item: "Nested review".to_string(),
                index: 0,
                parent_agent_id: Some("agent-0".to_string()),
                depth: 1,
            }
        );
        stop("session-nested", "swarm-nested");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adopts_live_baseline_agents_so_intermediate_state_is_emitted() {
        let root = temp_dir("baseline-live");
        fs::create_dir_all(root.join("agents/agent-0")).unwrap();
        fs::write(
            root.join("state.json"),
            json!({
                "agents": {
                    "main": {},
                    "agent-0": {
                        "parentAgentId": "main",
                        "labels": { "swarmItem": "Docs" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("agents/agent-0/wire.jsonl"),
            [
                json!({ "type": "turn.prompt" }).to_string(),
                json!({
                    "type": "context.append_loop_event",
                    "event": { "type": "tool.call", "name": "Read" }
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let (tx, rx) = mpsc::channel();
        start_with_baseline(
            "session-baseline-live".to_string(),
            "swarm-baseline-live".to_string(),
            root.clone(),
            vec!["Docs".to_string()],
            HashSet::from(["agent-0".to_string()]),
            move |event| {
                tx.send(event).unwrap();
            },
        );

        // The agent was already in the baseline yet still running: the
        // observer must adopt it and emit the skipped Started state.
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            SwarmProgressEvent::Started {
                agent_id: "agent-0".to_string(),
                item: "Docs".to_string(),
                index: 0,
                parent_agent_id: None,
                depth: 0,
            }
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            SwarmProgressEvent::Activity {
                agent_id: "agent-0".to_string(),
                activity: "运行 Read".to_string(),
            }
        );

        fs::write(
            root.join("agents/agent-0/wire.jsonl"),
            [
                json!({ "type": "turn.prompt" }).to_string(),
                json!({
                    "type": "context.append_loop_event",
                    "event": { "type": "tool.call", "name": "Read" }
                })
                .to_string(),
                json!({ "type": "turn.ended", "reason": "completed" }).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            SwarmProgressEvent::Completed {
                agent_id: "agent-0".to_string(),
                item: "Docs".to_string(),
                index: 0,
                failed: false,
                reason: "completed".to_string(),
            }
        );
        stop("session-baseline-live", "swarm-baseline-live");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_finished_baseline_agents() {
        let root = temp_dir("baseline-finished");
        fs::create_dir_all(root.join("agents/agent-0")).unwrap();
        fs::write(
            root.join("state.json"),
            json!({
                "agents": {
                    "main": {},
                    "agent-0": {
                        "parentAgentId": "main",
                        "labels": { "swarmItem": "Docs" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("agents/agent-0/wire.jsonl"),
            json!({ "type": "turn.ended", "reason": "completed" }).to_string(),
        )
        .unwrap();

        let (tx, rx) = mpsc::channel();
        start_with_baseline(
            "session-baseline-finished".to_string(),
            "swarm-baseline-finished".to_string(),
            root.clone(),
            vec!["Docs".to_string()],
            HashSet::from(["agent-0".to_string()]),
            move |event| {
                tx.send(event).unwrap();
            },
        );

        // A baseline agent whose wire already terminated is a historical
        // leftover: it must not resurrect as a live swarm member.
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        stop("session-baseline-finished", "swarm-baseline-finished");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_existing_background_agents_without_matching_swarm_provenance() {
        let root = temp_dir("baseline-background");
        for agent_id in ["agent-0", "agent-1", "agent-2"] {
            fs::create_dir_all(root.join("agents").join(agent_id)).unwrap();
            fs::write(root.join("agents").join(agent_id).join("wire.jsonl"), "").unwrap();
        }
        fs::write(
            root.join("state.json"),
            json!({
                "agents": {
                    "main": {},
                    "agent-0": {
                        "parentAgentId": "main",
                        "labels": { "swarmItem": "Unrelated background task" }
                    },
                    "agent-1": {
                        "parentAgentId": "main",
                        "description": "Docs"
                    },
                    "agent-2": {
                        "parentAgentId": "main",
                        "labels": { "swarmItem": "Docs" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let baseline = capture_baseline(&root);
        let (tx, rx) = mpsc::channel();
        start_with_baseline(
            "session-baseline-background".to_string(),
            "swarm-baseline-background".to_string(),
            root.clone(),
            vec!["Docs".to_string()],
            baseline,
            move |event| tx.send(event).unwrap(),
        );

        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            SwarmProgressEvent::Started {
                agent_id: "agent-2".to_string(),
                item: "Docs".to_string(),
                index: 0,
                parent_agent_id: None,
                depth: 0,
            }
        );
        assert!(rx.recv_timeout(POLL_INTERVAL * 2).is_err());
        stop("session-baseline-background", "swarm-baseline-background");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adopts_baseline_agent_with_empty_wire_then_emits_progress() {
        let root = temp_dir("baseline-empty-wire");
        fs::create_dir_all(root.join("agents/agent-0")).unwrap();
        fs::write(
            root.join("state.json"),
            json!({
                "agents": {
                    "main": {},
                    "agent-0": {
                        "parentAgentId": "main",
                        "labels": { "swarmItem": "Auth" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        fs::write(root.join("agents/agent-0/wire.jsonl"), "").unwrap();

        let (tx, rx) = mpsc::channel();
        start_with_baseline(
            "session-baseline-empty".to_string(),
            "swarm-baseline-empty".to_string(),
            root.clone(),
            vec!["Auth".to_string()],
            HashSet::from(["agent-0".to_string()]),
            move |event| {
                tx.send(event).unwrap();
            },
        );

        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            SwarmProgressEvent::Started {
                agent_id: "agent-0".to_string(),
                item: "Auth".to_string(),
                index: 0,
                parent_agent_id: None,
                depth: 0,
            }
        );

        fs::write(
            root.join("agents/agent-0/wire.jsonl"),
            [
                json!({ "type": "turn.prompt" }).to_string(),
                json!({ "type": "turn.ended", "reason": "completed" }).to_string(),
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            SwarmProgressEvent::Activity {
                agent_id: "agent-0".to_string(),
                activity: "已接收任务".to_string(),
            }
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            SwarmProgressEvent::Completed {
                agent_id: "agent-0".to_string(),
                item: "Auth".to_string(),
                index: 0,
                failed: false,
                reason: "completed".to_string(),
            }
        );
        stop("session-baseline-empty", "swarm-baseline-empty");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adopts_all_live_baseline_agents_with_real_swarm_shape() {
        // Real shape captured from a desktop session: the CLI creates the child
        // agent directories in the same instant the ACP tool_call notification
        // is processed, so capture_baseline already contains this swarm's
        // agents while their wires are still growing.
        let root = temp_dir("baseline-real-shape");
        let items = [
            "/Users/pan/Desktop".to_string(),
            "/Users/pan/Documents".to_string(),
            "/Users/pan/Downloads".to_string(),
        ];
        let mut state = json!({ "agents": { "main": { "type": "main" } } });
        for (index, item) in items.iter().enumerate() {
            let agent_id = format!("agent-{index}");
            fs::create_dir_all(root.join("agents").join(&agent_id)).unwrap();
            fs::write(
                root.join("agents").join(&agent_id).join("wire.jsonl"),
                [
                    json!({ "type": "metadata" }).to_string(),
                    json!({ "type": "profile.bind" }).to_string(),
                    json!({ "type": "turn.prompt" }).to_string(),
                    json!({
                        "type": "context.append_loop_event",
                        "event": { "type": "step.begin" }
                    })
                    .to_string(),
                    json!({ "type": "llm.request" }).to_string(),
                ]
                .join("\n"),
            )
            .unwrap();
            state["agents"][&agent_id] = json!({
                "type": "sub",
                "parentAgentId": "main",
                "labels": { "parentAgentId": "main", "swarmItem": item }
            });
        }
        fs::write(root.join("state.json"), state.to_string()).unwrap();

        let (tx, rx) = mpsc::channel();
        start_with_baseline(
            "session-real-shape".to_string(),
            "swarm-real-shape".to_string(),
            root.clone(),
            items.to_vec(),
            HashSet::from([
                "agent-0".to_string(),
                "agent-1".to_string(),
                "agent-2".to_string(),
            ]),
            move |event| {
                tx.send(event).unwrap();
            },
        );

        // Every baseline-live agent is adopted with the correct swarm index.
        for (index, item) in items.iter().enumerate() {
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(3)).unwrap(),
                SwarmProgressEvent::Started {
                    agent_id: format!("agent-{index}"),
                    item: item.clone(),
                    index,
                    parent_agent_id: None,
                    depth: 0,
                }
            );
        }
        // Each agent's existing wire content is replayed as one Activity.
        let mut activities = Vec::new();
        for _ in 0..3 {
            activities.push(rx.recv_timeout(Duration::from_secs(3)).unwrap());
        }
        let mut activity_ids = activities
            .iter()
            .map(|event| match event {
                SwarmProgressEvent::Activity { agent_id, activity } => {
                    assert_eq!(activity.as_str(), "开始新步骤");
                    agent_id.clone()
                }
                other => panic!("expected Activity, got {other:?}"),
            })
            .collect::<Vec<_>>();
        activity_ids.sort();
        assert_eq!(activity_ids, vec!["agent-0", "agent-1", "agent-2"]);

        // Finish the agents; Completed events follow in watch order.
        for index in 0..3 {
            let path = root
                .join("agents")
                .join(format!("agent-{index}"))
                .join("wire.jsonl");
            let content = fs::read_to_string(&path).unwrap();
            fs::write(
                path,
                format!(
                    "{}\n{}\n",
                    content.trim_end(),
                    json!({ "type": "turn.ended", "reason": "completed" })
                ),
            )
            .unwrap();
        }
        let mut completed = Vec::new();
        for _ in 0..3 {
            completed.push(rx.recv_timeout(Duration::from_secs(3)).unwrap());
        }
        completed.sort_by(|a, b| format!("{a:?}").cmp(&format!("{b:?}")));
        for (index, event) in completed.iter().enumerate() {
            assert_eq!(
                event,
                &SwarmProgressEvent::Completed {
                    agent_id: format!("agent-{index}"),
                    item: items[index].clone(),
                    index,
                    failed: false,
                    reason: "completed".to_string(),
                }
            );
        }
        stop("session-real-shape", "swarm-real-shape");
        let _ = fs::remove_dir_all(root);
    }
}
