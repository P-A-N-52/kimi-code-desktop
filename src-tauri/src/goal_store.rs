//! Native Kimi Goal state helpers.
//!
//! Kimi Code ACP 0.30 does not expose Goal lifecycle RPCs or `goal.updated`
//! notifications. The CLI does persist the canonical state as `goal.*` records
//! in the session wire journal, so desktop rebuilds snapshots from that same
//! append-only source.

use crate::session_store;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static SESSION_GOAL_WIRE_WRITE_LOCK: Mutex<()> = Mutex::new(());
const JOURNAL_ANCHOR_BYTES: u64 = 4096;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn wire_jsonl_path(session_dir: &Path) -> Option<PathBuf> {
    let legacy = session_dir.join("wire.jsonl");
    if legacy.is_file() {
        return Some(legacy);
    }
    let current = session_dir.join("agents").join("main").join("wire.jsonl");
    current.is_file().then_some(current)
}

fn record_string<'a>(record: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    record
        .get(camel)
        .or_else(|| record.get(snake))
        .and_then(Value::as_str)
}

fn record_u64(record: &Value, camel: &str, snake: &str) -> Option<u64> {
    record
        .get(camel)
        .or_else(|| record.get(snake))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        })
}

fn budget_limit(record: &Value, camel: &str, snake: &str) -> Option<u64> {
    record
        .get("budgetLimits")
        .or_else(|| record.get("budget_limits"))
        .and_then(Value::as_object)
        .and_then(|limits| limits.get(camel).or_else(|| limits.get(snake)))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        })
}

fn has_budget_limit_fields(record: &Value) -> bool {
    record
        .get("budgetLimits")
        .or_else(|| record.get("budget_limits"))
        .and_then(Value::as_object)
        .is_some_and(|limits| {
            limits.contains_key("tokenBudget")
                || limits.contains_key("token_budget")
                || limits.contains_key("turnBudget")
                || limits.contains_key("turn_budget")
                || limits.contains_key("wallClockBudgetMs")
                || limits.contains_key("wall_clock_budget_ms")
        })
}

fn set_budget_limit(snapshot: &mut Value, key: &str, value: u64) {
    if let Some(limits) = snapshot
        .get_mut("budget_limits")
        .and_then(Value::as_object_mut)
    {
        limits.insert(key.to_string(), json!(value));
    }
}

