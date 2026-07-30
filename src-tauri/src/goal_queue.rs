//! Persistent upcoming Goal queue compatible with Kimi Code's TUI store.

use crate::session_store;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const GOAL_QUEUE_FILE: &str = "upcoming-goals.json";
const GOAL_QUEUE_VERSION: u8 = 1;
const MAX_GOAL_OBJECTIVE_LENGTH: usize = 4000;

static GOAL_QUEUE_MUTATION_LOCK: Mutex<()> = Mutex::new(());
static NEXT_QUEUE_WRITE_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_GOAL_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpcomingGoal {
    pub id: String,
    pub objective: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct GoalQueueSnapshot {
    pub goals: Vec<UpcomingGoal>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GoalQueueMoveDirection {
    Up,
    Down,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct GoalQueueFile {
    version: u8,
    goals: Vec<UpcomingGoal>,
}

impl GoalQueueFile {
    fn empty() -> Self {
        Self {
            version: GOAL_QUEUE_VERSION,
            goals: Vec::new(),
        }
    }

    fn snapshot(&self) -> GoalQueueSnapshot {
        GoalQueueSnapshot {
            goals: self.goals.clone(),
        }
    }
}

pub fn read(session_id: &str) -> Result<GoalQueueSnapshot, String> {
    let _guard = queue_lock();
    read_queue_file(&queue_path(session_id)?).map(|file| file.snapshot())
}

pub fn append(session_id: &str, objective: &str) -> Result<GoalQueueSnapshot, String> {
    let objective = normalize_objective(objective)?;
    let _guard = queue_lock();
    append_at_path(&queue_path(session_id)?, objective)
}

pub fn update(
    session_id: &str,
    goal_id: &str,
    objective: &str,
) -> Result<GoalQueueSnapshot, String> {
    let objective = normalize_objective(objective)?;
    let _guard = queue_lock();
    update_at_path(&queue_path(session_id)?, goal_id, objective)
}

pub fn remove(session_id: &str, goal_id: &str) -> Result<GoalQueueSnapshot, String> {
    let _guard = queue_lock();
    remove_at_path(&queue_path(session_id)?, goal_id)
}

/// Remove a queued item after the native Goal journal confirms `goal.create`.
/// Missing items are harmless: the user may have removed the entry while the
/// start confirmation was open.
pub fn consume_started(session_id: &str, goal_id: &str) -> Result<bool, String> {
    let _guard = queue_lock();
    let path = queue_path(session_id)?;
    let mut state = read_queue_file(&path)?;
    let Some(index) = state.goals.iter().position(|goal| goal.id == goal_id) else {
        return Ok(false);
    };
    state.goals.remove(index);
    write_queue_file(&path, &state)?;
    Ok(true)
}

pub fn move_item(
    session_id: &str,
    goal_id: &str,
    direction: GoalQueueMoveDirection,
) -> Result<GoalQueueSnapshot, String> {
    let _guard = queue_lock();
    move_at_path(&queue_path(session_id)?, goal_id, direction)
}

fn queue_lock() -> std::sync::MutexGuard<'static, ()> {
    GOAL_QUEUE_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn queue_path(session_id: &str) -> Result<PathBuf, String> {
    Ok(session_store::find_session_dir_by_id_or_err(session_id)?.join(GOAL_QUEUE_FILE))
}

fn append_at_path(path: &Path, objective: String) -> Result<GoalQueueSnapshot, String> {
    let mut state = read_queue_file(path)?;
    let now = now_timestamp();
    state.goals.push(UpcomingGoal {
        id: new_goal_id(),
        objective,
        created_at: now.clone(),
        updated_at: now,
    });
    write_queue_file(path, &state)?;
    Ok(state.snapshot())
}

fn update_at_path(
    path: &Path,
    goal_id: &str,
    objective: String,
) -> Result<GoalQueueSnapshot, String> {
    let mut state = read_queue_file(path)?;
    let index = find_goal_index(&state, goal_id)?;
    let updated_at = timestamp_after(&state.goals[index].updated_at);
    state.goals[index].objective = objective;
    state.goals[index].updated_at = updated_at;
    write_queue_file(path, &state)?;
    Ok(state.snapshot())
}

fn remove_at_path(path: &Path, goal_id: &str) -> Result<GoalQueueSnapshot, String> {
    let mut state = read_queue_file(path)?;
    let index = find_goal_index(&state, goal_id)?;
    state.goals.remove(index);
    write_queue_file(path, &state)?;
    Ok(state.snapshot())
}

fn move_at_path(
    path: &Path,
    goal_id: &str,
    direction: GoalQueueMoveDirection,
) -> Result<GoalQueueSnapshot, String> {
    let mut state = read_queue_file(path)?;
    let index = find_goal_index(&state, goal_id)?;
    let target = match direction {
        GoalQueueMoveDirection::Up => index.checked_sub(1),
        GoalQueueMoveDirection::Down => index
            .checked_add(1)
            .filter(|next| *next < state.goals.len()),
    };
    let Some(target) = target else {
        return Ok(state.snapshot());
    };
    state.goals.swap(index, target);
    write_queue_file(path, &state)?;
    Ok(state.snapshot())
}

fn read_queue_file(path: &Path) -> Result<GoalQueueFile, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(GoalQueueFile::empty())
        }
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid JSON in goal queue {}: {error}", path.display()))?;
    if !is_goal_queue_file(&parsed) {
        return Err(format!(
            "Unsupported goal queue format in {}; the file was left unchanged",
            path.display()
        ));
    }
    serde_json::from_value(parsed)
        .map_err(|error| format!("Invalid goal queue {}: {error}", path.display()))
}

fn write_queue_file(path: &Path, state: &GoalQueueFile) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let serialized = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Failed to serialize goal queue: {error}"))?;
    let unique = NEXT_QUEUE_WRITE_ID.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.tmp.{}.{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(GOAL_QUEUE_FILE),
        std::process::id(),
        unique
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("Failed to create {}: {error}", temporary.display()))?;
        file.write_all(format!("{serialized}\n").as_bytes())
            .map_err(|error| format!("Failed to write {}: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync {}: {error}", temporary.display()))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Failed to replace {}: {error}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn is_goal_queue_file(value: &Value) -> bool {
    value.get("version").and_then(Value::as_u64) == Some(u64::from(GOAL_QUEUE_VERSION))
        && value
            .get("goals")
            .and_then(Value::as_array)
            .is_some_and(|goals| goals.iter().all(is_upcoming_goal))
}

fn is_upcoming_goal(value: &Value) -> bool {
    value.as_object().is_some()
        && ["id", "objective", "createdAt", "updatedAt"]
            .iter()
            .all(|field| {
                value
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.is_empty())
            })
}

