//! M5 pre-cutover migration preflight for the source runtime.
//!
//! The desktop and the Kimi Code CLI share one home (`~/.kimi-code` or
//! `$KIMI_CODE_HOME`). Sessions created before the cutover may carry journals
//! the source runtime rewrites in place on first open, so we take a one-time
//! backup and record a migration marker before that can happen. Discipline
//! (maintenance doc §6): the scan is read-only; the backup is a copy, never a
//! move; the marker is an idempotent atomic write (temp+fsync+rename) that
//! runs only after the backup completes; `backup-complete.json` records a
//! finished backup so an interrupted run retries without double-copying.
//!
//! Engine behavior this guards (vendored 0.33.0 source): `wireService.ts:135`
//! prepends a metadata record and runs `migrateV1_4ToV1_5` when a journal's
//! first record is not metadata, then atomically rewrites the whole journal
//! on first session open. A well-formed `metadata` first record (v1.5) is
//! untouched; legacy `~/.kimi`-style sessions are never auto-migrated (only
//! `kimi migrate`), so they are reported and backed up.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Marker directory and file under the Kimi Code home. Its presence means
/// "the pre-cutover preflight already ran"; its write commits the preflight.
const MARKER_DIR: &str = "migrations";
const MARKER_NAME: &str = "2026-08-source-runtime.json";

/// Backup root and directory prefix under the Kimi Code home.
const BACKUP_ROOT: &str = "backups";
const BACKUP_DIR_PREFIX: &str = "pre-source-runtime";

/// Written last in a backup; lets an interrupted run reuse it (no marker yet).
const BACKUP_COMPLETE_FILE: &str = "backup-complete.json";

/// If everything under `<home>/sessions` totals more than this, the backup
/// copies only per-session metadata (`state.json`/`wire.jsonl`/`context.jsonl`)
/// plus the index — not uploads/logs. Journals are the migration subjects and
/// stay small; the size explosion is user uploads the cutover never touches.
const FULL_BACKUP_MAX_BYTES: u64 = 500 * 1024 * 1024;

/// Cap for the first-line probe. A record longer than this is conservatively
/// treated as v1 — it can never be the tiny metadata record.
const FIRST_LINE_CAP: u64 = 4 * 1024 * 1024;

static NEXT_ATOMIC_WRITE_ID: AtomicU64 = AtomicU64::new(1);

/// Read-only result of `preflight_scan`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MigrationReport {
    /// Total session directories found (sum of the counts below).
    pub total_sessions: usize,
    /// v1 journals (first record is not metadata); the engine rewrites these.
    pub v1_sessions: usize,
    /// v1.5 journals (well-formed metadata first record); current format.
    pub v1_5_sessions: usize,
    /// Old CLI layout (`context.jsonl`/root `wire.jsonl`); engine cannot read.
    pub legacy_sessions: usize,
    /// Directories matching no known layout (unreadable journal, debris).
    pub unrecognized_sessions: usize,
    /// Bytes of every file under `<home>/sessions`; drives backup scope.
    pub total_bytes: u64,
}

impl MigrationReport {
    /// Sessions needing protection: v1 journals the engine will rewrite and
    /// legacy sessions the engine cannot read.
    pub fn needs_backup(&self) -> bool {
        self.v1_sessions > 0 || self.legacy_sessions > 0
    }
}

/// Outcome of `ensure_backup_and_marker`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupOutcome {
    /// Backup created (or a completed one reused after an interrupt) and the
    /// migration marker written.
    BackedUp { backup_dir: PathBuf },
    /// The migration marker already existed; nothing was written.
    MarkerPresent { marker_path: PathBuf },
    /// Nothing needed migrating; no marker was written.
    NothingToMigrate,
}

/// Scan a Kimi Code home. Read-only: never creates or modifies anything.
pub fn preflight_scan(home: &Path) -> MigrationReport {
    let mut report = MigrationReport::default();
    let sessions_dir = home.join("sessions");
    if !sessions_dir.is_dir() {
        return report;
    }
    let Ok(level1) = fs::read_dir(&sessions_dir) else {
        return report;
    };
    for entry in level1.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            // Stray file in the sessions root is not a workspace; surface it.
            report.unrecognized_sessions += 1;
            report.total_sessions += 1;
            if let Ok(meta) = fs::metadata(&path) {
                report.total_bytes += meta.len();
            }
            continue;
        }
        // Byte accounting for the workspace subtree (uploads/logs included).
        report.total_bytes += walk_dir_sizes(&path);

        let Ok(level2) = fs::read_dir(&path) else {
            continue;
        };
        for session_entry in level2.flatten() {
            let session_dir = session_entry.path();
            if !session_entry.file_type().is_ok_and(|ft| ft.is_dir()) {
                continue;
            }
            report.total_sessions += 1;
            classify_session(&session_dir, &mut report);
        }
    }
    report
}