fn budget_snapshot(snapshot: &Value) -> Value {
    let turns_used = snapshot
        .get("turns_used")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let tokens_used = snapshot
        .get("tokens_used")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let wall_clock_ms = snapshot
        .get("wall_clock_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let limits = snapshot.get("budget_limits").and_then(Value::as_object);
    let token_budget = limits
        .and_then(|value| value.get("token_budget"))
        .and_then(Value::as_u64);
    let turn_budget = limits
        .and_then(|value| value.get("turn_budget"))
        .and_then(Value::as_u64);
    let wall_clock_budget_ms = limits
        .and_then(|value| value.get("wall_clock_budget_ms"))
        .and_then(Value::as_u64);

    json!({
        "token_budget": token_budget,
        "turn_budget": turn_budget,
        "wall_clock_budget_ms": wall_clock_budget_ms,
        "remaining_tokens": token_budget.map(|limit| limit.saturating_sub(tokens_used)),
        "remaining_turns": turn_budget.map(|limit| limit.saturating_sub(turns_used)),
        "remaining_wall_clock_ms": wall_clock_budget_ms
            .map(|limit| limit.saturating_sub(wall_clock_ms)),
        "token_budget_reached": token_budget.is_some_and(|limit| tokens_used >= limit),
        "turn_budget_reached": turn_budget.is_some_and(|limit| turns_used >= limit),
        "wall_clock_budget_reached": wall_clock_budget_ms
            .is_some_and(|limit| wall_clock_ms >= limit),
        "over_budget": token_budget.is_some_and(|limit| tokens_used >= limit)
            || turn_budget.is_some_and(|limit| turns_used >= limit)
            || wall_clock_budget_ms.is_some_and(|limit| wall_clock_ms >= limit),
    })
}

fn public_snapshot(snapshot: &Option<Value>) -> Option<Value> {
    let mut snapshot = snapshot.clone();
    if let Some(current) = snapshot.as_mut() {
        current["budget"] = budget_snapshot(current);
        if let Some(value) = current.as_object_mut() {
            value.remove("budget_limits");
        }
    }
    snapshot
}

fn apply_record(snapshot: &mut Option<Value>, record: &Value) {
    match record.get("type").and_then(Value::as_str) {
        Some("goal.create") => {
            let Some(objective) = record_string(record, "objective", "objective").map(str::trim)
            else {
                return;
            };
            if objective.is_empty() {
                return;
            }
            let mut next = json!({
                "goal_id": record_string(record, "goalId", "goal_id"),
                "objective": objective,
                "completion_criterion":
                    record_string(record, "completionCriterion", "completion_criterion"),
                "status": "active",
                "turns_used": 0,
                "tokens_used": 0,
                "wall_clock_ms": 0,
                "terminal_reason": Value::Null,
                "budget_limits": {},
            });
            if let Some(value) = budget_limit(record, "tokenBudget", "token_budget") {
                set_budget_limit(&mut next, "token_budget", value);
            }
            if let Some(value) = budget_limit(record, "turnBudget", "turn_budget") {
                set_budget_limit(&mut next, "turn_budget", value);
            }
            if let Some(value) = budget_limit(record, "wallClockBudgetMs", "wall_clock_budget_ms") {
                set_budget_limit(&mut next, "wall_clock_budget_ms", value);
            }
            *snapshot = Some(next);
        }
        Some("goal.update") => {
            let Some(current) = snapshot.as_mut() else {
                return;
            };
            if let Some(status) = record_string(record, "status", "status") {
                if matches!(status, "active" | "paused" | "blocked" | "complete") {
                    current["status"] = json!(status);
                    current["terminal_reason"] = if status == "active" {
                        Value::Null
                    } else {
                        record_string(record, "reason", "reason")
                            .map(|reason| json!(reason))
                            .unwrap_or(Value::Null)
                    };
                }
            }
            if let Some(value) = record_u64(record, "turnsUsed", "turns_used") {
                current["turns_used"] = json!(value);
            }
            if let Some(value) = record_u64(record, "tokensUsed", "tokens_used") {
                current["tokens_used"] = json!(value);
            }
            if let Some(value) = record_u64(record, "wallClockMs", "wall_clock_ms") {
                current["wall_clock_ms"] = json!(value);
            }
            if let Some(value) = budget_limit(record, "tokenBudget", "token_budget") {
                set_budget_limit(current, "token_budget", value);
            }
            if let Some(value) = budget_limit(record, "turnBudget", "turn_budget") {
                set_budget_limit(current, "turn_budget", value);
            }
            if let Some(value) = budget_limit(record, "wallClockBudgetMs", "wall_clock_budget_ms") {
                set_budget_limit(current, "wall_clock_budget_ms", value);
            }
        }
        Some("goal.clear") => *snapshot = None,
        _ => {}
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GoalJournalPoll {
    /// The journal advanced, or truncation invalidated the reconstructed state.
    pub changed: bool,
    /// Raw bytes read during this poll, including non-Goal and partial records.
    pub read_bytes: u64,
    /// The cursor moved or the journal was truncated.
    pub advanced: bool,
    /// Absolute byte offset immediately after the latest complete line.
    pub last_complete_offset: u64,
    /// Monotonic index of the latest valid JSON record consumed by this cursor.
    pub last_record_index: u64,
    /// Bytes exist after the latest newline and may form a not-yet-complete record.
    pub has_pending_line: bool,
    pub last_goal_terminal_record: Option<u64>,
    pub last_goal_terminal_status: Option<String>,
    pub last_goal_terminal_goal_id: Option<String>,
    pub last_goal_terminal_requires_closed_step: bool,
    pub last_goal_create_record: Option<u64>,
    pub last_goal_create_id: Option<String>,
    pub last_goal_active_record: Option<u64>,
    pub last_goal_active_id: Option<String>,
    pub last_budget_limits_record: Option<u64>,
    pub last_budget_limits_update_record: Option<u64>,
    pub last_budget_limits_goal_id: Option<String>,
    pub last_step_begin_record: Option<u64>,
    pub last_step_end_record: Option<u64>,
    pub last_turn_ended_record: Option<u64>,
    pub saw_goal_record: bool,
    /// A native `goal.create` or `goal.update` carried applied budget limits.
    pub saw_budget_limits: bool,
    /// Specifically a `goal.update` carried applied budget limits.
    pub saw_budget_limits_update: bool,
    pub saw_create: bool,
    pub saw_active: bool,
    pub saw_paused: bool,
    pub saw_blocked: bool,
    pub saw_complete: bool,
    pub saw_clear: bool,
    pub saw_turn_ended: bool,
    pub saw_step_end: bool,
    pub saw_loop_event: bool,
    pub saw_loop_lifecycle: bool,
    pub truncated: bool,
    pub replaced: bool,
}

impl GoalJournalPoll {
    fn observe(&mut self, record: &Value, record_index: u64, current_goal_id: Option<&str>) {
        let record_type = record.get("type").and_then(Value::as_str);
        let loop_event = (record_type == Some("context.append_loop_event"))
            .then(|| record.get("event"))
            .flatten();
        let event_type = loop_event
            .and_then(|event| event.get("type"))
            .and_then(Value::as_str);
        let finish_reason = loop_event
            .and_then(|event| {
                event
                    .get("finishReason")
                    .or_else(|| event.get("finish_reason"))
            })
            .and_then(Value::as_str);
        let lifecycle_type = event_type.or(record_type);
        let ended_turn = matches!(lifecycle_type, Some("turn.ended" | "turn.end"))
            || (lifecycle_type == Some("step.end") && finish_reason == Some("end_turn"));
        self.saw_loop_event |= event_type.is_some();
        self.saw_turn_ended |= ended_turn;
        self.saw_step_end |= lifecycle_type == Some("step.end");
        self.saw_loop_lifecycle |= lifecycle_type.is_some_and(|kind| kind.starts_with("loop."));
        if lifecycle_type == Some("step.begin") {
            self.last_step_begin_record = Some(record_index);
        }
        if lifecycle_type == Some("step.end") {
            self.last_step_end_record = Some(record_index);
        }
        if ended_turn {
            self.last_turn_ended_record = Some(record_index);
        }

        let has_budget_limits = has_budget_limit_fields(record)
            && matches!(record_type, Some("goal.create" | "goal.update"));
        if has_budget_limits {
            let budget_goal_id = record_string(record, "goalId", "goal_id")
                .or(current_goal_id)
                .map(str::to_string);
            self.saw_budget_limits = true;
            if record_type == Some("goal.update") {
                self.saw_budget_limits_update = true;
                self.last_budget_limits_update_record = Some(record_index);
            }
            self.last_budget_limits_record = Some(record_index);
            self.last_budget_limits_goal_id = budget_goal_id;
        }

        match record_type {
            Some("goal.create") => {
                let goal_id = record_string(record, "goalId", "goal_id").map(str::to_string);
                self.saw_goal_record = true;
                self.saw_create = true;
                self.saw_active = true;
                self.last_goal_create_record = Some(record_index);
                self.last_goal_create_id = goal_id.clone();
                self.last_goal_active_record = Some(record_index);
                self.last_goal_active_id = goal_id;
                self.last_goal_terminal_record = None;
                self.last_goal_terminal_status = None;
                self.last_goal_terminal_goal_id = None;
                self.last_goal_terminal_requires_closed_step = false;
            }
            Some("goal.update") => {
                let goal_id = record_string(record, "goalId", "goal_id")
                    .or(current_goal_id)
                    .map(str::to_string);
                self.saw_goal_record = true;
                match record_string(record, "status", "status") {
                    Some("active") => {
                        self.saw_active = true;
                        self.last_goal_active_record = Some(record_index);
                        self.last_goal_active_id = goal_id;
                        self.last_goal_terminal_record = None;
                        self.last_goal_terminal_status = None;
                        self.last_goal_terminal_goal_id = None;
                        self.last_goal_terminal_requires_closed_step = false;
                    }
                    Some("paused") => {
                        self.saw_paused = true;
                        self.last_goal_terminal_record = Some(record_index);
                        self.last_goal_terminal_status = Some("paused".to_string());
                        self.last_goal_terminal_goal_id = goal_id;
                        self.last_goal_terminal_requires_closed_step = false;
                    }
                    Some("blocked") => {
                        self.saw_blocked = true;
                        self.last_goal_terminal_record = Some(record_index);
                        self.last_goal_terminal_status = Some("blocked".to_string());
                        self.last_goal_terminal_goal_id = goal_id;
                        self.last_goal_terminal_requires_closed_step = false;
                    }
                    Some("complete") => {
                        self.saw_complete = true;
                        self.last_goal_terminal_record = Some(record_index);
                        self.last_goal_terminal_status = Some("complete".to_string());
                        self.last_goal_terminal_goal_id = goal_id;
                        self.last_goal_terminal_requires_closed_step = true;
                    }
                    _ => {}
                }
            }
            Some("goal.clear") => {
                let goal_id = record_string(record, "goalId", "goal_id")
                    .or(current_goal_id)
                    .map(str::to_string);
                let follows_complete = self.last_goal_terminal_status.as_deref()
                    == Some("complete")
                    && self.last_goal_terminal_goal_id.as_deref() == goal_id.as_deref();
                self.saw_goal_record = true;
                self.saw_clear = true;
                self.last_goal_terminal_record = Some(record_index);
                self.last_goal_terminal_status = Some("clear".to_string());
                self.last_goal_terminal_goal_id = goal_id;
                self.last_goal_terminal_requires_closed_step = follows_complete;
            }
            _ => {}
        }
    }
}

/// Incrementally follows the canonical native Goal wire journal.
///
/// The cursor owns a byte offset rather than a line count so callers can open
/// it immediately before an ACP prompt, then observe exactly the complete
/// records appended by that prompt and any native continuation turns. Bytes
/// after the final newline remain buffered until a later poll, which also
/// makes a UTF-8 code point split across writes safe.
pub struct GoalJournalCursor {
    wire_file: PathBuf,
    offset: u64,
    partial_line: Vec<u8>,
    complete_offset: u64,
    anchor_start: u64,
    anchor: Vec<u8>,
    record_index: u64,
    last_goal_terminal_record: Option<u64>,
    last_goal_terminal_status: Option<String>,
    last_goal_terminal_goal_id: Option<String>,
    last_goal_terminal_requires_closed_step: bool,
    last_goal_create_record: Option<u64>,
    last_goal_create_id: Option<String>,
    last_goal_active_record: Option<u64>,
    last_goal_active_id: Option<String>,
    last_budget_limits_record: Option<u64>,
    last_budget_limits_update_record: Option<u64>,
    last_budget_limits_goal_id: Option<String>,
    last_step_begin_record: Option<u64>,
    last_step_end_record: Option<u64>,
    last_turn_ended_record: Option<u64>,
    snapshot: Option<Value>,
}

impl GoalJournalCursor {
    pub fn open(session_id: &str) -> Result<Self, String> {
        let session_dir = session_store::find_session_dir_by_id_or_err(session_id)?;
        let wire_file = wire_jsonl_path(&session_dir)
            .unwrap_or_else(|| session_dir.join("agents").join("main").join("wire.jsonl"));
        Self::open_path(wire_file)
    }

    fn open_path(wire_file: PathBuf) -> Result<Self, String> {
        let mut cursor = Self {
            wire_file,
            offset: 0,
            partial_line: Vec::new(),
            complete_offset: 0,
            anchor_start: 0,
            anchor: Vec::new(),
            record_index: 0,
            last_goal_terminal_record: None,
            last_goal_terminal_status: None,
            last_goal_terminal_goal_id: None,
            last_goal_terminal_requires_closed_step: false,
            last_goal_create_record: None,
            last_goal_create_id: None,
            last_goal_active_record: None,
            last_goal_active_id: None,
            last_budget_limits_record: None,
            last_budget_limits_update_record: None,
            last_budget_limits_goal_id: None,
            last_step_begin_record: None,
            last_step_end_record: None,
            last_turn_ended_record: None,
            snapshot: None,
        };
        cursor.read_available(false)?;
        Ok(cursor)
    }

    pub fn poll(&mut self) -> Result<GoalJournalPoll, String> {
        self.read_available(true)
    }

    pub fn snapshot(&self) -> Option<Value> {
        public_snapshot(&self.snapshot)
    }

    /// Monotonic index of the latest valid JSON record included in the baseline.
    pub fn record_index(&self) -> u64 {
        self.record_index
    }

    fn reset_state(&mut self) {
        self.offset = 0;
        self.partial_line.clear();
        self.complete_offset = 0;
        self.anchor_start = 0;
        self.anchor.clear();
        self.record_index = 0;
        self.last_goal_terminal_record = None;
        self.last_goal_terminal_status = None;
        self.last_goal_terminal_goal_id = None;
        self.last_goal_terminal_requires_closed_step = false;
        self.last_goal_create_record = None;
        self.last_goal_create_id = None;
        self.last_goal_active_record = None;
        self.last_goal_active_id = None;
        self.last_budget_limits_record = None;
        self.last_budget_limits_update_record = None;
        self.last_budget_limits_goal_id = None;
        self.last_step_begin_record = None;
        self.last_step_end_record = None;
        self.last_turn_ended_record = None;
        self.snapshot = None;
    }

    fn anchor_matches(&self, file: &mut fs::File) -> Result<bool, String> {
        if self.anchor.is_empty() {
            return Ok(true);
        }
        file.seek(SeekFrom::Start(self.anchor_start))
            .map_err(|error| {
                format!(
                    "Failed to seek journal anchor in {}: {error}",
                    self.wire_file.display()
                )
            })?;
        let mut current = vec![0; self.anchor.len()];
        match file.read_exact(&mut current) {
            Ok(()) => Ok(current == self.anchor),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
            Err(error) => Err(format!(
                "Failed to verify journal anchor in {}: {error}",
                self.wire_file.display()
            )),
        }
    }

    fn refresh_anchor(&mut self, file: &mut fs::File) -> Result<(), String> {
        self.anchor_start = self.offset.saturating_sub(JOURNAL_ANCHOR_BYTES);
        let anchor_len = usize::try_from(self.offset - self.anchor_start)
            .map_err(|_| format!("Goal journal anchor overflow: {}", self.wire_file.display()))?;
        self.anchor.resize(anchor_len, 0);
        if anchor_len == 0 {
            return Ok(());
        }
        file.seek(SeekFrom::Start(self.anchor_start))
            .map_err(|error| {
                format!(
                    "Failed to seek journal anchor in {}: {error}",
                    self.wire_file.display()
                )
            })?;
        file.read_exact(&mut self.anchor).map_err(|error| {
            format!(
                "Failed to refresh journal anchor in {}: {error}",
                self.wire_file.display()
            )
        })
    }

    fn read_available(&mut self, report_records: bool) -> Result<GoalJournalPoll, String> {
        let mut report = GoalJournalPoll {
            last_complete_offset: self.complete_offset,
            last_record_index: self.record_index,
            has_pending_line: !self.partial_line.is_empty(),
            last_goal_terminal_record: self.last_goal_terminal_record,
            last_goal_terminal_status: self.last_goal_terminal_status.clone(),
            last_goal_terminal_goal_id: self.last_goal_terminal_goal_id.clone(),
            last_goal_terminal_requires_closed_step: self.last_goal_terminal_requires_closed_step,
            last_goal_create_record: self.last_goal_create_record,
            last_goal_create_id: self.last_goal_create_id.clone(),
            last_goal_active_record: self.last_goal_active_record,
            last_goal_active_id: self.last_goal_active_id.clone(),
            last_budget_limits_record: self.last_budget_limits_record,
            last_budget_limits_update_record: self.last_budget_limits_update_record,
            last_budget_limits_goal_id: self.last_budget_limits_goal_id.clone(),
            last_step_begin_record: self.last_step_begin_record,
            last_step_end_record: self.last_step_end_record,
            last_turn_ended_record: self.last_turn_ended_record,
            ..GoalJournalPoll::default()
        };
        let metadata = match fs::metadata(&self.wire_file) {
            Ok(metadata) => metadata,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && self.offset == 0
                    && self.partial_line.is_empty() =>
            {
                return Ok(report)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let had_snapshot = self.snapshot.is_some();
                self.reset_state();
                return Ok(GoalJournalPoll {
                    changed: had_snapshot,
                    advanced: true,
                    truncated: true,
                    ..GoalJournalPoll::default()
                });
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect {}: {error}",
                    self.wire_file.display()
                ))
            }
        };

        let mut rewound = false;
        if metadata.len() < self.offset {
            let had_snapshot = self.snapshot.is_some();
            self.reset_state();
            report.truncated = true;
            report.changed = had_snapshot;
            report.advanced = true;
            rewound = true;
        }

        let mut file = fs::File::open(&self.wire_file)
            .map_err(|error| format!("Failed to open {}: {error}", self.wire_file.display()))?;
        if !rewound && !self.anchor_matches(&mut file)? {
            let had_snapshot = self.snapshot.is_some();
            self.reset_state();
            report.replaced = true;
            report.changed = had_snapshot;
            report.advanced = true;
            rewound = true;
        }
        if rewound {
            report.last_complete_offset = 0;
            report.last_record_index = 0;
            report.has_pending_line = false;
            report.last_goal_terminal_record = None;
            report.last_goal_terminal_status = None;
            report.last_goal_terminal_goal_id = None;
            report.last_goal_terminal_requires_closed_step = false;
            report.last_goal_create_record = None;
            report.last_goal_create_id = None;
            report.last_goal_active_record = None;
            report.last_goal_active_id = None;
            report.last_budget_limits_record = None;
            report.last_budget_limits_update_record = None;
            report.last_budget_limits_goal_id = None;
            report.last_step_begin_record = None;
            report.last_step_end_record = None;
            report.last_turn_ended_record = None;
        }
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|error| format!("Failed to seek {}: {error}", self.wire_file.display()))?;
        let mut appended = Vec::new();
        file.read_to_end(&mut appended)
            .map_err(|error| format!("Failed to read {}: {error}", self.wire_file.display()))?;
        report.read_bytes = u64::try_from(appended.len())
            .map_err(|_| format!("Goal journal read overflow: {}", self.wire_file.display()))?;
        report.advanced |= report.read_bytes > 0;
        self.offset = self
            .offset
            .checked_add(report.read_bytes)
            .ok_or_else(|| format!("Goal journal offset overflow: {}", self.wire_file.display()))?;
        self.partial_line.extend_from_slice(&appended);
        report.has_pending_line = !self.partial_line.is_empty();
        self.refresh_anchor(&mut file)?;

        let complete_len = self
            .partial_line
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        if complete_len == 0 {
            return Ok(report);
        }

        let mut parsed_records = Vec::new();
        let mut relative_offset = 0u64;
        for raw_line in self.partial_line[..complete_len].split_inclusive(|byte| *byte == b'\n') {
            let line_offset = self
                .complete_offset
                .checked_add(relative_offset)
                .ok_or_else(|| {
                    format!(
                        "Goal journal line offset overflow: {}",
                        self.wire_file.display()
                    )
                })?;
            relative_offset = relative_offset
                .checked_add(u64::try_from(raw_line.len()).map_err(|_| {
                    format!(
                        "Goal journal line offset overflow: {}",
                        self.wire_file.display()
                    )
                })?)
                .ok_or_else(|| {
                    format!(
                        "Goal journal line offset overflow: {}",
                        self.wire_file.display()
                    )
                })?;
            let raw_line = raw_line.strip_suffix(b"\n").unwrap_or(raw_line);
            let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
            let line = std::str::from_utf8(raw_line).map_err(|error| {
                format!(
                    "Corrupt Goal journal complete line at byte {line_offset} in {}: invalid UTF-8: {error}",
                    self.wire_file.display()
                )
            })?;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let record = serde_json::from_str::<Value>(line).map_err(|error| {
                format!(
                    "Corrupt Goal journal complete line at byte {line_offset} in {}: invalid JSON: {error}",
                    self.wire_file.display()
                )
            })?;
            parsed_records.push(record);
        }

        self.partial_line.drain(..complete_len);
        report.has_pending_line = !self.partial_line.is_empty();
        self.complete_offset = self
            .complete_offset
            .checked_add(u64::try_from(complete_len).map_err(|_| {
                format!(
                    "Goal journal line offset overflow: {}",
                    self.wire_file.display()
                )
            })?)
            .ok_or_else(|| {
                format!(
                    "Goal journal line offset overflow: {}",
                    self.wire_file.display()
                )
            })?;
        report.last_complete_offset = self.complete_offset;
        for record in parsed_records {
            self.record_index = self.record_index.checked_add(1).ok_or_else(|| {
                format!(
                    "Goal journal record index overflow: {}",
                    self.wire_file.display()
                )
            })?;
            report.last_record_index = self.record_index;
            let current_goal_id = self
                .snapshot
                .as_ref()
                .and_then(|goal| goal.get("goal_id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            report.observe(&record, self.record_index, current_goal_id.as_deref());
            apply_record(&mut self.snapshot, &record);
        }
        self.last_goal_terminal_record = report.last_goal_terminal_record;
        self.last_goal_terminal_status = report.last_goal_terminal_status.clone();
        self.last_goal_terminal_goal_id = report.last_goal_terminal_goal_id.clone();
        self.last_goal_terminal_requires_closed_step =
            report.last_goal_terminal_requires_closed_step;
        self.last_goal_create_record = report.last_goal_create_record;
        self.last_goal_create_id = report.last_goal_create_id.clone();
        self.last_goal_active_record = report.last_goal_active_record;
        self.last_goal_active_id = report.last_goal_active_id.clone();
        self.last_budget_limits_record = report.last_budget_limits_record;
        self.last_budget_limits_update_record = report.last_budget_limits_update_record;
        self.last_budget_limits_goal_id = report.last_budget_limits_goal_id.clone();
        self.last_step_begin_record = report.last_step_begin_record;
        self.last_step_end_record = report.last_step_end_record;
        self.last_turn_ended_record = report.last_turn_ended_record;
        if report_records && report.saw_goal_record {
            report.changed = true;
        }
        Ok(report)
    }
}

pub fn session_goal_snapshot(session_id: &str) -> Result<Option<Value>, String> {
    let Some(session_dir) = session_store::find_session_dir_by_id(session_id)? else {
        return Ok(None);
    };
    let Some(wire_file) = wire_jsonl_path(&session_dir) else {
        return Ok(None);
    };
    GoalJournalCursor::open_path(wire_file).map(|cursor| cursor.snapshot())
}

fn append_record(session_id: &str, record: &Value) -> Result<(), String> {
    let session_dir = session_store::find_session_dir_by_id_or_err(session_id)?;
    let wire_file = wire_jsonl_path(&session_dir)
        .unwrap_or_else(|| session_dir.join("agents").join("main").join("wire.jsonl"));
    let parent = wire_file
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", wire_file.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let line = serde_json::to_string(record)
        .map_err(|error| format!("Failed to serialize goal record: {error}"))?;
    let _guard = SESSION_GOAL_WIRE_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&wire_file)
        .map_err(|error| format!("Failed to open {}: {error}", wire_file.display()))?;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|error| format!("Failed to append {}: {error}", wire_file.display()))?;
    file.sync_data()
        .map_err(|error| format!("Failed to sync {}: {error}", wire_file.display()))
}

