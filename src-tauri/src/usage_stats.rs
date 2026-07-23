//! Aggregate local session `usage.record` entries for Today / 7d / 30d stats.

use crate::session_store::sessions_root;
use chrono::{Duration, Local, NaiveDate, Timelike};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatsRange {
    Today,
    Days7,
    Days30,
}

impl StatsRange {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "today" => Ok(Self::Today),
            "7d" | "7" => Ok(Self::Days7),
            "30d" | "30" => Ok(Self::Days30),
            other => Err(format!(
                "Invalid usage stats range '{other}'. Expected today, 7d, or 30d."
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Today => "today",
            Self::Days7 => "7d",
            Self::Days30 => "30d",
        }
    }
}

#[derive(Debug, Default, Clone)]
struct TokenBucket {
    requests: u64,
    input_other: u64,
    output: u64,
    input_cache_read: u64,
    input_cache_creation: u64,
}

impl TokenBucket {
    fn add(&mut self, other: &TokenBucket) {
        self.requests += other.requests;
        self.input_other += other.input_other;
        self.output += other.output;
        self.input_cache_read += other.input_cache_read;
        self.input_cache_creation += other.input_cache_creation;
    }

    fn total_tokens(&self) -> u64 {
        self.input_other + self.output + self.input_cache_read + self.input_cache_creation
    }

    fn to_json(&self) -> Value {
        json!({
            "requests": self.requests,
            "inputOther": self.input_other,
            "output": self.output,
            "inputCacheRead": self.input_cache_read,
            "inputCacheCreation": self.input_cache_creation,
            "totalTokens": self.total_tokens(),
        })
    }

    fn to_series_json(&self, key: &str) -> Value {
        json!({
            "key": key,
            "requests": self.requests,
            "inputOther": self.input_other,
            "output": self.output,
            "inputCacheRead": self.input_cache_read,
            "inputCacheCreation": self.input_cache_creation,
            "totalTokens": self.total_tokens(),
        })
    }

    fn to_model_json(&self, model: &str) -> Value {
        json!({
            "model": model,
            "requests": self.requests,
            "inputOther": self.input_other,
            "output": self.output,
            "inputCacheRead": self.input_cache_read,
            "inputCacheCreation": self.input_cache_creation,
            "totalTokens": self.total_tokens(),
        })
    }
}