/// Take a one-time backup and write the migration marker when the report
/// found sessions that need migrating. Idempotent and retry-safe.
pub fn ensure_backup_and_marker(
    home: &Path,
    report: &MigrationReport,
) -> Result<BackupOutcome, String> {
    ensure_backup_and_marker_impl(home, report, FULL_BACKUP_MAX_BYTES)
}

fn ensure_backup_and_marker_impl(
    home: &Path,
    report: &MigrationReport,
    full_backup_max_bytes: u64,
) -> Result<BackupOutcome, String> {
    let marker_path = home.join(MARKER_DIR).join(MARKER_NAME);
    if marker_path.is_file() {
        return Ok(BackupOutcome::MarkerPresent { marker_path });
    }
    if !report.needs_backup() {
        return Ok(BackupOutcome::NothingToMigrate);
    }
    // A previous run finished its backup but crashed before the marker:
    // reuse it instead of copying everything again.
    let backup_root = home.join(BACKUP_ROOT);
    if let Some(existing) = find_completed_backup(&backup_root) {
        write_marker(home, report, &existing)?;
        return Ok(BackupOutcome::BackedUp {
            backup_dir: existing,
        });
    }
    let backup_dir = backup_root.join(format!("{BACKUP_DIR_PREFIX}-{}", epoch_secs()));
    let stats = backup_sessions(home, report, &backup_dir, full_backup_max_bytes)?;
    write_backup_complete(&backup_dir, report, &stats)?;
    write_marker(home, report, &backup_dir)?;
    Ok(BackupOutcome::BackedUp { backup_dir })
}

/// Best-effort startup preflight, called once from `lib.rs` app setup before
/// any session can be opened. Never blocks the app; failures surface as
/// logged diagnostics only. Skips the scan once the marker exists, so
/// steady-state launches cost one `stat`.
pub fn run_startup_preflight() -> Result<(), String> {
    let home = crate::runtime_check::kimi_code_home_dir()?;
    if home.join(MARKER_DIR).join(MARKER_NAME).is_file() {
        return Ok(());
    }
    let report = preflight_scan(&home);
    if let BackupOutcome::BackedUp { backup_dir } = ensure_backup_and_marker(&home, &report)? {
        eprintln!(
            "[migrate] source-runtime preflight: backed up {} sessions ({} bytes) to {}",
            report.total_sessions,
            report.total_bytes,
            backup_dir.display()
        );
    }
    Ok(())
}

/// Classify one session directory and fold it into the report.
fn classify_session(session_dir: &Path, report: &mut MigrationReport) {
    let journal = session_dir.join("agents").join("main").join("wire.jsonl");
    if journal.is_file() {
        match classify_wire_journal(&journal) {
            SessionKind::V1 => report.v1_sessions += 1,
            SessionKind::V15 => report.v1_5_sessions += 1,
            SessionKind::Unrecognized => report.unrecognized_sessions += 1,
        }
        return;
    }
    // No agents/main journal: legacy CLI layout, or debris.
    if session_dir.join("context.jsonl").is_file() || session_dir.join("wire.jsonl").is_file() {
        report.legacy_sessions += 1;
    } else {
        report.unrecognized_sessions += 1;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionKind {
    V1,
    V15,
    Unrecognized,
}

/// Classify an `agents/main/wire.jsonl` journal by its first non-empty line,
/// mirroring the engine's restore logic (`wireService.ts:135`).
fn classify_wire_journal(path: &Path) -> SessionKind {
    let Ok(file) = fs::File::open(path) else {
        return SessionKind::Unrecognized;
    };
    let mut limited = file.take(FIRST_LINE_CAP);
    let mut buf = Vec::new();
    let Ok(read) = limited.read_to_end(&mut buf) else {
        return SessionKind::Unrecognized;
    };
    let text = String::from_utf8_lossy(&buf);
    let Some(first) = text.lines().find(|l| !l.trim().is_empty()) else {
        // Empty or blank-only journal: the engine seals it (writes a metadata
        // record) on first open — a benign rewrite of an empty file.
        return SessionKind::V1;
    };
    let Ok(value) = serde_json::from_str::<Value>(first) else {
        // Unparseable line: the engine's decoder throws for a non-final line;
        // a cap-truncated line is just an over-long record, never the tiny
        // metadata record — conservatively v1.
        return if read >= FIRST_LINE_CAP as usize {
            SessionKind::V1
        } else {
            SessionKind::Unrecognized
        };
    };
    let Some(record) = value.as_object() else {
        // Valid JSON but not a wire record: the engine skips the line and
        // rewrites the journal (dropping it). Treat as v1.
        return SessionKind::V1;
    };
    match record.get("type").and_then(Value::as_str) {
        Some("metadata") if is_metadata_record(record) => SessionKind::V15,
        // `type == "metadata"` but malformed: the engine throws
        // `STORAGE_CORRUPTED` on restore. Report only.
        Some("metadata") => SessionKind::Unrecognized,
        Some(_) | None => SessionKind::V1,
    }
}

fn is_metadata_record(record: &serde_json::Map<String, Value>) -> bool {
    record
        .get("protocol_version")
        .and_then(Value::as_str)
        .is_some()
        && record
            .get("created_at")
            .and_then(Value::as_number)
            .is_some()
}

/// True for per-session files the preflight always backs up. `rel` is a path
/// relative to the sessions root: `<workspace>/<session>/...`.
fn is_session_metadata_file(rel: &Path) -> bool {
    let mut parts = rel.components();
    if parts.next().is_none() || parts.next().is_none() {
        return false;
    }
    let rest = parts.as_path();
    rest == Path::new("state.json")
        || rest == Path::new("context.jsonl")
        || rest == Path::new("wire.jsonl")
        || rest == Path::new("agents/main/wire.jsonl")
}

/// Recursively sum file sizes under `dir`. Skips symlinks.
fn walk_dir_sizes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            total += walk_dir_sizes(&path);
        } else if file_type.is_file() {
            if let Ok(meta) = fs::metadata(&path) {
                total += meta.len();
            }
        }
    }
    total
}