pub fn append_pause(session_id: &str) -> Result<(), String> {
    append_record(
        session_id,
        &json!({
            "type": "goal.update",
            "status": "paused",
            "reason": "Paused from Kimi Code Desktop",
            "actor": "user",
            "time": now_ms(),
        }),
    )
}

pub fn append_clear(session_id: &str) -> Result<(), String> {
    append_record(
        session_id,
        &json!({ "type": "goal.clear", "time": now_ms() }),
    )
}

#[cfg(test)]
mod tests {
    use super::{apply_record, budget_snapshot, GoalJournalCursor, GoalJournalPoll};
    use serde_json::{json, Value};
    use std::fs;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn rebuilds_goal_and_budget_from_native_records() {
        let mut snapshot = None;
        apply_record(
            &mut snapshot,
            &json!({
                "type": "goal.create",
                "goalId": "goal-1",
                "objective": "Ship Goal controls",
                "completionCriterion": "Tests pass"
            }),
        );
        apply_record(
            &mut snapshot,
            &json!({
                "type": "goal.update",
                "turnsUsed": 2,
                "tokensUsed": 120,
                "wallClockMs": 5000,
                "budgetLimits": {
                    "turnBudget": 5,
                    "tokenBudget": 200,
                    "wallClockBudgetMs": 10000
                }
            }),
        );
        let current = snapshot.as_ref().expect("goal");
        assert_eq!(current["status"], "active");
        assert_eq!(current["turns_used"], 2);
        let budget = budget_snapshot(current);
        assert_eq!(budget["remaining_turns"], 3);
        assert_eq!(budget["remaining_tokens"], 80);
        assert_eq!(budget["remaining_wall_clock_ms"], 5000);
        assert_eq!(budget["over_budget"], false);
    }