fn to_u64(value: &Value) -> u64 {
    match value {
        Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_i64().map(|v| v.max(0) as u64))
            .or_else(|| {
                n.as_f64().map(|v| {
                    if v.is_finite() && v > 0.0 {
                        v as u64
                    } else {
                        0
                    }
                })
            })
            .unwrap_or(0),
        Value::String(s) => s.parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

fn parse_usage_tokens(usage: &Value) -> Option<TokenBucket> {
    let obj = usage.as_object()?;
    Some(TokenBucket {
        requests: 1,
        input_other: to_u64(obj.get("inputOther").unwrap_or(&Value::Null)),
        output: to_u64(obj.get("output").unwrap_or(&Value::Null)),
        input_cache_read: to_u64(obj.get("inputCacheRead").unwrap_or(&Value::Null)),
        input_cache_creation: to_u64(obj.get("inputCacheCreation").unwrap_or(&Value::Null)),
    })
}

fn collect_wire_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    if !root.is_dir() {
        return Ok(paths);
    }

    let work_dirs =
        fs::read_dir(root).map_err(|e| format!("Failed to read {}: {e}", root.display()))?;
    for work_entry in work_dirs.flatten() {
        let work_path = work_entry.path();
        if !work_path.is_dir() {
            continue;
        }
        let sessions = match fs::read_dir(&work_path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for session_entry in sessions.flatten() {
            let session_path = session_entry.path();
            if !session_path.is_dir() {
                continue;
            }

            let legacy = session_path.join("wire.jsonl");
            if legacy.is_file() {
                paths.push(legacy);
            }

            let agents_dir = session_path.join("agents");
            if !agents_dir.is_dir() {
                continue;
            }
            let agents = match fs::read_dir(&agents_dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for agent_entry in agents.flatten() {
                let agent_path = agent_entry.path();
                if !agent_path.is_dir() {
                    continue;
                }
                let wire = agent_path.join("wire.jsonl");
                if wire.is_file() {
                    paths.push(wire);
                }
            }
        }
    }

    Ok(paths)
}

fn series_keys(range: StatsRange, today: NaiveDate) -> Vec<String> {
    match range {
        StatsRange::Today => (0u32..24).map(|h| format!("{h:02}")).collect(),
        StatsRange::Days7 => {
            let start = today - Duration::days(6);
            (0..7)
                .map(|offset| {
                    (start + Duration::days(offset))
                        .format("%Y-%m-%d")
                        .to_string()
                })
                .collect()
        }
        StatsRange::Days30 => {
            let start = today - Duration::days(29);
            (0..30)
                .map(|offset| {
                    (start + Duration::days(offset))
                        .format("%Y-%m-%d")
                        .to_string()
                })
                .collect()
        }
    }
}

fn local_midnight_ms(date: NaiveDate) -> i64 {
    let naive = date.and_hms_opt(0, 0, 0).expect("valid midnight");
    naive
        .and_local_timezone(Local)
        .earliest()
        .or_else(|| naive.and_local_timezone(Local).latest())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

fn window_start_ms(range: StatsRange, now: chrono::DateTime<Local>) -> i64 {
    let today = now.date_naive();
    match range {
        StatsRange::Today => local_midnight_ms(today),
        StatsRange::Days7 => local_midnight_ms(today - Duration::days(6)),
        StatsRange::Days30 => local_midnight_ms(today - Duration::days(29)),
    }
}

fn bucket_key(range: StatsRange, time_ms: i64) -> Option<String> {
    let dt = chrono::DateTime::from_timestamp_millis(time_ms)?.with_timezone(&Local);
    Some(match range {
        StatsRange::Today => format!("{:02}", dt.hour()),
        StatsRange::Days7 | StatsRange::Days30 => dt.format("%Y-%m-%d").to_string(),
    })
}

fn ingest_wire_file(
    path: &Path,
    range: StatsRange,
    start_ms: i64,
    end_ms: i64,
    summary: &mut TokenBucket,
    series: &mut BTreeMap<String, TokenBucket>,
    by_model: &mut BTreeMap<String, TokenBucket>,
) -> u64 {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return 0,
    };
    let reader = BufReader::new(file);
    let mut matched = 0u64;

    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("usage.record") {
            continue;
        }
        if record.get("usageScope").and_then(Value::as_str) != Some("turn") {
            continue;
        }
        let time_ms = match record.get("time") {
            Some(v) => to_u64(v) as i64,
            None => continue,
        };
        if time_ms < start_ms || time_ms > end_ms {
            continue;
        }
        let Some(usage) = record.get("usage").and_then(parse_usage_tokens) else {
            continue;
        };
        let Some(key) = bucket_key(range, time_ms) else {
            continue;
        };

        summary.add(&usage);
        series.entry(key).or_default().add(&usage);

        let model = record
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        by_model.entry(model).or_default().add(&usage);
        matched += 1;
    }

    matched
}

/// Scan local session wires and aggregate turn-scoped usage for a time range.
pub fn fetch_usage_stats(range_raw: &str) -> Result<Value, String> {
    let range = StatsRange::parse(range_raw)?;
    let now = Local::now();
    let today = now.date_naive();
    let start_ms = window_start_ms(range, now);
    let end_ms = now.timestamp_millis();

    let root = sessions_root()?;
    let wires = collect_wire_paths(&root)?;
    let scanned_files = wires.len();

    let mut summary = TokenBucket::default();
    let mut series_map: BTreeMap<String, TokenBucket> = BTreeMap::new();
    let mut by_model_map: BTreeMap<String, TokenBucket> = BTreeMap::new();
    let mut record_count = 0u64;

    for path in &wires {
        record_count += ingest_wire_file(
            path,
            range,
            start_ms,
            end_ms,
            &mut summary,
            &mut series_map,
            &mut by_model_map,
        );
    }

    let keys = series_keys(range, today);
    let series: Vec<Value> = keys
        .iter()
        .map(|key| {
            series_map
                .get(key)
                .cloned()
                .unwrap_or_default()
                .to_series_json(key)
        })
        .collect();

    let mut by_model: Vec<(String, TokenBucket)> = by_model_map.into_iter().collect();
    by_model.sort_by(|a, b| {
        b.1.total_tokens()
            .cmp(&a.1.total_tokens())
            .then_with(|| a.0.cmp(&b.0))
    });
    let by_model: Vec<Value> = by_model
        .into_iter()
        .map(|(model, bucket)| bucket.to_model_json(&model))
        .collect();

    let mut out = Map::new();
    out.insert("range".into(), json!(range.as_str()));
    out.insert("summary".into(), summary.to_json());
    out.insert("series".into(), Value::Array(series));
    out.insert("byModel".into(), Value::Array(by_model));
    out.insert("scannedFiles".into(), json!(scanned_files));
    out.insert("recordCount".into(), json!(record_count));
    out.insert("startMs".into(), json!(start_ms));
    out.insert("endMs".into(), json!(end_ms));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_wire(path: &Path, lines: &[&str]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = File::create(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(StatsRange::parse("today").unwrap(), StatsRange::Today);
        assert_eq!(StatsRange::parse("7d").unwrap(), StatsRange::Days7);
        assert_eq!(StatsRange::parse("30d").unwrap(), StatsRange::Days30);
        assert!(StatsRange::parse("year").is_err());
    }

    #[test]
    fn aggregates_turn_records_and_skips_session_scope() {
        let dir = tempdir().unwrap();
        let wire = dir
            .path()
            .join("wd")
            .join("session_a")
            .join("agents")
            .join("main")
            .join("wire.jsonl");

        let now = Local::now();
        let t1 = now.timestamp_millis();
        let hour_key = format!("{:02}", now.hour());

        write_wire(
            &wire,
            &[
                &format!(
                    r#"{{"type":"usage.record","model":"kimi-k2","usage":{{"inputOther":10,"output":2,"inputCacheRead":1,"inputCacheCreation":0}},"usageScope":"turn","time":{t1}}}"#
                ),
                &format!(
                    r#"{{"type":"usage.record","model":"kimi-k2","usage":{{"inputOther":100,"output":20,"inputCacheRead":0,"inputCacheCreation":0}},"usageScope":"session","time":{t1}}}"#
                ),
                &format!(
                    r#"{{"type":"usage.record","model":"other","usage":{{"inputOther":5,"output":1,"inputCacheRead":0,"inputCacheCreation":3}},"usageScope":"turn","time":{t1}}}"#
                ),
            ],
        );

        // Point sessions_root via env used by kimi_code_home — tests use direct ingest instead.
        let mut summary = TokenBucket::default();
        let mut series = BTreeMap::new();
        let mut by_model = BTreeMap::new();
        let matched = ingest_wire_file(
            &wire,
            StatsRange::Today,
            t1 - 1000,
            t1 + 1000,
            &mut summary,
            &mut series,
            &mut by_model,
        );

        assert_eq!(matched, 2);
        assert_eq!(summary.requests, 2);
        assert_eq!(summary.input_other, 15);
        assert_eq!(summary.output, 3);
        assert_eq!(summary.input_cache_read, 1);
        assert_eq!(summary.input_cache_creation, 3);
        assert_eq!(summary.total_tokens(), 22);
        assert_eq!(series.get(&hour_key).map(|b| b.requests), Some(2));
        assert_eq!(by_model.len(), 2);
    }

    #[test]
    fn series_keys_cover_full_windows() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 22).unwrap();
        assert_eq!(series_keys(StatsRange::Today, today).len(), 24);
        assert_eq!(series_keys(StatsRange::Days7, today).len(), 7);
        assert_eq!(
            series_keys(StatsRange::Days7, today)
                .first()
                .map(String::as_str),
            Some("2026-07-16")
        );
        assert_eq!(
            series_keys(StatsRange::Days30, today)
                .last()
                .map(String::as_str),
            Some("2026-07-22")
        );
    }
}
