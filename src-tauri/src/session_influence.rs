//! G2a: read-only discovery of plugins, agents, and skills that may affect a session.
//!
//! Disk scans never imply the current ACP session has loaded an entry. Only managed
//! metadata and frontmatter summaries are returned — no system prompt bodies, agent
//! bodies, or credentials.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::runtime_check;
use crate::skills::{self, DiscoveredSkill};

const MAX_AGENT_FILE_BYTES: u64 = 64 * 1024;
const MAX_AGENTS: usize = 200;
const MAX_PLUGINS: usize = 100;

/// Official agent scope priority (lower rank wins on name collision).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum AgentScopeRank {
    /// Reserved for agents explicitly loaded into the current session.
    #[expect(dead_code)]
    Explicit = 0,
    Project = 1,
    Extra = 2,
    User = 3,
    Plugin = 4,
    Builtin = 5,
}

#[derive(Debug, Clone)]
struct AgentCandidate {
    name: String,
    description: String,
    scope: AgentScopeRank,
    source_label: String,
    override_builtin: bool,
    has_tool_allowlist: bool,
    has_tool_denylist: bool,
    allowlist_empty: bool,
}

#[derive(Debug, Clone)]
struct PluginManifestSummary {
    id: String,
    display_name: Option<String>,
    version: Option<String>,
    short_description: Option<String>,
    has_system_prompt: bool,
    has_agents_dir: bool,
    skill_count: usize,
    command_count: usize,
    mcp_server_count: usize,
}

/// JSON snapshot for the desktop influence panel (disk + config only).
pub fn get_session_influence_snapshot(
    work_dir: Option<&str>,
    include_custom_agents: bool,
) -> Result<Value, String> {
    let kimi_homes = collect_kimi_home_roots();
    let mut plugins = Vec::new();
    let mut seen_plugin_ids = HashSet::new();

    for home in &kimi_homes {
        collect_plugins_from_home(home, &mut plugins, &mut seen_plugin_ids);
        if plugins.len() >= MAX_PLUGINS {
            break;
        }
    }

    let agents = if include_custom_agents {
        discover_agents(work_dir, &kimi_homes, &plugins)
    } else {
        Vec::new()
    };
    let skills = skills::discover_skills();
    let has_system_md = kimi_homes.iter().any(|home| system_md_exists(home));

    Ok(json!({
        "plugins": plugins,
        "agents": agents,
        "skills": skills.iter().map(skill_to_json).collect::<Vec<_>>(),
        "hasSystemMd": has_system_md,
        "reloadNotice": "插件或 Agent 配置变更通常需要 CLI 中执行 /reload 或开启新会话后才会在当前会话稳定生效；本页磁盘扫描不代表当前会话已加载。",
    }))
}

fn skill_to_json(skill: &DiscoveredSkill) -> Value {
    json!({
        "name": skill.name,
        "description": skill.description,
        "source": skill.source,
        "discovery": "installed_on_disk",
    })
}