    #[test]
    fn applies_pause_resume_and_clear_records() {
        let mut snapshot = None;
        apply_record(
            &mut snapshot,
            &json!({"type":"goal.create","goalId":"g","objective":"Do it"}),
        );
        apply_record(
            &mut snapshot,
            &json!({"type":"goal.update","status":"paused","reason":"user"}),
        );
        assert_eq!(snapshot.as_ref().unwrap()["status"], "paused");
        apply_record(
            &mut snapshot,
            &json!({"type":"goal.update","status":"active"}),
        );
        assert_eq!(snapshot.as_ref().unwrap()["terminal_reason"], Value::Null);
        apply_record(&mut snapshot, &json!({"type":"goal.clear"}));
        assert!(snapshot.is_none());
    }

    #[test]
    fn cursor_waits_for_complete_lines_and_utf8_chunks() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        fs::write(&wire_file, b"").expect("empty journal");
        let mut cursor = GoalJournalCursor::open_path(wire_file.clone()).expect("cursor");

        let record =
            serde_json::to_vec(&json!({"type":"goal.create","goalId":"g","objective":"完成目标"}))
                .expect("record");
        let multibyte_index = record
            .windows("完".len())
            .position(|window| window == "完".as_bytes())
            .expect("multibyte objective");
        let split = multibyte_index + 1;
        fs::write(&wire_file, &record[..split]).expect("first chunk");

