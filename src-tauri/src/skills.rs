//! Disk discovery of invocable skills for the desktop slash-command menu.
//!
//! The Kimi Code runtime advertises `skill:<name>` commands over ACP, but only
//! after a session connects. Scanning the same on-disk skill locations lets the
//! new-session composer offer skills (and lets us backfill any the runtime
//! missed) before the first `available_commands_update` arrives.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::runtime_check;

const MAX_SKILL_FILE_BYTES: u64 = 64 * 1024;
const MAX_SKILLS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSkill {
    pub name: String,
    pub description: String,
    /// Where the skill was found: "user" (~/.agents/skills),
    /// "home" ($KIMI_CODE_HOME/skills) or "plugin:<id>".
    pub source: String,
}

/// List invocable skills as JSON for the frontend.
pub fn list_available_skills() -> Result<Value, String> {
    let skills = discover_skills();
    Ok(json!(skills
        .iter()
        .map(|skill| json!({
            "name": skill.name,
            "description": skill.description,
            "source": skill.source,
        }))
        .collect::<Vec<_>>()))
}

/// Scan all known skill roots. Never fails — unreadable roots are skipped so
/// the slash menu degrades gracefully instead of erroring the composer.
pub fn discover_skills() -> Vec<DiscoveredSkill> {
    let mut roots: Vec<(PathBuf, String)> = Vec::new();

    if let Ok(home) = user_home_dir() {
        roots.push((home.join(".agents").join("skills"), "user".to_string()));
    }

    if let Ok(kimi_home) = runtime_check::kimi_code_home_dir() {
        roots.push((kimi_home.join("skills"), "home".to_string()));
        push_managed_plugin_roots(&kimi_home, &mut roots);
    }

    // User-configured extra skill directories from the CLI config.
    for dir in extra_skill_dirs_from_config() {
        roots.push((dir, "extra".to_string()));
    }

    // Kimi desktop (daimon) managed plugins live under a sibling data dir, not
    // the CLI home — scan them so plugin skills like kimi-webbridge show up.
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let daimon_home = PathBuf::from(appdata)
            .join("kimi-desktop")
            .join("daimon-share")
            .join("daimon")
            .join("runtime")
            .join("kimi-code")
            .join("home");
        push_managed_plugin_roots(&daimon_home, &mut roots);
    }

    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for (root, source) in roots {
        collect_skills_from_root(&root, &source, &mut seen, &mut skills);
        if skills.len() >= MAX_SKILLS {
            break;
        }
    }

    skills.sort_by_key(|a| a.name.to_lowercase());
    skills.truncate(MAX_SKILLS);
    skills
}

/// Enumerate `<home>/plugins/managed/<id>/skills` roots.
fn push_managed_plugin_roots(home: &Path, roots: &mut Vec<(PathBuf, String)>) {
    let managed = home.join("plugins").join("managed");
    if let Ok(entries) = fs::read_dir(&managed) {
        for entry in entries.flatten() {
            let plugin_skills = entry.path().join("skills");
            if plugin_skills.is_dir() {
                let plugin_id = entry.file_name().to_string_lossy().to_string();
                roots.push((plugin_skills, format!("plugin:{plugin_id}")));
            }
        }
    }
}

