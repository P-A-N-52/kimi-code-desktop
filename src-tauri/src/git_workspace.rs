//! Safe Git and GitHub CLI operations for a session workspace.

use crate::security::{validate_executable_path, validate_http_external_url};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant};

const READ_TIMEOUT: Duration = Duration::from_secs(15);
const MUTATION_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_COMMAND_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_COMMIT_MESSAGE: usize = 1_000;
static GIT_MUTATION_LOCKS: LazyLock<(Mutex<HashSet<PathBuf>>, Condvar)> =
    LazyLock::new(|| (Mutex::new(HashSet::new()), Condvar::new()));

struct MutationGuard(PathBuf);

impl MutationGuard {
    fn acquire(work_dir: &Path) -> Result<Self, String> {
        let key = work_dir
            .canonicalize()
            .map_err(|error| format!("Failed to resolve workspace for mutation: {error}"))?;
        let (locks, changed) = &*GIT_MUTATION_LOCKS;
        let mut active = locks
            .lock()
            .map_err(|_| "Git mutation lock failed".to_string())?;
        while active.contains(&key) {
            active = changed
                .wait(active)
                .map_err(|_| "Git mutation lock failed".to_string())?;
        }
        active.insert(key.clone());
        Ok(Self(key))
    }
}

impl Drop for MutationGuard {
    fn drop(&mut self) {
        let (locks, changed) = &*GIT_MUTATION_LOCKS;
        if let Ok(mut active) = locks.lock() {
            active.remove(&self.0);
            changed.notify_all();
        }
    }
}

#[derive(Clone)]
struct Executables {
    git: PathBuf,
    gh: Option<PathBuf>,
}