struct CopiedStats {
    files: u64,
    bytes: u64,
}

/// Copy session data into `backup_dir`. Per-session metadata (`state.json`,
/// `wire.jsonl`, `context.jsonl`) is always copied; other files (uploads,
/// logs) only when the sessions tree fits within `full_backup_max_bytes`.
/// The completion file embeds the scan report as the backup's index.
fn backup_sessions(
    home: &Path,
    report: &MigrationReport,
    backup_dir: &Path,
    full_backup_max_bytes: u64,
) -> Result<CopiedStats, String> {
    fs::create_dir_all(backup_dir)
        .map_err(|e| format!("Failed to create {}: {e}", backup_dir.display()))?;
    let mut stats = CopiedStats { files: 0, bytes: 0 };

    let sessions_dir = home.join("sessions");
    if sessions_dir.is_dir() {
        let full = report.total_bytes <= full_backup_max_bytes;
        let is_metadata = |path: &Path| {
            path.strip_prefix(&sessions_dir)
                .map(is_session_metadata_file)
                .unwrap_or(false)
        };
        copy_tree(
            &sessions_dir,
            &backup_dir.join("sessions"),
            full,
            &is_metadata,
            &mut stats,
        )?;
    }
    Ok(stats)
}

/// Recursive copy of `src` into `dst`, skipping symlinks. Non-metadata files
/// are copied only when `full` is true.
fn copy_tree(
    src: &Path,
    dst: &Path,
    full: bool,
    is_metadata: &dyn Fn(&Path) -> bool,
    stats: &mut CopiedStats,
) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("Failed to create {}: {e}", dst.display()))?;
    let entries =
        fs::read_dir(src).map_err(|e| format!("Failed to read {}: {e}", src.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&path, &target, full, is_metadata, stats)?;
        } else if file_type.is_file() && (is_metadata(&path) || full) {
            let copied = fs::copy(&path, &target)
                .map_err(|e| format!("Failed to copy {}: {e}", path.display()))?;
            stats.files += 1;
            stats.bytes += copied;
        }
    }
    Ok(())
}

/// Record a finished backup so an interrupted run can reuse it.
fn write_backup_complete(
    backup_dir: &Path,
    report: &MigrationReport,
    stats: &CopiedStats,
) -> Result<(), String> {
    let body = json!({
        "completed_at": rfc3339_now(),
        "files": stats.files,
        "bytes": stats.bytes,
        "report": report,
    });
    let bytes = serde_json::to_vec_pretty(&body)
        .map_err(|e| format!("Failed to serialize backup completion: {e}"))?;
    write_atomic(&backup_dir.join(BACKUP_COMPLETE_FILE), &bytes)
}

