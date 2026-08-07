//! Read-only access to Kimi plan artifacts scoped to a session.

use crate::session_store;
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_PLAN_BYTES: u64 = 1024 * 1024;

fn plans_dir(session_id: &str) -> Result<Option<PathBuf>, String> {
    Ok(session_store::find_session_dir_by_id(session_id)?
        .map(|directory| directory.join("agents").join("main").join("plans")))
}

fn validate_plan_name(name: &str) -> Result<(), String> {
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(component)), None)
            if Path::new(component)
                .extension()
                .and_then(|value| value.to_str())
                == Some("md") =>
        {
            Ok(())
        }
        _ => Err("Invalid plan identifier".to_string()),
    }
}

fn title_from_content(content: &str, fallback: &str) -> String {
    content
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn canonical_plan(root: &Path, name: &str) -> Result<PathBuf, String> {
    validate_plan_name(name)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plans directory: {error}"))?;
    let candidate = root.join(name);
    let metadata = fs::symlink_metadata(&candidate)
        .map_err(|error| format!("Failed to inspect plan: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_PLAN_BYTES {
        return Err("Plan is not a safe readable Markdown file".to_string());
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plan: {error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Plan resolves outside the session plan directory".to_string());
    }
    Ok(canonical)
}

pub fn list(session_id: &str) -> Result<Vec<Value>, String> {
    let Some(root) = plans_dir(session_id)? else {
        return Ok(Vec::new());
    };
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut plans = Vec::new();
    for entry in fs::read_dir(&root)
        .map_err(|error| format!("Failed to read plans directory: {error}"))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(path) = canonical_plan(&root, &name) else {
            continue;
        };
        let metadata =
            fs::metadata(&path).map_err(|error| format!("Failed to inspect plan: {error}"))?;
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0);
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read plan metadata: {error}"))?;
        let fallback = name.trim_end_matches(".md");
        plans.push(json!({
            "id": name,
            "title": title_from_content(&content, fallback),
            "modified_ms": modified_ms,
            "size": metadata.len(),
        }));
    }
    plans.sort_by(|left, right| {
        right["modified_ms"]
            .as_u64()
            .cmp(&left["modified_ms"].as_u64())
            .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
    });
    Ok(plans)
}

pub fn read(session_id: &str, plan_id: &str) -> Result<Value, String> {
    let root = plans_dir(session_id)?.ok_or_else(|| "Session not found".to_string())?;
    if !root.is_dir() {
        return Err("Session has no plans".to_string());
    }
    let path = canonical_plan(&root, plan_id)?;
    let content =
        fs::read_to_string(&path).map_err(|error| format!("Failed to read plan: {error}"))?;
    Ok(json!({
        "id": plan_id,
        "title": title_from_content(&content, plan_id.trim_end_matches(".md")),
        "content": content,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_plan_name("../plan.md").is_err());
        assert!(validate_plan_name("plan.txt").is_err());
        validate_plan_name("safe-plan.md").expect("safe plan");
    }

    #[test]
    fn extracts_first_h1() {
        assert_eq!(
            title_from_content("text\n# Plan title\nbody", "fallback"),
            "Plan title"
        );
        assert_eq!(title_from_content("plain", "fallback"), "fallback");
    }

    #[test]
    fn rejects_oversized_plan() {
        let root = std::env::temp_dir().join(format!(
            "kimi-plan-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create test root");
        let path = root.join("large.md");
        let file = fs::File::create(&path).expect("create plan");
        file.set_len(MAX_PLAN_BYTES + 1).expect("extend plan");
        assert!(canonical_plan(&root, "large.md").is_err());
        fs::remove_dir_all(&root).expect("remove test root");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_link_plan() {
        use std::io::Write;
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("kimi-plan-link-{}", std::process::id()));
        fs::create_dir_all(&root).expect("create test root");
        let outside = root.with_extension("outside.md");
        let mut file = fs::File::create(&outside).expect("create outside plan");
        writeln!(file, "# outside").expect("write plan");
        symlink(&outside, root.join("link.md")).expect("create link");
        assert!(canonical_plan(&root, "link.md").is_err());
        fs::remove_dir_all(&root).expect("remove test root");
        fs::remove_file(&outside).expect("remove outside plan");
    }
}