fn executable_candidates(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        // Command is invoked directly without a shell, so do not accept PATHEXT
        // script shims such as .cmd/.bat.
        vec![format!("{name}.exe")]
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

fn resolve_executable(name: &str) -> Result<PathBuf, String> {
    let path = std::env::var_os("PATH").ok_or_else(|| "PATH is not configured".to_string())?;
    let candidates = executable_candidates(name);
    for directory in std::env::split_paths(&path) {
        for candidate in &candidates {
            let path = directory.join(candidate);
            #[cfg(windows)]
            if path.to_string_lossy().starts_with(r"\\?\") {
                continue;
            }
            if path.is_file() {
                return validate_executable_path(&path);
            }
        }
    }
    Err(format!("{name} was not found on PATH"))
}

fn resolve_executables() -> Result<Executables, String> {
    Ok(Executables {
        git: resolve_executable("git")?,
        gh: resolve_executable("gh").ok(),
    })
}

fn command_output(
    executable: &Path,
    args: &[String],
    work_dir: &Path,
    timeout: Duration,
    stdin: Option<&str>,
) -> Result<Output, String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(work_dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env("PAGER", "cat")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to launch {}: {error}", executable.display()))?;
    if let Some(input) = stdin {
        if let Some(mut child_stdin) = child.stdin.take() {
            child_stdin
                .write_all(input.as_bytes())
                .map_err(|error| format!("Failed to write command input: {error}"))?;
        }
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Command stdout was not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Command stderr was not captured".to_string())?;
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_COMMAND_OUTPUT + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take((MAX_COMMAND_OUTPUT + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Failed to poll command: {error}"))?
        {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!(
                "Command timed out after {} seconds",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Command stdout reader failed".to_string())?
        .map_err(|error| format!("Failed to read command stdout: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Command stderr reader failed".to_string())?
        .map_err(|error| format!("Failed to read command stderr: {error}"))?;
    let output = Output {
        status,
        stdout,
        stderr,
    };

    if output.stdout.len() > MAX_COMMAND_OUTPUT || output.stderr.len() > MAX_COMMAND_OUTPUT {
        return Err("Command output exceeded the safety limit".to_string());
    }
    Ok(output)
}

fn text(output: &[u8]) -> String {
    String::from_utf8_lossy(output).trim().to_string()
}

fn command_error(label: &str, output: &Output) -> String {
    let detail = text(&output.stderr);
    if detail.is_empty() {
        format!("{label} failed with status {}", output.status)
    } else {
        format!("{label} failed: {detail}")
    }
}

fn git(executables: &Executables, work_dir: &Path, args: &[&str]) -> Result<Output, String> {
    command_output(
        &executables.git,
        &args
            .iter()
            .map(|value| (*value).to_string())
            .collect::<Vec<_>>(),
        work_dir,
        READ_TIMEOUT,
        None,
    )
}

fn git_owned(
    executables: &Executables,
    work_dir: &Path,
    args: Vec<String>,
    timeout: Duration,
) -> Result<Output, String> {
    command_output(&executables.git, &args, work_dir, timeout, None)
}

fn require_git_repo(executables: &Executables, work_dir: &Path) -> Result<(), String> {
    let output = git(
        executables,
        work_dir,
        &["rev-parse", "--is-inside-work-tree"],
    )?;
    if output.status.success() && text(&output.stdout) == "true" {
        Ok(())
    } else {
        Err("Current session directory is not a Git repository".to_string())
    }
}

fn current_head(executables: &Executables, work_dir: &Path) -> Result<String, String> {
    let output = git(
        executables,
        work_dir,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
    )?;
    if output.status.success() {
        Ok(text(&output.stdout))
    } else if text(&output.stderr).is_empty() {
        Ok(String::new())
    } else {
        Err(command_error("git rev-parse HEAD", &output))
    }
}

fn current_branch(executables: &Executables, work_dir: &Path) -> Result<String, String> {
    let output = git(executables, work_dir, &["branch", "--show-current"])?;
    if output.status.success() {
        Ok(text(&output.stdout))
    } else {
        Err(command_error("git branch", &output))
    }
}

fn list_lines(output: Output, label: &str) -> Result<Vec<String>, String> {
    if !output.status.success() {
        return Err(command_error(label, &output));
    }
    Ok(text(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

fn branches(
    executables: &Executables,
    work_dir: &Path,
) -> Result<(Vec<String>, Vec<String>), String> {
    let local = list_lines(
        git(
            executables,
            work_dir,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )?,
        "git list local branches",
    )?;
    let remote = list_lines(
        git(
            executables,
            work_dir,
            &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
        )?,
        "git list remote branches",
    )?
    .into_iter()
    .filter(|branch| !branch.ends_with("/HEAD"))
    .collect();
    Ok((local, remote))
}

fn remotes(executables: &Executables, work_dir: &Path) -> Result<Vec<String>, String> {
    list_lines(git(executables, work_dir, &["remote"])?, "git remote")
}

fn remote_url(executables: &Executables, work_dir: &Path, remote: &str) -> Option<String> {
    let output = git(executables, work_dir, &["remote", "get-url", remote]).ok()?;
    output.status.success().then(|| text(&output.stdout))
}

fn github_hostname(url: Option<&str>) -> String {
    let Some(url) = url else {
        return "github.com".to_string();
    };
    if let Some(rest) = url.split("://").nth(1) {
        return rest.split('/').next().unwrap_or("github.com").to_string();
    }
    if let Some(rest) = url.strip_prefix("git@") {
        return rest.split(':').next().unwrap_or("github.com").to_string();
    }
    "github.com".to_string()
}

fn gh_auth_status(executables: &Executables, work_dir: &Path, hostname: &str) -> (bool, String) {
    let Some(gh) = executables.gh.as_ref() else {
        return (false, "Github CLI未登录".to_string());
    };
    let args = vec![
        "auth".to_string(),
        "status".to_string(),
        "--active".to_string(),
        "--hostname".to_string(),
        hostname.to_string(),
    ];
    match command_output(gh, &args, work_dir, READ_TIMEOUT, None) {
        Ok(output) if output.status.success() => (true, String::new()),
        _ => (false, "Github CLI未登录".to_string()),
    }
}

fn require_gh_auth<'a>(
    executables: &'a Executables,
    work_dir: &Path,
    hostname: &str,
) -> Result<&'a Path, String> {
    let (authenticated, message) = gh_auth_status(executables, work_dir, hostname);
    if !authenticated {
        return Err(message);
    }
    executables
        .gh
        .as_deref()
        .ok_or_else(|| "Github CLI未登录".to_string())
}

fn parse_numstat(output: &Output) -> Result<(Vec<Value>, u64, u64), String> {
    if !output.status.success() {
        return Err(command_error("git diff", output));
    }
    let mut files = Vec::new();
    let mut additions = 0u64;
    let mut deletions = 0u64;
    for line in text(&output.stdout).lines() {
        let mut parts = line.splitn(3, '\t');
        let add = parts
            .next()
            .and_then(|part| part.parse::<u64>().ok())
            .unwrap_or(0);
        let del = parts
            .next()
            .and_then(|part| part.parse::<u64>().ok())
            .unwrap_or(0);
        let Some(path) = parts.next() else { continue };
        additions += add;
        deletions += del;
        files.push(json!({
            "path": path,
            "additions": add,
            "deletions": del,
            "status": "modified",
        }));
    }
    Ok((files, additions, deletions))
}

fn status_paths(executables: &Executables, work_dir: &Path) -> Result<Vec<Value>, String> {
    let output = git(executables, work_dir, &["status", "--porcelain=v1", "-z"])?;
    if !output.status.success() {
        return Err(command_error("git status", &output));
    }
    Ok(parse_porcelain_status(&output.stdout))
}

fn parse_porcelain_status(stdout: &[u8]) -> Vec<Value> {
    let mut result = Vec::new();
    let entries = stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    let mut index = 0;
    while index < entries.len() {
        let entry = entries[index];
        index += 1;
        if entry.len() < 4 {
            continue;
        }
        let index_status = entry[0] as char;
        let worktree_status = entry[1] as char;
        let path = String::from_utf8_lossy(&entry[3..]).to_string();
        let renamed = matches!(index_status, 'R' | 'C') || matches!(worktree_status, 'R' | 'C');
        let original_path = if renamed && index < entries.len() {
            let original = String::from_utf8_lossy(entries[index]).to_string();
            index += 1;
            Some(original)
        } else {
            None
        };
        result.push(json!({
            "path": path,
            "original_path": original_path,
            "index_status": index_status.to_string(),
            "worktree_status": worktree_status.to_string(),
            "untracked": index_status == '?' && worktree_status == '?',
        }));
    }
    result
}

fn default_branch_and_repo(work_dir: &Path, gh: &Path) -> (Option<String>, Option<String>) {
    let args = vec![
        "repo".to_string(),
        "view".to_string(),
        "--json".to_string(),
        "defaultBranchRef,nameWithOwner".to_string(),
    ];
    let Ok(output) = command_output(gh, &args, work_dir, READ_TIMEOUT, None) else {
        return (None, None);
    };
    if !output.status.success() {
        return (None, None);
    }
    let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) else {
        return (None, None);
    };
    (
        value
            .pointer("/defaultBranchRef/name")
            .and_then(Value::as_str)
            .map(str::to_string),
        value
            .get("nameWithOwner")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

fn upstream_counts(executables: &Executables, work_dir: &Path) -> (u64, u64, Option<String>) {
    let upstream_output = git(
        executables,
        work_dir,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let Ok(upstream_output) = upstream_output else {
        return (0, 0, None);
    };
    if !upstream_output.status.success() {
        return (0, 0, None);
    }
    let upstream = text(&upstream_output.stdout);
    let counts = git(
        executables,
        work_dir,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{upstream}...HEAD"),
        ],
    );
    let Ok(counts) = counts else {
        return (0, 0, Some(upstream));
    };
    let values = text(&counts.stdout)
        .split_whitespace()
        .filter_map(|value| value.parse::<u64>().ok())
        .collect::<Vec<_>>();
    (
        values.get(1).copied().unwrap_or(0),
        values.first().copied().unwrap_or(0),
        Some(upstream),
    )
}

pub fn environment(work_dir: &Path, requested_base: Option<&str>) -> Result<Value, String> {
    let executables = resolve_executables()?;
    if require_git_repo(&executables, work_dir).is_err() {
        return Ok(json!({
            "is_git_repo": false,
            "gh_authenticated": false,
            "auth_message": "当前目录不是 Git 仓库",
            "local_branches": [],
            "remote_branches": [],
            "remotes": [],
            "changes": [],
        }));
    }

    let (mut local_branches, remote_branches) = branches(&executables, work_dir)?;
    let remotes = remotes(&executables, work_dir)?;
    let preferred_remote = remotes
        .iter()
        .find(|remote| *remote == "origin")
        .or_else(|| remotes.first());
    let remote_url = preferred_remote.and_then(|remote| remote_url(&executables, work_dir, remote));
    let hostname = github_hostname(remote_url.as_deref());
    let (gh_authenticated, auth_message) = gh_auth_status(&executables, work_dir, &hostname);
    let (default_branch, repository) = if gh_authenticated {
        executables
            .gh
            .as_deref()
            .map(|gh| default_branch_and_repo(work_dir, gh))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };
    let current_branch = current_branch(&executables, work_dir)?;
    let head_sha = current_head(&executables, work_dir)?;
    if !current_branch.is_empty() && !local_branches.contains(&current_branch) {
        local_branches.push(current_branch.clone());
    }
    let fallback_base = default_branch
        .as_ref()
        .and_then(|branch| {
            preferred_remote
                .map(|remote| format!("{remote}/{branch}"))
                .filter(|candidate| remote_branches.contains(candidate))
                .or_else(|| local_branches.contains(branch).then(|| branch.clone()))
        })
        .or_else(|| {
            local_branches
                .iter()
                .find(|branch| *branch == "master" || *branch == "main")
                .cloned()
        })
        .unwrap_or_else(|| current_branch.clone());
    let allowed_refs = local_branches
        .iter()
        .chain(remote_branches.iter())
        .cloned()
        .collect::<HashSet<_>>();
    let base_ref = requested_base
        .filter(|candidate| allowed_refs.contains(*candidate))
        .unwrap_or(&fallback_base)
        .to_string();
    let diff = if head_sha.is_empty() {
        git(&executables, work_dir, &["diff", "--cached", "--numstat"])?
    } else {
        git(&executables, work_dir, &["diff", "--numstat", &base_ref])?
    };
    let (mut changes, mut additions, mut deletions) = parse_numstat(&diff)?;
    let untracked = list_lines(
        git(
            &executables,
            work_dir,
            &["ls-files", "--others", "--exclude-standard"],
        )?,
        "git ls-files",
    )?;
    let known = changes
        .iter()
        .filter_map(|change| change.get("path").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<HashSet<_>>();
    for path in untracked {
        if !known.contains(path.as_str()) {
            changes
                .push(json!({ "path": path, "additions": 0, "deletions": 0, "status": "added" }));
        }
    }
    let status = status_paths(&executables, work_dir)?;
    let (ahead, behind, upstream) = upstream_counts(&executables, work_dir);
    if changes.is_empty() {
        additions = 0;
        deletions = 0;
    }
    Ok(json!({
        "is_git_repo": true,
        "gh_installed": executables.gh.is_some(),
        "gh_authenticated": gh_authenticated,
        "auth_message": auth_message,
        "hostname": hostname,
        "repository": repository,
        "work_dir": work_dir.to_string_lossy(),
        "current_branch": current_branch,
        "head_sha": head_sha,
        "default_branch": default_branch,
        "base_ref": base_ref,
        "local_branches": local_branches,
        "remote_branches": remote_branches,
        "remotes": remotes,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "dirty": !status.is_empty(),
        "status": status,
        "changes": changes,
        "total_additions": additions,
        "total_deletions": deletions,
    }))
}

fn allowed_refs(executables: &Executables, work_dir: &Path) -> Result<HashSet<String>, String> {
    let (local, remote) = branches(executables, work_dir)?;
    Ok(local.into_iter().chain(remote).collect())
}

pub fn compare(work_dir: &Path, left: &str, right: &str) -> Result<Value, String> {
    let executables = resolve_executables()?;
    require_git_repo(&executables, work_dir)?;
    auth_context(&executables, work_dir)?;
    let allowed = allowed_refs(&executables, work_dir)?;
    if !allowed.contains(left) || !allowed.contains(right) {
        return Err("Branch comparison must use a listed local or remote branch".to_string());
    }
    if left == right {
        return Err("Choose two different branches".to_string());
    }
    let range = format!("{left}...{right}");
    let counts = git(
        &executables,
        work_dir,
        &["rev-list", "--left-right", "--count", &range],
    )?;
    if !counts.status.success() {
        return Err(command_error("git branch comparison", &counts));
    }
    let values = text(&counts.stdout)
        .split_whitespace()
        .filter_map(|value| value.parse::<u64>().ok())
        .collect::<Vec<_>>();
    let diff = git(&executables, work_dir, &["diff", "--numstat", &range])?;
    let (files, additions, deletions) = parse_numstat(&diff)?;
    Ok(json!({
        "left": left,
        "right": right,
        "left_ahead": values.first().copied().unwrap_or(0),
        "right_ahead": values.get(1).copied().unwrap_or(0),
        "files": files,
        "total_additions": additions,
        "total_deletions": deletions,
    }))
}

pub fn file_diff(work_dir: &Path, left: &str, right: &str, path: &str) -> Result<String, String> {
    let executables = resolve_executables()?;
    require_git_repo(&executables, work_dir)?;
    let allowed = allowed_refs(&executables, work_dir)?;
    if !allowed.contains(left) || !allowed.contains(right) {
        return Err("Branch comparison must use a listed local or remote branch".to_string());
    }
    let comparison = compare(work_dir, left, right)?;
    let listed = comparison["files"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|file| file.get("path").and_then(Value::as_str) == Some(path));
    if !listed {
        return Err("File is not part of this branch comparison".to_string());
    }
    let args = vec![
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--no-color".to_string(),
        "--unified=3".to_string(),
        format!("{left}...{right}"),
        "--".to_string(),
        path.to_string(),
    ];
    let output = git_owned(&executables, work_dir, args, READ_TIMEOUT)?;
    if output.status.success() {
        Ok(text(&output.stdout))
    } else {
        Err(command_error("git file diff", &output))
    }
}

fn check_expected_head(
    executables: &Executables,
    work_dir: &Path,
    expected: &str,
) -> Result<(), String> {
    if current_head(executables, work_dir)? != expected {
        return Err("Repository changed; refresh before retrying".to_string());
    }
    Ok(())
}

fn auth_context(
    executables: &Executables,
    work_dir: &Path,
) -> Result<(String, Vec<String>), String> {
    let remotes = remotes(executables, work_dir)?;
    let preferred = remotes
        .iter()
        .find(|remote| *remote == "origin")
        .or_else(|| remotes.first());
    let hostname = github_hostname(
        preferred
            .and_then(|remote| remote_url(executables, work_dir, remote))
            .as_deref(),
    );
    require_gh_auth(executables, work_dir, &hostname)?;
    Ok((hostname, remotes))
}

pub fn switch_branch(
    work_dir: &Path,
    target: &str,
    expected_head: &str,
    confirm_dirty: bool,
) -> Result<Value, String> {
    let _guard = MutationGuard::acquire(work_dir)?;
    let executables = resolve_executables()?;
    require_git_repo(&executables, work_dir)?;
    auth_context(&executables, work_dir)?;
    check_expected_head(&executables, work_dir, expected_head)?;
    let status = status_paths(&executables, work_dir)?;
    if !status.is_empty() && !confirm_dirty {
        return Err("Working tree has changes; confirmation is required".to_string());
    }
    let (local, remote) = branches(&executables, work_dir)?;
    let args = if local.iter().any(|branch| branch == target) {
        vec!["switch".to_string(), target.to_string()]
    } else if remote.iter().any(|branch| branch == target) {
        let local_name = target
            .split_once('/')
            .map(|(_, branch)| branch)
            .unwrap_or(target);
        if local.iter().any(|branch| branch == local_name) {
            vec!["switch".to_string(), local_name.to_string()]
        } else {
            vec![
                "switch".to_string(),
                "--track".to_string(),
                target.to_string(),
            ]
        }
    } else {
        return Err("Target branch is not in the current branch list".to_string());
    };
    let output = git_owned(&executables, work_dir, args, MUTATION_TIMEOUT)?;
    if !output.status.success() {
        return Err(command_error("git switch", &output));
    }
    Ok(
        json!({ "success": true, "branch": current_branch(&executables, work_dir)?, "head_sha": current_head(&executables, work_dir)? }),
    )
}

pub fn commit(
    work_dir: &Path,
    paths: &[String],
    message: &str,
    expected_head: &str,
) -> Result<Value, String> {
    let _guard = MutationGuard::acquire(work_dir)?;
    let executables = resolve_executables()?;
    require_git_repo(&executables, work_dir)?;
    auth_context(&executables, work_dir)?;
    check_expected_head(&executables, work_dir, expected_head)?;
    let message = message.trim();
    if message.is_empty() || message.len() > MAX_COMMIT_MESSAGE {
        return Err("Commit message must contain 1 to 1000 characters".to_string());
    }
    if paths.is_empty() {
        return Err("Select at least one changed file".to_string());
    }
    let status = status_paths(&executables, work_dir)?;
    let allowed = status
        .iter()
        .filter_map(|entry| entry.get("path").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let unique = paths.iter().collect::<BTreeSet<_>>();
    if unique.iter().any(|path| !allowed.contains(path.as_str())) {
        return Err("Commit selection contains a path that is no longer changed".to_string());
    }
    let mut add_args = vec!["add".to_string(), "-A".to_string(), "--".to_string()];
    add_args.extend(unique.iter().map(|path| (*path).clone()));
    let added = git_owned(&executables, work_dir, add_args, MUTATION_TIMEOUT)?;
    if !added.status.success() {
        return Err(command_error("git add", &added));
    }
    let mut commit_args = vec![
        "commit".to_string(),
        "--only".to_string(),
        "-m".to_string(),
        message.to_string(),
        "--".to_string(),
    ];
    commit_args.extend(unique.iter().map(|path| (*path).clone()));
    let committed = git_owned(&executables, work_dir, commit_args, MUTATION_TIMEOUT)?;
    if !committed.status.success() {
        return Err(command_error("git commit", &committed));
    }
    Ok(
        json!({ "success": true, "head_sha": current_head(&executables, work_dir)?, "summary": text(&committed.stdout) }),
    )
}

pub fn push(
    work_dir: &Path,
    remote: &str,
    branch: &str,
    expected_head: &str,
) -> Result<Value, String> {
    let _guard = MutationGuard::acquire(work_dir)?;
    let executables = resolve_executables()?;
    require_git_repo(&executables, work_dir)?;
    let (_, allowed_remotes) = auth_context(&executables, work_dir)?;
    check_expected_head(&executables, work_dir, expected_head)?;
    if !allowed_remotes.iter().any(|candidate| candidate == remote) {
        return Err("Push remote is not in the current remote list".to_string());
    }
    if current_branch(&executables, work_dir)? != branch {
        return Err("Only the current branch can be pushed".to_string());
    }
    let upstream = git(
        &executables,
        work_dir,
        &["rev-parse", "--abbrev-ref", "@{upstream}"],
    )
    .map(|output| output.status.success())
    .unwrap_or(false);
    let args = push_arguments(remote, branch, !upstream);
    let output = git_owned(&executables, work_dir, args, MUTATION_TIMEOUT)?;
    if !output.status.success() {
        return Err(command_error("git push", &output));
    }
    Ok(
        json!({ "success": true, "head_sha": current_head(&executables, work_dir)?, "summary": text(&output.stderr) }),
    )
}

fn push_arguments(remote: &str, branch: &str, set_upstream: bool) -> Vec<String> {
    let mut args = vec!["push".to_string()];
    if set_upstream {
        args.push("--set-upstream".to_string());
    }
    args.push(remote.to_string());
    args.push(branch.to_string());
    args
}

pub fn create_pull_request(
    work_dir: &Path,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
    expected_head: &str,
) -> Result<Value, String> {
    let _guard = MutationGuard::acquire(work_dir)?;
    let executables = resolve_executables()?;
    require_git_repo(&executables, work_dir)?;
    let (hostname, _) = auth_context(&executables, work_dir)?;
    check_expected_head(&executables, work_dir, expected_head)?;
    let gh = require_gh_auth(&executables, work_dir, &hostname)?;
    let allowed = allowed_refs(&executables, work_dir)?;
    if !allowed.contains(base) {
        return Err("Pull request base must be a listed branch".to_string());
    }
    if current_branch(&executables, work_dir)? != head {
        return Err("Pull request head must be the current branch".to_string());
    }
    if title.trim().is_empty() || title.len() > 256 {
        return Err("Pull request title must contain 1 to 256 characters".to_string());
    }
    let upstream = git(
        &executables,
        work_dir,
        &["rev-parse", "--abbrev-ref", "@{upstream}"],
    )?;
    if !upstream.status.success() {
        return Err("Push the current branch before creating a pull request".to_string());
    }
    let (ahead, _, _) = upstream_counts(&executables, work_dir);
    if ahead > 0 {
        return Err("Push the latest commits before creating a pull request".to_string());
    }
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--base".to_string(),
        base.to_string(),
        "--head".to_string(),
        head.to_string(),
        "--title".to_string(),
        title.trim().to_string(),
        "--body-file".to_string(),
        "-".to_string(),
    ];
    if draft {
        args.push("--draft".to_string());
    }
    let output = command_output(gh, &args, work_dir, MUTATION_TIMEOUT, Some(body))?;
    if !output.status.success() {
        return Err(command_error("gh pr create", &output));
    }
    let stdout = text(&output.stdout);
    let url = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with("https://") || line.starts_with("http://"))
        .ok_or_else(|| "GitHub CLI did not return a pull request URL".to_string())?;
    validate_http_external_url(url)?;
    Ok(json!({ "success": true, "url": url }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_hosts() {
        assert_eq!(
            github_hostname(Some("https://github.com/acme/repo.git")),
            "github.com"
        );
        assert_eq!(
            github_hostname(Some("git@ghe.example.com:acme/repo.git")),
            "ghe.example.com"
        );
    }

    #[test]
    fn push_arguments_are_non_force_and_explicit() {
        assert_eq!(
            push_arguments("origin", "topic", true),
            ["push", "--set-upstream", "origin", "topic"]
        );
        assert_eq!(
            push_arguments("origin", "topic", false),
            ["push", "origin", "topic"]
        );
        assert!(!push_arguments("origin", "topic", true)
            .iter()
            .any(|argument| argument.contains("force")));
    }

    #[test]
    fn parses_untracked_and_rename_porcelain_entries() {
        let entries = parse_porcelain_status(b"?? -odd name.txt\0R  new name.txt\0old name.txt\0");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["path"], "-odd name.txt");
        assert_eq!(entries[0]["untracked"], true);
        assert_eq!(entries[1]["path"], "new name.txt");
        assert_eq!(entries[1]["original_path"], "old name.txt");
    }
}