/// Find a completed backup dir (has `backup-complete.json`) under `backup_root`.
fn find_completed_backup(backup_root: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(backup_root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir()
            && name.starts_with(BACKUP_DIR_PREFIX)
            && path.join(BACKUP_COMPLETE_FILE).is_file()
        {
            return Some(path);
        }
    }
    None
}

/// Write the migration marker: timestamp, app version, backup location and
/// scan summary. Atomic (temp + rename) and idempotent.
fn write_marker(home: &Path, report: &MigrationReport, backup_dir: &Path) -> Result<(), String> {
    let dir = home.join(MARKER_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    // Remove tmp leftovers from an interrupted attempt so a retry is clean.
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!(".{MARKER_NAME}.tmp."))
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    let rel_backup = backup_dir
        .strip_prefix(home)
        .unwrap_or(backup_dir)
        .to_string_lossy()
        .replace('\\', "/");
    let body = json!({
        "name": MARKER_NAME.strip_suffix(".json").unwrap_or(MARKER_NAME),
        "created_at": rfc3339_now(),
        "app_version": env!("CARGO_PKG_VERSION"),
        "backup_dir": rel_backup,
        "report": report,
    });
    let bytes = serde_json::to_vec_pretty(&body)
        .map_err(|e| format!("Failed to serialize migration marker: {e}"))?;
    write_atomic(&dir.join(MARKER_NAME), &bytes)
}