        let first = cursor.poll().expect("first poll");
        assert!(first.advanced);
        assert_eq!(first.read_bytes, split as u64);
        assert_eq!(first.last_complete_offset, 0);
        assert!(first.has_pending_line);
        assert!(!first.changed);
        assert!(!first.saw_create);
        assert!(cursor.snapshot().is_none());

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&wire_file)
            .expect("append journal");
        file.write_all(&record[split..]).expect("second chunk");
        file.write_all(b"\n").expect("newline");
        file.flush().expect("flush");

        let second = cursor.poll().expect("second poll");
        assert!(second.changed);
        assert!(second.saw_create);
        assert!(second.saw_active);
        assert_eq!(second.last_complete_offset, (record.len() + 1) as u64);
        assert!(!second.has_pending_line);
        assert_eq!(second.last_record_index, 1);
        assert_eq!(cursor.snapshot().unwrap()["objective"], "完成目标");
    }

    #[test]
    fn cursor_reports_goal_and_ordered_lifecycle_semantics() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        fs::write(&wire_file, b"").expect("empty journal");
        let mut cursor = GoalJournalCursor::open_path(wire_file.clone()).expect("cursor");
        let records = concat!(
            "{\"type\":\"goal.create\",\"goalId\":\"g\",\"objective\":\"Do it\"}\n",
            "{\"type\":\"goal.update\",\"status\":\"paused\"}\n",
            "{\"type\":\"goal.update\",\"status\":\"blocked\"}\n",
            "{\"type\":\"goal.update\",\"status\":\"active\"}\n",
            "{\"type\":\"goal.update\",\"status\":\"complete\"}\n",
            "{\"type\":\"goal.clear\"}\n",
            "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"finishReason\":\"end_turn\"}}\n",
            "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\"}}\n",
            "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"loop.end\"}}\n",
            "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"finish_reason\":\"end_turn\"}}\n"
        );
        fs::write(&wire_file, records).expect("goal lifecycle");

        let report = cursor.poll().expect("poll");
        assert!(report.changed);
        assert!(report.advanced);
        assert_eq!(report.read_bytes, records.len() as u64);
        assert_eq!(report.last_complete_offset, records.len() as u64);
        assert_eq!(report.last_record_index, 10);
        assert!(report.saw_goal_record);
        assert!(report.saw_create);
        assert!(report.saw_active);
        assert!(report.saw_paused);
        assert!(report.saw_blocked);
        assert!(report.saw_complete);
        assert!(report.saw_clear);
        assert!(report.saw_turn_ended);
        assert!(report.saw_step_end);
        assert!(report.saw_loop_event);
        assert!(report.saw_loop_lifecycle);
        assert_eq!(report.last_goal_terminal_record, Some(6));
        assert_eq!(report.last_goal_terminal_status.as_deref(), Some("clear"));
        assert_eq!(report.last_goal_terminal_goal_id.as_deref(), Some("g"));
        assert!(report.last_goal_terminal_requires_closed_step);
        assert_eq!(report.last_goal_create_record, Some(1));
        assert_eq!(report.last_goal_create_id.as_deref(), Some("g"));
        assert_eq!(report.last_goal_active_record, Some(4));
        assert_eq!(report.last_goal_active_id.as_deref(), Some("g"));
        assert_eq!(report.last_step_begin_record, Some(8));
        assert_eq!(report.last_step_end_record, Some(10));
        assert_eq!(report.last_turn_ended_record, Some(10));
        assert!(cursor.snapshot().is_none());
    }

    #[test]
    fn cursor_reports_non_goal_progress_without_goal_change() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        fs::write(&wire_file, b"").expect("empty journal");
        let mut cursor = GoalJournalCursor::open_path(wire_file.clone()).expect("cursor");
        let record = "{\"type\":\"context.append_message\",\"message\":{}}\n";
        fs::write(&wire_file, record).expect("non-goal record");

        let report = cursor.poll().expect("poll");
        assert!(report.advanced);
        assert_eq!(report.read_bytes, record.len() as u64);
        assert_eq!(report.last_complete_offset, record.len() as u64);
        assert_eq!(report.last_record_index, 1);
        assert!(!report.changed);
        assert!(!report.saw_goal_record);
    }

    #[test]
    fn cursor_resets_after_truncation_and_rebuilds_new_records() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        fs::write(
            &wire_file,
            concat!(
                "{\"type\":\"goal.create\",\"goalId\":\"old\",\"objective\":\"Old\"}\n",
                "{\"type\":\"goal.update\",\"turnsUsed\":12,\"tokensUsed\":34}\n"
            ),
        )
        .expect("initial journal");
        let mut cursor = GoalJournalCursor::open_path(wire_file.clone()).expect("cursor");
        assert_eq!(cursor.snapshot().unwrap()["goal_id"], "old");

        let replacement = "{\"type\":\"goal.create\",\"goalId\":\"new\",\"objective\":\"New\"}\n";
        fs::write(&wire_file, replacement).expect("truncated journal");

        let report = cursor.poll().expect("poll");
        assert!(report.truncated);
        assert!(report.advanced);
        assert_eq!(report.read_bytes, replacement.len() as u64);
        assert_eq!(report.last_complete_offset, replacement.len() as u64);
        assert_eq!(report.last_record_index, 1);
        assert!(report.changed);
        assert!(report.saw_create);
        assert_eq!(cursor.snapshot().unwrap()["goal_id"], "new");
    }

    #[test]
    fn cursor_treats_journal_removal_as_truncation() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        let record = serde_json::to_string(
            &json!({ "type": "goal.create", "goalId": "g", "objective": "Do it" }),
        )
        .expect("serialize record")
            + "\n";
        fs::write(&wire_file, record).expect("initial journal");
        let mut cursor = GoalJournalCursor::open_path(wire_file.clone()).expect("cursor");
        fs::remove_file(&wire_file).expect("remove journal");

        let report = cursor.poll().expect("poll");
        assert!(report.truncated);
        assert!(report.advanced);
        assert!(report.changed);
        assert!(cursor.snapshot().is_none());
    }

    #[test]
    fn cursor_snapshot_is_public_and_contains_computed_budget() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        fs::write(
            &wire_file,
            concat!(
                "{\"type\":\"goal.create\",\"goalId\":\"g\",\"objective\":\"Do it\"}\n",
                "{\"type\":\"goal.update\",\"turnsUsed\":2,\"tokensUsed\":120,",
                "\"budgetLimits\":{\"turnBudget\":5,\"tokenBudget\":200}}\n"
            ),
        )
        .expect("journal");
        let cursor = GoalJournalCursor::open_path(wire_file).expect("cursor");
        let snapshot = cursor.snapshot().expect("snapshot");

        assert!(snapshot.get("budget_limits").is_none());
        assert_eq!(snapshot["budget"]["remaining_turns"], 3);
        assert_eq!(snapshot["budget"]["remaining_tokens"], 80);
    }

    #[test]
    fn cursor_distinguishes_native_budget_limit_updates_from_usage() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        fs::write(&wire_file, b"").expect("empty journal");
        let mut cursor = GoalJournalCursor::open_path(wire_file.clone()).expect("cursor");

        let create = concat!(
            "{\"type\":\"goal.create\",\"goalId\":\"g\",\"objective\":\"Do it\",",
            "\"budgetLimits\":{\"tokenBudget\":200}}\n"
        );
        fs::write(&wire_file, create).expect("goal create");
        let created = cursor.poll().expect("create poll");
        assert!(created.saw_budget_limits);
        assert!(!created.saw_budget_limits_update);
        assert_eq!(created.last_budget_limits_record, Some(1));
        assert_eq!(created.last_budget_limits_update_record, None);
        assert_eq!(created.last_budget_limits_goal_id.as_deref(), Some("g"));

        let updates = concat!(
            "{\"type\":\"usage.record\",\"budgetLimits\":{\"turnBudget\":99}}\n",
            "{\"type\":\"goal.update\",\"tokensUsed\":10}\n",
            "{\"type\":\"goal.update\",\"budget_limits\":{\"turn_budget\":7}}\n"
        );
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&wire_file)
            .expect("append journal");
        file.write_all(updates.as_bytes()).expect("goal updates");
        file.flush().expect("flush updates");

        let updated = cursor.poll().expect("update poll");
        assert!(updated.saw_budget_limits);
        assert!(updated.saw_budget_limits_update);
        assert_eq!(updated.last_budget_limits_record, Some(4));
        assert_eq!(updated.last_budget_limits_update_record, Some(4));
        assert_eq!(updated.last_budget_limits_goal_id.as_deref(), Some("g"));
        let snapshot = cursor.snapshot().expect("goal snapshot");
        assert_eq!(snapshot["budget"]["token_budget"], 200);
        assert_eq!(snapshot["budget"]["turn_budget"], 7);
    }

    #[test]
    fn poll_only_marks_goal_budget_limit_updates_as_budget_handoffs() {
        let mut report = GoalJournalPoll::default();
        report.observe(
            &json!({ "type": "usage.record", "budgetLimits": { "turnBudget": 99 } }),
            1,
            Some("g"),
        );
        report.observe(
            &json!({ "type": "goal.update", "tokensUsed": 10 }),
            2,
            Some("g"),
        );
        assert_eq!(report.last_budget_limits_update_record, None);

        report.observe(
            &json!({ "type": "goal.update", "budgetLimits": { "turnBudget": 7 } }),
            3,
            Some("g"),
        );
        assert_eq!(report.last_budget_limits_update_record, Some(3));
        assert_eq!(report.last_budget_limits_goal_id.as_deref(), Some("g"));
    }

    #[test]
    fn active_or_new_goal_clears_a_previous_terminal_marker() {
        let mut report = GoalJournalPoll::default();
        report.observe(
            &json!({ "type": "goal.create", "goalId": "g", "objective": "Do it" }),
            1,
            None,
        );
        report.observe(
            &json!({ "type": "goal.update", "status": "paused" }),
            2,
            Some("g"),
        );
        assert_eq!(report.last_goal_terminal_record, Some(2));

        report.observe(
            &json!({ "type": "goal.update", "status": "active" }),
            3,
            Some("g"),
        );
        assert_eq!(report.last_goal_terminal_record, None);
        assert_eq!(report.last_goal_active_record, Some(3));
        assert_eq!(report.last_goal_active_id.as_deref(), Some("g"));

        report.observe(
            &json!({ "type": "goal.update", "status": "complete" }),
            4,
            Some("g"),
        );
        report.observe(
            &json!({ "type": "goal.create", "goalId": "new", "objective": "Next" }),
            5,
            Some("g"),
        );
        assert_eq!(report.last_goal_terminal_record, None);
        assert_eq!(report.last_goal_create_record, Some(5));
        assert_eq!(report.last_goal_create_id.as_deref(), Some("new"));
    }

    #[test]
    fn cursor_rejects_complete_invalid_json_without_consuming_it() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        fs::write(&wire_file, b"").expect("empty journal");
        let mut cursor = GoalJournalCursor::open_path(wire_file.clone()).expect("cursor");
        fs::write(
            &wire_file,
            concat!(
                "{\"type\":\"goal.create\",\"goalId\":\"g\",\"objective\":\"Do it\"}\n",
                "{not-json}\n"
            ),
        )
        .expect("corrupt journal");

        let first = cursor.poll().expect_err("invalid JSON must fail");
        assert!(first.contains("Corrupt Goal journal complete line"));
        assert!(first.contains("invalid JSON"));
        assert_eq!(cursor.record_index(), 0);
        assert!(cursor.snapshot().is_none());

        let second = cursor.poll().expect_err("corruption must remain visible");
        assert!(second.contains("invalid JSON"));
        assert_eq!(cursor.record_index(), 0);
    }

    #[test]
    fn cursor_rejects_complete_invalid_utf8_without_consuming_it() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        fs::write(&wire_file, b"").expect("empty journal");
        let mut cursor = GoalJournalCursor::open_path(wire_file.clone()).expect("cursor");
        fs::write(&wire_file, [0xff, b'\n']).expect("invalid UTF-8 journal");

        let first = cursor.poll().expect_err("invalid UTF-8 must fail");
        assert!(first.contains("Corrupt Goal journal complete line"));
        assert!(first.contains("invalid UTF-8"));
        assert_eq!(cursor.record_index(), 0);

        let second = cursor.poll().expect_err("corruption must remain visible");
        assert!(second.contains("invalid UTF-8"));
    }

    #[test]
    fn cursor_detects_same_length_and_longer_file_replacement() {
        let directory = tempdir().expect("temp directory");
        let wire_file = directory.path().join("wire.jsonl");
        let old = "{\"type\":\"goal.create\",\"goalId\":\"old\",\"objective\":\"Old\"}\n";
        let new = "{\"type\":\"goal.create\",\"goalId\":\"new\",\"objective\":\"New\"}\n";
        assert_eq!(old.len(), new.len());
        fs::write(&wire_file, old).expect("old journal");
        let mut cursor = GoalJournalCursor::open_path(wire_file.clone()).expect("cursor");

        fs::write(&wire_file, new).expect("same-length replacement");
        let replaced = cursor.poll().expect("replacement poll");
        assert!(replaced.replaced);
        assert!(!replaced.truncated);
        assert!(replaced.saw_create);
        assert_eq!(replaced.last_record_index, 1);
        assert_eq!(cursor.snapshot().unwrap()["goal_id"], "new");

        let longer = concat!(
            "{\"type\":\"goal.create\",\"goalId\":\"latest\",\"objective\":\"Latest\"}\n",
            "{\"type\":\"goal.update\",\"turnsUsed\":2}\n"
        );
        assert!(longer.len() > new.len());
        fs::write(&wire_file, longer).expect("longer replacement");
        let replaced = cursor.poll().expect("longer replacement poll");
        assert!(replaced.replaced);
        assert!(replaced.saw_create);
        assert_eq!(replaced.last_record_index, 2);
        let snapshot = cursor.snapshot().expect("latest snapshot");
        assert_eq!(snapshot["goal_id"], "latest");
        assert_eq!(snapshot["turns_used"], 2);
    }
}