fn normalize_objective(value: &str) -> Result<String, String> {
    let objective = value.trim();
    if objective.is_empty() {
        return Err("Goal objective cannot be empty".to_string());
    }
    if objective.encode_utf16().count() > MAX_GOAL_OBJECTIVE_LENGTH {
        return Err(format!(
            "Goal objective cannot exceed {MAX_GOAL_OBJECTIVE_LENGTH} characters"
        ));
    }
    Ok(objective.to_string())
}

fn find_goal_index(state: &GoalQueueFile, goal_id: &str) -> Result<usize, String> {
    state
        .goals
        .iter()
        .position(|goal| goal.id == goal_id)
        .ok_or_else(|| "No queued goal found".to_string())
}

fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn timestamp_after(previous: &str) -> String {
    let now = Utc::now();
    let timestamp = DateTime::parse_from_rfc3339(previous)
        .ok()
        .map(|previous| previous.with_timezone(&Utc))
        .filter(|previous| *previous >= now)
        .map(|previous| previous + Duration::milliseconds(1))
        .unwrap_or(now);
    timestamp.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn new_goal_id() -> String {
    let counter = NEXT_GOAL_ID.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut bytes = md5::compute(format!("{}:{nanos}:{counter}", std::process::id())).0;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::lock::set_kimi_code_home;
    use tempfile::tempdir;

    fn queue_path() -> (tempfile::TempDir, PathBuf) {
        let directory = tempdir().expect("temp directory");
        let path = directory.path().join(GOAL_QUEUE_FILE);
        (directory, path)
    }

    fn append_goal(path: &Path, objective: &str) -> GoalQueueSnapshot {
        append_at_path(path, normalize_objective(objective).expect("objective")).expect("append")
    }

    #[test]
    fn writes_official_camel_case_v1_format() {
        let (_directory, path) = queue_path();
        let snapshot = append_goal(&path, "  Ship queue  ");
        let raw = fs::read_to_string(&path).expect("queue file");
        let parsed: Value = serde_json::from_str(&raw).expect("valid JSON");

        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["goals"][0]["objective"], "Ship queue");
        assert!(parsed["goals"][0].get("createdAt").is_some());
        assert!(parsed["goals"][0].get("updatedAt").is_some());
        assert!(parsed["goals"][0].get("created_at").is_none());
        assert_eq!(snapshot.goals.len(), 1);
        assert!(raw.ends_with('\n'));
    }

    #[test]
    fn crud_and_reorder_match_official_behavior() {
        let (_directory, path) = queue_path();
        let first = append_goal(&path, "First").goals[0].clone();
        let second = append_goal(&path, "Second").goals[1].clone();
        let third = append_goal(&path, "Third").goals[2].clone();

        let moved = move_at_path(&path, &third.id, GoalQueueMoveDirection::Up).expect("move up");
        assert_eq!(
            moved
                .goals
                .iter()
                .map(|goal| goal.objective.as_str())
                .collect::<Vec<_>>(),
            ["First", "Third", "Second"]
        );
        let boundary =
            move_at_path(&path, &first.id, GoalQueueMoveDirection::Up).expect("boundary no-op");
        assert_eq!(boundary, moved);

        let updated = update_at_path(&path, &third.id, "Updated".to_string()).expect("update goal");
        let updated_goal = updated
            .goals
            .iter()
            .find(|goal| goal.id == third.id)
            .expect("updated goal");
        assert_eq!(updated_goal.objective, "Updated");
        assert!(updated_goal.updated_at > third.updated_at);
        assert_eq!(updated_goal.created_at, third.created_at);

        let removed = remove_at_path(&path, &second.id).expect("remove goal");
        assert_eq!(removed.goals.len(), 2);
        assert!(removed.goals.iter().all(|goal| goal.id != second.id));
        assert!(remove_at_path(&path, "missing").is_err());
    }

    #[test]
    fn invalid_json_and_unknown_shapes_error_without_overwriting_user_data() {
        let (_directory, path) = queue_path();
        fs::write(&path, "{invalid").expect("invalid JSON");
        let error = read_queue_file(&path).expect_err("invalid JSON must fail");
        assert!(error.contains("Invalid JSON in goal queue"));
        assert_eq!(
            fs::read_to_string(&path).expect("invalid file remains"),
            "{invalid"
        );

        let unknown = r#"{"version":2,"goals":[]}"#;
        fs::write(&path, unknown).expect("unknown shape");
        let error = read_queue_file(&path).expect_err("unknown shape must fail");
        assert!(error.contains("Unsupported goal queue format"));
        assert_eq!(
            fs::read_to_string(&path).expect("unknown file remains"),
            unknown
        );
    }

    #[test]
    fn objective_limit_uses_javascript_utf16_length() {
        assert!(normalize_objective(&"x".repeat(4000)).is_ok());
        assert!(normalize_objective(&"x".repeat(4001)).is_err());
        assert!(normalize_objective(&"😀".repeat(2000)).is_ok());
        assert!(normalize_objective(&"😀".repeat(2001)).is_err());
    }

    #[test]
    fn public_store_uses_the_real_session_directory() {
        let directory = tempdir().expect("temp directory");
        let home = directory.path().join("kimi-home");
        let session_id = "queue-session";
        let session_dir = home.join("sessions").join("work-hash").join(session_id);
        fs::create_dir_all(&session_dir).expect("session directory");
        let _environment = set_kimi_code_home(&home);

        let snapshot = append(session_id, "Queued through session store").expect("append");
        assert_eq!(snapshot.goals.len(), 1);
        assert!(session_dir.join(GOAL_QUEUE_FILE).is_file());
        assert_eq!(read(session_id).expect("read"), snapshot);
        let queued_id = snapshot.goals[0].id.clone();
        assert!(consume_started(session_id, &queued_id).expect("consume created Goal"));
        assert!(read(session_id)
            .expect("read after consume")
            .goals
            .is_empty());
        assert!(!consume_started(session_id, &queued_id).expect("missing consume is harmless"));
    }
}