/// Read `extra_skill_dirs` from the CLI config.toml (empty when unset/invalid).
fn extra_skill_dirs_from_config() -> Vec<PathBuf> {
    let Ok(path) = runtime_check::kimi_code_config_path() else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(config) = content.parse::<toml::Value>() else {
        return Vec::new();
    };
    config
        .get("extra_skill_dirs")
        .and_then(toml::Value::as_array)
        .map(|dirs| {
            dirs.iter()
                .filter_map(toml::Value::as_str)
                .map(|dir| PathBuf::from(dir.trim()))
                .filter(|dir| !dir.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn collect_skills_from_root(
    root: &Path,
    source: &str,
    seen: &mut HashSet<String>,
    skills: &mut Vec<DiscoveredSkill>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let skill_file = entry.path().join("SKILL.md");
        if !skill_file.is_file() {
            continue;
        }
        let Some((name, description)) = parse_skill_frontmatter(&skill_file) else {
            continue;
        };
        // First root wins: user skills shadow home/plugin skills of the same name.
        if !seen.insert(name.to_lowercase()) {
            continue;
        }
        skills.push(DiscoveredSkill {
            name,
            description,
            source: source.to_string(),
        });
        if skills.len() >= MAX_SKILLS {
            return;
        }
    }
}

/// Parse the YAML frontmatter of a SKILL.md. Returns `None` when the file has
/// no frontmatter or no `name:` — the runtime does not advertise those skills
/// as slash commands either (e.g. plain-markdown reference skills).
fn parse_skill_frontmatter(path: &Path) -> Option<(String, String)> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_SKILL_FILE_BYTES {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    parse_frontmatter_values(&content)
}

fn parse_frontmatter_values(content: &str) -> Option<(String, String)> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    let lines: Vec<&str> = lines.collect();

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut index = 0;
    while index < lines.len() {
        let trimmed = lines[index].trim();
        if trimmed == "---" || trimmed == "..." {
            break;
        }
        let Some((key, raw_value)) = trimmed.split_once(':') else {
            index += 1;
            continue;
        };
        let key = key.trim();
        let raw_value = raw_value.trim();

        // YAML block scalars (`|` / `>` with optional `-`): value is the
        // following indented lines, folded into one line with spaces.
        if matches!(raw_value, "|" | ">" | "|-" | ">-") {
            let mut block: Vec<&str> = Vec::new();
            index += 1;
            while index < lines.len() {
                let line = lines[index];
                let is_indented = line.starts_with(' ') || line.starts_with('\t');
                if !is_indented && !line.trim().is_empty() {
                    break;
                }
                let text = line.trim();
                if !text.is_empty() {
                    block.push(text);
                }
                index += 1;
            }
            let folded = block.join(" ");
            match key {
                "name" if name.is_none() && !folded.is_empty() => name = Some(folded),
                "description" if description.is_none() => description = Some(folded),
                _ => {}
            }
            continue;
        }

        let value = unquote(raw_value);
        match key {
            "name" if name.is_none() && !value.is_empty() => name = Some(value),
            "description" if description.is_none() => description = Some(value),
            _ => {}
        }
        index += 1;
    }

    name.map(|name| (name, description.unwrap_or_default()))
}

fn unquote(value: &str) -> String {
    let inner = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')));
    inner.unwrap_or(value).trim().to_string()
}

fn user_home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve user home directory".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_frontmatter_name_and_description() {
        let content = "---\nname: Code\ndescription: Coding workflow with planning.\nversion: 1.0.4\n---\n\n## Body\n";
        let parsed = parse_frontmatter_values(content);
        assert_eq!(
            parsed,
            Some((
                "Code".to_string(),
                "Coding workflow with planning.".to_string()
            ))
        );
    }

    #[test]
    fn skips_files_without_frontmatter() {
        let content = "# debug-pro\n\nSystematic debugging methodology.\n";
        assert_eq!(parse_frontmatter_values(content), None);
    }

    #[test]
    fn folds_block_scalar_descriptions() {
        let content = "---\nname: kimi-webbridge\ndescription: |\n  Kimi WebBridge lets AI control the user's real browser.\n  Use this skill whenever the user wants to interact with websites.\nmetadata:\n  version: \"1.11.2\"\n---\n";
        let parsed = parse_frontmatter_values(content);
        assert_eq!(
            parsed,
            Some((
                "kimi-webbridge".to_string(),
                "Kimi WebBridge lets AI control the user's real browser. Use this skill whenever the user wants to interact with websites.".to_string()
            ))
        );
    }

    #[test]
    fn skips_frontmatter_without_name() {
        let content = "---\ndescription: No name here.\n---\n";
        assert_eq!(parse_frontmatter_values(content), None);
    }

    #[test]
    fn unquotes_wrapped_values() {
        let content = "---\nname: \"quoted-skill\"\ndescription: 'single quoted'\n---\n";
        assert_eq!(
            parse_frontmatter_values(content),
            Some(("quoted-skill".to_string(), "single quoted".to_string()))
        );
    }

    #[test]
    fn collects_skills_from_root_and_dedupes_case_insensitively() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let skill_a = root.join("alpha-0.1.0");
        fs::create_dir_all(&skill_a).unwrap();
        fs::write(
            skill_a.join("SKILL.md"),
            "---\nname: Alpha\ndescription: First skill.\n---\n",
        )
        .unwrap();
        let plain = root.join("plain-1.0.0");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("SKILL.md"), "# plain\n\nNo frontmatter.\n").unwrap();

        let mut seen = HashSet::new();
        seen.insert("alpha".to_string()); // shadows the on-disk Alpha
        let mut skills = Vec::new();
        collect_skills_from_root(root, "user", &mut seen, &mut skills);

        assert!(
            skills.is_empty(),
            "shadowed and frontmatter-less skills are skipped"
        );

        let mut seen = HashSet::new();
        collect_skills_from_root(root, "user", &mut seen, &mut skills);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "Alpha");
        assert_eq!(skills[0].source, "user");
    }
}
