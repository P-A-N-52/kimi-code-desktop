//! Git diff stats for a session workspace directory.

use serde_json::{json, Value};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

const GIT_TIMEOUT: Duration = Duration::from_secs(5);

pub fn get_git_diff_stats_for_work_dir(work_dir: &Path) -> Value {
    if !work_dir.join(".git").exists() {
        return json!({
            "is_git_repo": false,
            "has_changes": false,
            "total_additions": 0,
            "total_deletions": 0,
            "files": [],
            "error": Value::Null,
        });
    }

    match collect_git_diff_stats(work_dir) {
        Ok(result) => result,
        Err(error) => json!({
            "is_git_repo": true,
            "has_changes": false,
            "total_additions": 0,
            "total_deletions": 0,
            "files": [],
            "error": error,
        }),
    }
}

fn collect_git_diff_stats(work_dir: &Path) -> Result<Value, String> {
    let mut files = Vec::new();
    let mut total_additions = 0u64;
    let mut total_deletions = 0u64;

    let has_head = git_command(work_dir, &["rev-parse", "--verify", "HEAD"])?
        .status
        .success();

    if has_head {
        let output = git_command(work_dir, &["diff", "--numstat", "HEAD"])?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git diff failed: {}", stderr.trim()));
        }

        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if line.trim().is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            let additions = parse_numstat_field(parts[0]);
            let deletions = parse_numstat_field(parts[1]);
            total_additions += additions;
            total_deletions += deletions;

            let status = if deletions == 0 && additions > 0 {
                "added"
            } else if additions == 0 && deletions > 0 {
                "deleted"
            } else {
                "modified"
            };

            files.push(json!({
                "path": parts[2],
                "additions": additions,
                "deletions": deletions,
                "status": status,
            }));
        }
    }

    let untracked = git_command(work_dir, &["ls-files", "--others", "--exclude-standard"])?;
    if !untracked.status.success() {
        let stderr = String::from_utf8_lossy(&untracked.stderr);
        return Err(format!("git ls-files failed: {}", stderr.trim()));
    }

    for line in String::from_utf8_lossy(&untracked.stdout).lines() {
        if line.is_empty() {
            continue;
        }
        files.push(json!({
            "path": line,
            "additions": 0,
            "deletions": 0,
            "status": "added",
        }));
    }

    Ok(json!({
        "is_git_repo": true,
        "has_changes": !files.is_empty(),
        "total_additions": total_additions,
        "total_deletions": total_deletions,
        "files": files,
        "error": Value::Null,
    }))
}

fn parse_numstat_field(value: &str) -> u64 {
    if value == "-" {
        0
    } else {
        value.parse().unwrap_or(0)
    }
}

fn git_command(work_dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    use std::process::Child;
    use std::sync::{Arc, Mutex};

    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = command
        .spawn()
        .map_err(|err| format!("Failed to spawn git: {err}"))?;

    let shared_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));
    let worker_child = Arc::clone(&shared_child);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut guard = worker_child.lock().expect("git child lock");
        if let Some(child) = guard.take() {
            let _ = tx.send(child.wait_with_output());
        }
    });

    match rx.recv_timeout(GIT_TIMEOUT) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(err)) => Err(format!("Failed to read git output: {err}")),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            if let Some(mut child) = shared_child.lock().expect("git child lock").take() {
                let _ = child.kill();
            }
            Err("Git command timed out".to_string())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("Git command worker exited unexpectedly".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn run_git(work_dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(work_dir)
            .status()
            .expect("git command");
        assert!(status.success(), "git {:?} failed", args);
    }

    #[test]
    fn git_diff_stats_non_repo_reports_not_git() {
        let temp = tempfile::tempdir().expect("tempdir");
        let stats = get_git_diff_stats_for_work_dir(temp.path());
        assert_eq!(stats["is_git_repo"], false);
        assert_eq!(stats["has_changes"], false);
    }

    #[test]
    fn git_diff_stats_reports_tracked_and_untracked_changes() {
        if !git_available() {
            eprintln!("skipping git diff test: git not available");
            return;
        }

        let temp = tempfile::tempdir().expect("tempdir");
        run_git(temp.path(), &["init"]);
        run_git(temp.path(), &["config", "user.email", "test@example.com"]);
        run_git(temp.path(), &["config", "user.name", "Test User"]);

        std::fs::write(temp.path().join("tracked.txt"), b"v1\n").expect("write tracked");
        run_git(temp.path(), &["add", "tracked.txt"]);
        run_git(temp.path(), &["commit", "-m", "initial"]);

        std::fs::write(temp.path().join("tracked.txt"), b"v2\n").expect("modify tracked");
        std::fs::write(temp.path().join("new.txt"), b"hello\n").expect("write untracked");

        let stats = get_git_diff_stats_for_work_dir(temp.path());
        assert_eq!(stats["is_git_repo"], true);
        assert_eq!(stats["has_changes"], true);
        assert_eq!(stats["total_additions"], 1);
        assert_eq!(stats["total_deletions"], 1);

        let files = stats["files"].as_array().expect("files array");
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|file| file["path"] == "tracked.txt"));
        assert!(files.iter().any(|file| file["path"] == "new.txt"));
    }
}