fn collect_kimi_home_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(home) = runtime_check::kimi_code_home_dir() {
        roots.push(home);
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let daimon = PathBuf::from(appdata)
            .join("kimi-desktop")
            .join("daimon-share")
            .join("daimon")
            .join("runtime")
            .join("kimi-code")
            .join("home");
        if daimon.is_dir() {
            roots.push(daimon);
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn system_md_exists(kimi_home: &Path) -> bool {
    let path = kimi_home.join("SYSTEM.md");
    fs::metadata(&path)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
}

fn collect_plugins_from_home(
    kimi_home: &Path,
    out: &mut Vec<Value>,
    seen_ids: &mut HashSet<String>,
) {
    let installed_path = kimi_home.join("plugins").join("installed.json");
    let installed = read_installed_file(&installed_path);
    let enabled_by_id: HashMap<String, bool> = installed
        .iter()
        .map(|record| (record.id.clone(), record.enabled))
        .collect();

    for record in &installed {
        if seen_ids.contains(&record.id) {
            continue;
        }
        let root = resolve_plugin_root(kimi_home, record);
        if let Some(summary) = summarize_plugin_manifest(&record.id, &root) {
            seen_ids.insert(record.id.clone());
            out.push(plugin_entry_json(
                &summary,
                true,
                *enabled_by_id.get(&record.id).unwrap_or(&record.enabled),
            ));
        }
    }

    let managed = kimi_home.join("plugins").join("managed");
    if let Ok(entries) = fs::read_dir(&managed) {
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().to_string();
            if seen_ids.contains(&id) {
                continue;
            }
            let root = entry.path();
            if !root.is_dir() {
                continue;
            }
            if let Some(summary) = summarize_plugin_manifest(&id, &root) {
                seen_ids.insert(id.clone());
                let enabled = enabled_by_id.get(&id).copied().unwrap_or(false);
                out.push(plugin_entry_json(&summary, true, enabled));
            }
        }
    }

    out.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("id").and_then(Value::as_str).unwrap_or(""))
    });
    out.truncate(MAX_PLUGINS);
}

#[derive(Debug, Clone)]
struct InstalledRecord {
    id: String,
    enabled: bool,
    root: Option<String>,
}