/// Atomic file write: temp + fsync + rename, so a crash never leaves a torn
/// file at the final path.
fn write_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("No parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    let unique = NEXT_ATOMIC_WRITE_ID.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("migrate");
    let tmp = parent.join(format!(".{name}.tmp.{}.{unique}", std::process::id()));
    let result = (|| {
        let mut file =
            fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        file.write_all(body)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
        fs::rename(&tmp, path).map_err(|e| format!("rename {}: {e}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn rfc3339_now() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tempfile::tempdir;

    const WS: &str = "0123456789abcdef0123456789abcdef";
    const V1: &str = "{\"type\":\"context.append_message\",\"time\":1,\"message\":{}}\n";
    const V15: &str =
        "{\"type\":\"metadata\",\"protocol_version\":\"1.5\",\"created_at\":1}\n{\"type\":\"x\",\"time\":1}\n";
    const ST: &str = "{\"version\":2}\n";
    const CTX: &str = "{\"role\":\"user\"}\n";

    fn p(h: &Path, sid: &str) -> PathBuf {
        h.join("sessions").join(WS).join(sid)
    }
    fn j(h: &Path, sid: &str) -> PathBuf {
        p(h, sid).join("agents/main/wire.jsonl")
    }
    fn w(p: &Path, b: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b).unwrap();
    }
    fn v1(h: &Path, sid: &str) {
        w(&j(h, sid), V1);
        w(&p(h, sid).join("state.json"), ST);
    }
    fn v15(h: &Path, sid: &str) {
        w(&j(h, sid), V15);
        w(&p(h, sid).join("state.json"), ST);
    }
    fn leg(h: &Path, sid: &str) {
        w(&p(h, sid).join("context.jsonl"), CTX);
        w(&p(h, sid).join("state.json"), ST);
    }
    fn backup(h: &Path) -> PathBuf {
        match ensure_backup_and_marker(h, &preflight_scan(h)).unwrap() {
            BackupOutcome::BackedUp { backup_dir } => backup_dir,
            other => panic!("expected BackedUp, got {other:?}"),
        }
    }
    fn has(b: &Path, sid: &str, rel: &str) -> bool {
        b.join("sessions").join(WS).join(sid).join(rel).is_file()
    }

    #[test]
    fn scan_classifies_shapes() {
        let h = tempdir().unwrap();
        v1(h.path(), "a");
        v1(h.path(), "b");
        v15(h.path(), "c");
        leg(h.path(), "d");
        w(&p(h.path(), "e").join("state.json"), "{}"); // unrecognized
        w(&j(h.path(), "f"), ""); // empty journal -> v1 (sealed on open)
        w(&j(h.path(), "g"), "not json\n"); // corrupt first line -> unrecognized
        w(&j(h.path(), "h"), "{\"type\":\"metadata\"}\n"); // malformed -> unrecognized
        w(&h.path().join("sessions").join("stray"), "x"); // stray file
        let r = preflight_scan(h.path());
        assert_eq!(
            (
                r.total_sessions,
                r.v1_sessions,
                r.v1_5_sessions,
                r.legacy_sessions,
                r.unrecognized_sessions,
            ),
            (9, 3, 1, 1, 4)
        );
        assert!(r.needs_backup());
    }

    #[test]
    fn empty_and_v15_homes_are_noop() {
        let e = tempdir().unwrap();
        let r = preflight_scan(e.path());
        assert_eq!(r.total_sessions, 0);
        assert!(!r.needs_backup());
        assert_eq!(
            ensure_backup_and_marker(e.path(), &r).unwrap(),
            BackupOutcome::NothingToMigrate
        );
        assert!(!e.path().join("backups").exists() && !e.path().join("migrations").exists());

        let v = tempdir().unwrap();
        v15(v.path(), "a");
        let r = preflight_scan(v.path());
        assert_eq!(r.v1_5_sessions, 1);
        assert_eq!(
            ensure_backup_and_marker(v.path(), &r).unwrap(),
            BackupOutcome::NothingToMigrate
        );
    }

    #[test]
    fn first_run_backs_up_and_writes_marker() {
        let h = tempdir().unwrap();
        v1(h.path(), "a");
        v15(h.path(), "b");
        leg(h.path(), "c");
        w(&p(h.path(), "b").join("files").join("up.bin"), "data");
        let b = backup(h.path());
        assert_eq!(fs::read_to_string(j(h.path(), "a")).unwrap(), V1); // originals untouched
        assert!(has(&b, "a", "agents/main/wire.jsonl") && has(&b, "a", "state.json"));
        assert!(has(&b, "b", "agents/main/wire.jsonl"));
        assert!(has(&b, "c", "context.jsonl"));
        assert!(has(&b, "b", "files/up.bin"));
        assert!(b.join(BACKUP_COMPLETE_FILE).is_file());
        let marker = h.path().join("migrations").join(MARKER_NAME);
        let m: Value = serde_json::from_slice(&fs::read(&marker).unwrap()).unwrap();
        assert_eq!(m["name"], "2026-08-source-runtime");
        assert_eq!(m["report"]["v1_sessions"], 1);
        assert!(m["backup_dir"]
            .as_str()
            .unwrap()
            .starts_with("backups/pre-source-runtime-"));

        // Second run: marker present, no new backup.
        let out = ensure_backup_and_marker(h.path(), &preflight_scan(h.path())).unwrap();
        assert!(matches!(out, BackupOutcome::MarkerPresent { .. }));
        assert_eq!(fs::read_dir(h.path().join("backups")).unwrap().count(), 1);
    }

    #[test]
    fn stale_marker_tmp_retried() {
        let h = tempdir().unwrap();
        v1(h.path(), "a");
        let dir = h.path().join("migrations");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!(".{MARKER_NAME}.tmp.999.1")),
            "{\"half\":\"wri",
        )
        .unwrap();
        backup(h.path());
        let m: Value = serde_json::from_slice(&fs::read(dir.join(MARKER_NAME)).unwrap()).unwrap();
        assert!(m["created_at"].is_string());
        let leftover = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains(".tmp."));
        assert!(!leftover);
    }

    #[test]
    fn crash_between_backup_and_marker_reuses_backup() {
        let h = tempdir().unwrap();
        v1(h.path(), "a");
        let bdir = h.path().join("backups").join("pre-source-runtime-123");
        fs::create_dir_all(&bdir).unwrap();
        fs::write(bdir.join(BACKUP_COMPLETE_FILE), "{}").unwrap();
        let r = preflight_scan(h.path());
        let out = ensure_backup_and_marker(h.path(), &r).unwrap();
        assert_eq!(
            out,
            BackupOutcome::BackedUp {
                backup_dir: bdir.clone()
            }
        );
        assert_eq!(fs::read_dir(h.path().join("backups")).unwrap().count(), 1);
        assert!(h.path().join("migrations").join(MARKER_NAME).is_file());
    }

    #[test]
    fn over_threshold_backs_up_metadata_only() {
        let h = tempdir().unwrap();
        v1(h.path(), "a");
        v15(h.path(), "b");
        w(&p(h.path(), "b").join("files").join("up.bin"), "data");
        let r = preflight_scan(h.path());
        let out = ensure_backup_and_marker_impl(h.path(), &r, 1).unwrap();
        let BackupOutcome::BackedUp { backup_dir: b } = out else {
            panic!("expected BackedUp");
        };
        // Metadata set (state.json + wire.jsonl) is always copied...
        assert!(has(&b, "a", "agents/main/wire.jsonl"));
        assert!(has(&b, "b", "agents/main/wire.jsonl"));
        assert!(has(&b, "b", "state.json"));
        // ...but non-metadata files (uploads) are skipped when over threshold.
        assert!(!has(&b, "b", "files/up.bin"));
        assert!(h.path().join("migrations").join(MARKER_NAME).is_file());
    }
}