fn read_installed_file(path: &Path) -> Vec<InstalledRecord> {
    let content = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let parsed: Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    parsed
        .get("plugins")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?.trim();
                    if id.is_empty() {
                        return None;
                    }
                    Some(InstalledRecord {
                        id: id.to_string(),
                        enabled: item.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                        root: item.get("root").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_plugin_root(kimi_home: &Path, record: &InstalledRecord) -> PathBuf {
    if let Some(root) = &record.root {
        let path = PathBuf::from(root);
        if path.is_dir() {
            return path;
        }
    }
    kimi_home.join("plugins").join("managed").join(&record.id)
}

fn read_plugin_manifest(root: &Path) -> Option<Value> {
    let primary = root.join("kimi.plugin.json");
    if primary.is_file() {
        return read_json_file(&primary);
    }
    let fallback = root.join(".kimi-plugin").join("plugin.json");
    if fallback.is_file() {
        return read_json_file(&fallback);
    }
    None
}

fn read_json_file(path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn summarize_plugin_manifest(id: &str, root: &Path) -> Option<PluginManifestSummary> {
    if !root.is_dir() {
        return None;
    }
    let manifest = read_plugin_manifest(root);
    let manifest_id = manifest
        .as_ref()
        .and_then(|m| m.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(id);
    let interface = manifest
        .as_ref()
        .and_then(|m| m.get("interface"))
        .cloned()
        .unwrap_or(Value::Null);
    let display_name = interface
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            manifest
                .as_ref()
                .and_then(|m| m.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let version = manifest
        .as_ref()
        .and_then(|m| m.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let short_description = interface
        .get("shortDescription")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            manifest
                .as_ref()
                .and_then(|m| m.get("description"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let has_system_prompt = manifest.as_ref().is_some_and(|m| {
        m.get("systemPrompt")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
            || m.get("systemPromptPath")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
    });
    let agents_paths = manifest
        .as_ref()
        .and_then(|m| m.get("agents"))
        .map(collect_manifest_paths)
        .unwrap_or_default();
    let has_agents_dir = root.join("agents").is_dir() || !agents_paths.is_empty();
    let skill_count = count_manifest_skills(root, manifest.as_ref());
    let command_count = count_manifest_commands(root, manifest.as_ref());
    let mcp_server_count = manifest
        .as_ref()
        .and_then(|m| m.get("mcpServers"))
        .and_then(Value::as_object)
        .map(|map| map.len())
        .unwrap_or(0);

    Some(PluginManifestSummary {
        id: manifest_id.to_string(),
        display_name,
        version,
        short_description,
        has_system_prompt,
        has_agents_dir,
        skill_count,
        command_count,
        mcp_server_count,
    })
}

fn collect_manifest_paths(value: &Value) -> Vec<String> {
    match value {
        Value::String(path) => vec![path.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn count_manifest_skills(root: &Path, manifest: Option<&Value>) -> usize {
    let mut count = 0;
    if let Some(m) = manifest {
        for rel in collect_manifest_paths(&m.get("skills").cloned().unwrap_or(Value::Null)) {
            let path = root.join(rel.trim_start_matches("./"));
            if path.join("SKILL.md").is_file() {
                count += 1;
            } else if path.is_dir() {
                count += count_skill_dirs(&path);
            }
        }
    }
    if count == 0 && root.join("SKILL.md").is_file() {
        count = 1;
    }
    if count == 0 {
        let skills_dir = root.join("skills");
        if skills_dir.is_dir() {
            count = count_skill_dirs(&skills_dir);
        }
    }
    count
}

fn count_skill_dirs(root: &Path) -> usize {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .count()
}

fn count_manifest_commands(root: &Path, manifest: Option<&Value>) -> usize {
    let Some(m) = manifest else {
        return 0;
    };
    let paths = collect_manifest_paths(&m.get("commands").cloned().unwrap_or(Value::Null));
    let mut count = 0;
    for rel in paths {
        let path = root.join(rel.trim_start_matches("./"));
        count += count_command_markdown_files(&path);
    }
    count
}

fn count_command_markdown_files(path: &Path) -> usize {
    if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("md") {
        return 1;
    }
    if !path.is_dir() {
        return 0;
    }
    walk_commands(path, 0)
}

fn walk_commands(path: &Path, depth: usize) -> usize {
    if depth > 8 {
        return 0;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut count = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("md") {
            count += 1;
        } else if p.is_dir() {
            count += walk_commands(&p, depth + 1);
        }
    }
    count
}

fn plugin_entry_json(
    summary: &PluginManifestSummary,
    installed_on_disk: bool,
    enabled_in_config: bool,
) -> Value {
    json!({
        "id": summary.id,
        "displayName": summary.display_name,
        "version": summary.version,
        "shortDescription": summary.short_description,
        "installedOnDisk": installed_on_disk,
        "enabledInConfig": enabled_in_config,
        "sessionStatus": "unknown",
        "hasSystemPrompt": summary.has_system_prompt,
        "hasAgents": summary.has_agents_dir,
        "skillCount": summary.skill_count,
        "commandCount": summary.command_count,
        "mcpServerCount": summary.mcp_server_count,
    })
}

fn discover_agents(
    work_dir: Option<&str>,
    kimi_homes: &[PathBuf],
    plugins: &[Value],
) -> Vec<Value> {
    let mut candidates: Vec<AgentCandidate> = Vec::new();
    let enabled_plugin_ids: HashSet<String> = plugins
        .iter()
        .filter(|p| p.get("enabledInConfig").and_then(Value::as_bool) == Some(true))
        .filter_map(|p| p.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();

    if let Some(project_root) = work_dir.and_then(find_project_root) {
        collect_agents_from_dir(
            &project_root.join(".kimi-code").join("agents"),
            AgentScopeRank::Project,
            "project:.kimi-code/agents",
            &mut candidates,
        );
        collect_agents_from_dir(
            &project_root.join(".agents").join("agents"),
            AgentScopeRank::Project,
            "project:.agents/agents",
            &mut candidates,
        );
    }

    for dir in extra_agent_dirs_from_config() {
        collect_agents_from_dir(
            &dir,
            AgentScopeRank::Extra,
            &format!("extra:{}", dir.to_string_lossy()),
            &mut candidates,
        );
    }

    for home in kimi_homes {
        collect_agents_from_dir(
            &home.join("agents"),
            AgentScopeRank::User,
            "user:$KIMI_CODE_HOME/agents",
            &mut candidates,
        );
    }
    if let Ok(user_home) = user_home_dir() {
        collect_agents_from_dir(
            &user_home.join(".agents").join("agents"),
            AgentScopeRank::User,
            "user:~/.agents/agents",
            &mut candidates,
        );
    }

    for home in kimi_homes {
        collect_plugin_agents(home, &enabled_plugin_ids, &mut candidates);
    }

    for (name, description) in BUILTIN_AGENTS {
        candidates.push(AgentCandidate {
            name: (*name).to_string(),
            description: (*description).to_string(),
            scope: AgentScopeRank::Builtin,
            source_label: "builtin".to_string(),
            override_builtin: false,
            has_tool_allowlist: false,
            has_tool_denylist: false,
            allowlist_empty: false,
        });
    }

    agents_to_json(resolve_agent_collisions(candidates))
}

const BUILTIN_AGENTS: &[(&str, &str)] = &[
    ("coder", "默认子 Agent，通用软件工程助手"),
    ("explore", "代码库探索专用，只读操作"),
    ("plan", "实现规划与架构设计专用"),
];

fn find_project_root(work_dir: &str) -> Option<PathBuf> {
    let mut current = PathBuf::from(work_dir);
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        if !current.pop() {
            break;
        }
    }
    None
}

fn extra_agent_dirs_from_config() -> Vec<PathBuf> {
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
        .get("extra_agent_dirs")
        .and_then(toml::Value::as_array)
        .map(|dirs| {
            dirs.iter()
                .filter_map(toml::Value::as_str)
                .map(|dir| expand_home(dir.trim()))
                .filter(|dir| !dir.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = user_home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn user_home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve user home directory".to_string())
}

fn collect_plugin_agents(
    kimi_home: &Path,
    enabled_plugin_ids: &HashSet<String>,
    out: &mut Vec<AgentCandidate>,
) {
    let managed = kimi_home.join("plugins").join("managed");
    let Ok(entries) = fs::read_dir(&managed) else {
        return;
    };
    for entry in entries.flatten() {
        let plugin_id = entry.file_name().to_string_lossy().to_string();
        if !enabled_plugin_ids.is_empty() && !enabled_plugin_ids.contains(&plugin_id) {
            continue;
        }
        let root = entry.path();
        let manifest = read_plugin_manifest(&root);
        let mut agent_dirs: Vec<PathBuf> = Vec::new();
        if root.join("agents").is_dir() {
            agent_dirs.push(root.join("agents"));
        }
        if let Some(m) = &manifest {
            for rel in collect_manifest_paths(&m.get("agents").cloned().unwrap_or(Value::Null)) {
                let path = root.join(rel.trim_start_matches("./"));
                if path.is_dir() {
                    agent_dirs.push(path);
                }
            }
        }
        for dir in agent_dirs {
            collect_agents_from_dir(
                &dir,
                AgentScopeRank::Plugin,
                &format!("plugin:{plugin_id}"),
                out,
            );
        }
    }
}

fn collect_agents_from_dir(
    root: &Path,
    scope: AgentScopeRank,
    source_label: &str,
    out: &mut Vec<AgentCandidate>,
) {
    if !root.is_dir() {
        return;
    }
    walk_agent_files(root, scope, source_label, out);
}

fn walk_agent_files(
    current: &Path,
    scope: AgentScopeRank,
    source_label: &str,
    out: &mut Vec<AgentCandidate>,
) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_AGENTS {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_agent_files(&path, scope, source_label, out);
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if let Some(candidate) = parse_agent_file(&path, scope, source_label) {
            out.push(candidate);
        }
    }
}

fn parse_agent_file(
    path: &Path,
    scope: AgentScopeRank,
    source_label: &str,
) -> Option<AgentCandidate> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > MAX_AGENT_FILE_BYTES {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let meta = parse_agent_frontmatter(&content)?;
    let fallback_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    let name = meta.name.unwrap_or(fallback_name);
    if name.trim().is_empty() {
        return None;
    }
    Some(AgentCandidate {
        name,
        description: meta.description.unwrap_or_default(),
        scope,
        source_label: source_label.to_string(),
        override_builtin: meta.override_builtin,
        has_tool_allowlist: meta.has_tool_allowlist,
        has_tool_denylist: meta.has_tool_denylist,
        allowlist_empty: meta.allowlist_empty,
    })
}

struct AgentFrontmatter {
    name: Option<String>,
    description: Option<String>,
    override_builtin: bool,
    has_tool_allowlist: bool,
    has_tool_denylist: bool,
    allowlist_empty: bool,
}

fn parse_agent_frontmatter(content: &str) -> Option<AgentFrontmatter> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut override_builtin = false;
    let mut has_tool_allowlist = false;
    let mut has_tool_denylist = false;
    let mut allowlist_empty = false;
    let mut in_tools = false;
    let mut in_disallowed = false;
    let mut tool_items = 0;

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            break;
        }
        if trimmed.starts_with("tools:") {
            in_tools = true;
            in_disallowed = false;
            has_tool_allowlist = true;
            let inline = trimmed.strip_prefix("tools:").unwrap_or("").trim();
            if inline == "[]" {
                allowlist_empty = true;
            } else if !inline.is_empty() && inline != "|" && inline != ">" {
                tool_items += 1;
            }
            continue;
        }
        if trimmed.starts_with("disallowedTools:") {
            in_disallowed = true;
            in_tools = false;
            has_tool_denylist = true;
            continue;
        }
        if in_tools && trimmed.starts_with("- ") {
            tool_items += 1;
            if trimmed == "- []" {
                allowlist_empty = true;
            }
            continue;
        }
        if in_disallowed && trimmed.starts_with("- ") {
            continue;
        }
        if trimmed.contains(':') && !line.starts_with(' ') && !line.starts_with('\t') {
            in_tools = false;
            in_disallowed = false;
        }
        let Some((key, raw_value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = unquote(raw_value.trim());
        match key {
            "name" if name.is_none() && !value.is_empty() => name = Some(value),
            "description" if description.is_none() => description = Some(value),
            "override" if value.eq_ignore_ascii_case("true") => override_builtin = true,
            _ => {}
        }
    }

    if has_tool_allowlist && tool_items == 0 {
        allowlist_empty = true;
    }

    Some(AgentFrontmatter {
        name,
        description,
        override_builtin,
        has_tool_allowlist,
        has_tool_denylist,
        allowlist_empty,
    })
}

fn unquote(value: &str) -> String {
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
        .unwrap_or(value)
        .trim()
        .to_string()
}

fn resolve_agent_collisions(candidates: Vec<AgentCandidate>) -> Vec<(AgentCandidate, Vec<String>)> {
    let mut by_name: HashMap<String, AgentCandidate> = HashMap::new();
    let mut shadowed: HashMap<String, Vec<String>> = HashMap::new();

    for candidate in candidates {
        let key = candidate.name.to_lowercase();
        match by_name.get(&key) {
            None => {
                by_name.insert(key.clone(), candidate);
            }
            Some(existing) if candidate.scope < existing.scope => {
                shadowed
                    .entry(key.clone())
                    .or_default()
                    .push(existing.source_label.clone());
                by_name.insert(key, candidate);
            }
            Some(_existing) => {
                shadowed
                    .entry(key)
                    .or_default()
                    .push(candidate.source_label);
            }
        }
    }

    let mut resolved: Vec<(String, AgentCandidate, Vec<String>)> = by_name
        .into_iter()
        .map(|(key, candidate)| {
            let shadows = shadowed.remove(&key).unwrap_or_default();
            (key, candidate, shadows)
        })
        .collect();
    resolved.sort_by_key(|a| a.1.name.to_lowercase());
    resolved
        .into_iter()
        .map(|(_, candidate, shadows)| (candidate, shadows))
        .collect()
}

fn agents_to_json(resolved: Vec<(AgentCandidate, Vec<String>)>) -> Vec<Value> {
    resolved
        .into_iter()
        .map(|(agent, shadowed_sources)| {
            let mut risk_flags = Vec::new();
            if agent.override_builtin && agent.scope <= AgentScopeRank::Project {
                risk_flags.push("override");
            }
            if agent.has_tool_allowlist || agent.has_tool_denylist || agent.allowlist_empty {
                risk_flags.push("tool_restrictions");
            }
            json!({
                "name": agent.name,
                "description": agent.description,
                "sourceScope": scope_label(agent.scope),
                "sourceLabel": agent.source_label,
                "overrideBuiltin": agent.override_builtin,
                "riskFlags": risk_flags,
                "shadowedSources": shadowed_sources,
                "sessionStatus": "unknown",
                "discovery": "installed_on_disk",
            })
        })
        .collect()
}

fn scope_label(scope: AgentScopeRank) -> &'static str {
    match scope {
        AgentScopeRank::Explicit => "explicit",
        AgentScopeRank::Project => "project",
        AgentScopeRank::Extra => "extra",
        AgentScopeRank::User => "user",
        AgentScopeRank::Plugin => "plugin",
        AgentScopeRank::Builtin => "builtin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::lock::set_kimi_code_home;
    use serde_json::json;
    use std::fs;

    #[test]
    fn parses_agent_frontmatter_with_override_and_tools() {
        let content = "---\nname: reviewer\noverride: true\ntools:\n  - Read\n  - Grep\ndisallowedTools:\n  - Bash\ndescription: Review agent\n---\n\nBody must not leak.\n";
        let parsed = parse_agent_frontmatter(content).expect("frontmatter");
        assert_eq!(parsed.name.as_deref(), Some("reviewer"));
        assert!(parsed.override_builtin);
        assert!(parsed.has_tool_allowlist);
        assert!(parsed.has_tool_denylist);
        assert_eq!(parsed.description.as_deref(), Some("Review agent"));
    }

    #[test]
    fn resolves_agent_name_collision_by_scope() {
        let candidates = vec![
            AgentCandidate {
                name: "reviewer".to_string(),
                description: "project".to_string(),
                scope: AgentScopeRank::Project,
                source_label: "project".to_string(),
                override_builtin: true,
                has_tool_allowlist: false,
                has_tool_denylist: false,
                allowlist_empty: false,
            },
            AgentCandidate {
                name: "reviewer".to_string(),
                description: "user".to_string(),
                scope: AgentScopeRank::User,
                source_label: "user".to_string(),
                override_builtin: false,
                has_tool_allowlist: false,
                has_tool_denylist: false,
                allowlist_empty: false,
            },
        ];
        let resolved = resolve_agent_collisions(candidates);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].0.source_label, "project");
        assert_eq!(resolved[0].1, vec!["user"]);
    }

    #[test]
    fn plugin_manifest_summary_counts_skills_without_leaking_body() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("demo-plugin");
        fs::create_dir_all(root.join("skills").join("alpha")).unwrap();
        fs::write(
            root.join("skills").join("alpha").join("SKILL.md"),
            "---\nname: alpha\ndescription: Alpha skill\n---\n\nSecret body\n",
        )
        .unwrap();
        fs::write(
            root.join("kimi.plugin.json"),
            r#"{"name":"demo-plugin","version":"1.0.0","systemPromptPath":"./SYSTEM.md","commands":"./commands/"}"#,
        )
        .unwrap();
        fs::write(root.join("SYSTEM.md"), "Do not expose this body").unwrap();
        fs::create_dir_all(root.join("commands")).unwrap();
        fs::write(
            root.join("commands").join("run.md"),
            "---\ndescription: Run\n---\n",
        )
        .unwrap();

        let summary = summarize_plugin_manifest("demo-plugin", &root).expect("summary");
        assert_eq!(summary.id, "demo-plugin");
        assert!(summary.has_system_prompt);
        assert_eq!(summary.skill_count, 1);
        assert_eq!(summary.command_count, 1);
        let json = plugin_entry_json(&summary, true, true);
        assert_eq!(json["installedOnDisk"], true);
        assert_eq!(json["enabledInConfig"], true);
        assert_eq!(json["sessionStatus"], "unknown");
        assert!(json.get("systemPromptBody").is_none());
    }

    #[test]
    fn reads_installed_json_enabled_state() {
        let temp = tempfile::tempdir().unwrap();
        let plugins_dir = temp.path().join("plugins");
        fs::create_dir_all(&plugins_dir).unwrap();
        fs::write(
            plugins_dir.join("installed.json"),
            r#"{"version":1,"plugins":[{"id":"demo","root":"","enabled":false,"source":"local-path","installedAt":"2026-01-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let managed = plugins_dir.join("managed").join("demo");
        fs::create_dir_all(&managed).unwrap();
        fs::write(
            managed.join("kimi.plugin.json"),
            r#"{"name":"demo","description":"Demo plugin"}"#,
        )
        .unwrap();

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        collect_plugins_from_home(temp.path(), &mut out, &mut seen);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["id"], "demo");
        assert_eq!(out[0]["enabledInConfig"], false);
        assert_eq!(out[0]["sessionStatus"], "unknown");
    }

    #[test]
    fn custom_agent_flag_only_controls_agent_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let kimi_home = temp.path().join("kimi-home");
        let project_root = temp.path().join("project");
        let plugin_root = kimi_home
            .join("plugins")
            .join("managed")
            .join("flag-plugin");

        fs::create_dir_all(kimi_home.join("plugins")).unwrap();
        fs::write(
            kimi_home.join("plugins").join("installed.json"),
            r#"{"version":1,"plugins":[{"id":"flag-plugin","enabled":true}]}"#,
        )
        .unwrap();

        fs::create_dir_all(project_root.join(".git")).unwrap();
        fs::create_dir_all(project_root.join(".kimi-code").join("agents")).unwrap();
        fs::write(
            project_root
                .join(".kimi-code")
                .join("agents")
                .join("project-reviewer.md"),
            "---\nname: project-reviewer\ndescription: Project reviewer\noverride: true\ntools: []\n---\n",
        )
        .unwrap();

        fs::create_dir_all(plugin_root.join("agents")).unwrap();
        fs::write(
            plugin_root.join("agents").join("plugin-reviewer.md"),
            "---\nname: plugin-reviewer\ndescription: Plugin reviewer\n---\n",
        )
        .unwrap();
        fs::write(
            plugin_root.join("kimi.plugin.json"),
            r#"{"name":"flag-plugin","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::create_dir_all(plugin_root.join("skills").join("flag-skill")).unwrap();
        fs::write(
            plugin_root
                .join("skills")
                .join("flag-skill")
                .join("SKILL.md"),
            "---\nname: flag-skill\ndescription: Flag skill\n---\n",
        )
        .unwrap();

        let _home_guard = set_kimi_code_home(&kimi_home);
        let disabled =
            get_session_influence_snapshot(Some(project_root.to_string_lossy().as_ref()), false)
                .unwrap();
        assert_eq!(disabled["agents"], json!([]));
        assert!(disabled["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|plugin| plugin.get("id").and_then(Value::as_str) == Some("flag-plugin")));
        assert!(disabled["skills"]
            .as_array()
            .unwrap()
            .iter()
            .any(|skill| skill.get("name").and_then(Value::as_str) == Some("flag-skill")));

        let enabled =
            get_session_influence_snapshot(Some(project_root.to_string_lossy().as_ref()), true)
                .unwrap();
        let agents = enabled["agents"].as_array().unwrap();
        let project_agent = agents
            .iter()
            .find(|agent| agent.get("name").and_then(Value::as_str) == Some("project-reviewer"))
            .expect("project agent");
        assert_eq!(project_agent["sourceScope"], "project");
        assert_eq!(
            project_agent["riskFlags"],
            json!(["override", "tool_restrictions"])
        );
        let plugin_agent = agents
            .iter()
            .find(|agent| agent.get("name").and_then(Value::as_str) == Some("plugin-reviewer"))
            .expect("plugin agent");
        assert_eq!(plugin_agent["sourceScope"], "plugin");
    }
}
