use crate::acp::{resolve_acp_command_validated, validate_kimi_acp_command};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
pub fn configure_macos_cli_path() {
    let paths = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let home = user_home_dir().ok();
    let paths = prepend_macos_cli_paths(home.as_deref(), paths);

    if let Ok(joined) = std::env::join_paths(paths) {
        std::env::set_var("PATH", joined);
    }
}

#[cfg(any(target_os = "macos", test))]
fn prepend_macos_cli_paths(home: Option<&Path>, mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut preferred = Vec::new();
    if let Some(home) = home {
        preferred.push(home.join(".local").join("bin"));
    }
    preferred.push(PathBuf::from("/opt/homebrew/bin"));
    preferred.push(PathBuf::from("/usr/local/bin"));

    for candidate in preferred.into_iter().rev() {
        if !paths.iter().any(|existing| existing == &candidate) {
            paths.insert(0, candidate);
        }
    }

    paths
}
use tauri::AppHandle;

const KIMI_CLI_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const KIMI_CLI_VERSION_COMMANDS: &[&[&str]] = &[&["version"], &["--version"]];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReadiness {
    pub ok: bool,
    pub has_blocking_issues: bool,
    pub checks: Vec<RuntimeReadinessCheck>,
    pub issues: Vec<String>,
    pub warnings: Vec<String>,
    pub bundled_runtime: BundledRuntimeStatus,
    pub external_cli: ExternalCliStatus,
    pub config: ConfigReadiness,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReadinessCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub status: CheckStatus,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Ok,
    Warning,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledRuntimeStatus {
    pub available: bool,
    pub version: Option<String>,
    pub package_path: Option<String>,
    pub executable: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCliStatus {
    pub available: bool,
    pub program: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReadiness {
    pub path: Option<String>,
    pub exists: bool,
    pub ready: bool,
    pub has_default_model: bool,
    pub has_provider_section: bool,
    pub has_model_section: bool,
    pub has_credential_source: bool,
    pub credential_sources: Vec<String>,
    pub error: Option<String>,
}

pub async fn check_runtime_readiness(_app: &AppHandle) -> RuntimeReadiness {
    check_kimi_code_runtime_readiness()
}

fn prepare_kimi_code_config_readiness() -> ConfigReadiness {
    let config_creation_error = ensure_kimi_code_config_file().err();
    let mut config = check_kimi_code_config_readiness();
    if let Some(error) = config_creation_error {
        config.error = Some(format!("Failed to prepare Kimi Code config.toml: {error}"));
    }
    config
}

fn check_kimi_code_runtime_readiness() -> RuntimeReadiness {
    let mut checks = Vec::new();
    let mut issues = Vec::new();
    let mut warnings = Vec::new();
    let config = prepare_kimi_code_config_readiness();

    let program = match resolve_acp_command_validated() {
        Ok(program) => {
            checks.push(RuntimeReadinessCheck {
                id: "kimiCodeCli",
                label: "Kimi Code CLI",
                status: CheckStatus::Ok,
                detail: format!("Kimi Code CLI found: {program}"),
            });
            program
        }
        Err(error) => {
            issues.push(error.clone());
            checks.push(RuntimeReadinessCheck {
                id: "kimiCodeCli",
                label: "Kimi Code CLI",
                status: CheckStatus::Error,
                detail: error,
            });
            append_config_readiness(&config, &mut checks, &mut issues);
            return build_kimi_code_runtime_readiness(checks, issues, warnings, None, None, config);
        }
    };

    // Version + ACP entrypoint both shell out; run them in parallel to cut cold-start wait.
    let program_for_version = program.clone();
    let program_for_acp = program.clone();
    let (version_result, acp_result) = thread::scope(|scope| {
        let version_handle =
            scope.spawn(move || resolve_kimi_code_cli_version_for_program(&program_for_version));
        let acp_handle = scope.spawn(move || validate_kimi_acp_command(&program_for_acp));
        (
            version_handle
                .join()
                .unwrap_or_else(|_| Err("Kimi Code CLI version check thread panicked".to_string())),
            acp_handle
                .join()
                .unwrap_or_else(|_| Err("Kimi ACP entrypoint check thread panicked".to_string())),
        )
    });

    let version = match version_result {
        Ok(version) => {
            checks.push(RuntimeReadinessCheck {
                id: "kimiCodeCliVersion",
                label: "Kimi Code CLI version",
                status: CheckStatus::Ok,
                detail: format!("Resolved Kimi Code CLI version: v{version}"),
            });
            Some(version)
        }
        Err(error) => {
            issues.push(error.clone());
            checks.push(RuntimeReadinessCheck {
                id: "kimiCodeCliVersion",
                label: "Kimi Code CLI version",
                status: CheckStatus::Error,
                detail: error,
            });
            None
        }
    };

    if let Err(error) = acp_result {
        issues.push(error.clone());
        checks.push(RuntimeReadinessCheck {
            id: "kimiAcpEntrypoint",
            label: "Kimi ACP entrypoint",
            status: CheckStatus::Error,
            detail: error,
        });
    } else {
        checks.push(RuntimeReadinessCheck {
            id: "kimiAcpEntrypoint",
            label: "Kimi ACP entrypoint",
            status: CheckStatus::Ok,
            detail: format!("`{program} acp --help` succeeded"),
        });
    }

    append_config_readiness(&config, &mut checks, &mut issues);

    if let Some(hint) = legacy_migration_hint() {
        warnings.push(hint.clone());
        checks.push(RuntimeReadinessCheck {
            id: "legacyMigration",
            label: "Legacy Kimi migration",
            status: CheckStatus::Warning,
            detail: hint,
        });
    }

    build_kimi_code_runtime_readiness(checks, issues, warnings, Some(program), version, config)
}

fn append_config_readiness(
    config: &ConfigReadiness,
    checks: &mut Vec<RuntimeReadinessCheck>,
    issues: &mut Vec<String>,
) {
    if let Some(error) = config.error.clone() {
        issues.push(error.clone());
        checks.push(RuntimeReadinessCheck {
            id: "kimiCodeConfig",
            label: "Kimi Code config.toml",
            status: CheckStatus::Error,
            detail: error,
        });
        return;
    }

    if config.ready {
        let detail = config
            .path
            .as_deref()
            .map(|path| format!("Kimi Code config is ready: {path}"))
            .unwrap_or_else(|| "Kimi Code config is ready.".to_string());
        checks.push(RuntimeReadinessCheck {
            id: "kimiCodeConfig",
            label: "Kimi Code config.toml",
            status: CheckStatus::Ok,
            detail,
        });
        return;
    }

    let detail = if !config.exists {
        "Kimi Code config.toml is missing.".to_string()
    } else {
        incomplete_config_detail(config)
    };
    issues.push(detail.clone());
    checks.push(RuntimeReadinessCheck {
        id: "kimiCodeConfig",
        label: "Kimi Code config.toml",
        status: CheckStatus::Error,
        detail,
    });
}

fn incomplete_config_detail(config: &ConfigReadiness) -> String {
    let mut missing = Vec::new();
    if !config.has_default_model {
        missing.push("default_model");
    }
    if !config.has_provider_section {
        missing.push("[providers.*]");
    }
    if !config.has_model_section {
        missing.push("[models.*]");
    }
    if !config.has_credential_source {
        missing.push("credential source");
    }
    if missing.is_empty() {
        missing.push("default model binding");
    }
    format!(
        "Kimi Code config.toml is incomplete: {}.",
        missing.join(", ")
    )
}

fn build_kimi_code_runtime_readiness(
    checks: Vec<RuntimeReadinessCheck>,
    issues: Vec<String>,
    warnings: Vec<String>,
    program: Option<String>,
    version: Option<String>,
    config: ConfigReadiness,
) -> RuntimeReadiness {
    let available = program.is_some() && version.is_some();
    let external_error = if program.is_some() && version.is_none() {
        Some("Kimi Code CLI version could not be resolved.".to_string())
    } else {
        None
    };
    let external_cli = ExternalCliStatus {
        available,
        program,
        version,
        error: external_error,
    };
    let bundled_runtime = BundledRuntimeStatus {
        available: false,
        version: None,
        package_path: None,
        executable: None,
        error: None,
    };
    let has_blocking_issues = !issues.is_empty();
    RuntimeReadiness {
        ok: !has_blocking_issues && warnings.is_empty(),
        has_blocking_issues,
        checks,
        issues,
        warnings,
        bundled_runtime,
        external_cli,
        config,
    }
}

fn legacy_migration_hint() -> Option<String> {
    let home = user_home_dir().ok()?;
    let legacy_dir = home.join(".kimi");
    if !legacy_dir.exists() {
        return None;
    }

    let kimi_code_dir = kimi_code_home_dir().ok()?;
    if kimi_code_dir.exists() {
        let has_config = kimi_code_dir.join("config.toml").is_file();
        let has_entries = fs::read_dir(&kimi_code_dir)
            .ok()
            .map(|entries| entries.filter_map(Result::ok).next().is_some())
            .unwrap_or(false);
        if has_config || has_entries {
            return None;
        }
    }

    Some(
        "Legacy ~/.kimi configuration detected and ~/.kimi-code is empty. Run `kimi migrate` to import settings."
            .to_string(),
    )
}

/// Resolve the Kimi Code CLI program used for ACP (`KIMI_CODE_BIN`, then `kimi`).
pub fn resolve_kimi_code_cli_program_blocking() -> Result<String, String> {
    let program = resolve_acp_command_validated()?;
    resolve_kimi_code_cli_version_for_program(&program).map(|_| program)
}

pub fn resolve_kimi_code_cli_version_blocking() -> Result<String, String> {
    let program = resolve_acp_command_validated()?;
    resolve_kimi_code_cli_version_for_program(&program)
}

fn resolve_kimi_code_cli_version_for_program(program: &str) -> Result<String, String> {
    let mut errors = Vec::new();
    for args in KIMI_CLI_VERSION_COMMANDS {
        let command_label = args.join(" ");
        match run_kimi_command(program, args, KIMI_CLI_VERSION_TIMEOUT) {
            Ok(output) => {
                if let Some(version) = parse_kimi_code_version_output(&output) {
                    return Ok(version);
                }
                errors.push(format!(
                    "{command_label} returned unparseable output: {}",
                    output.trim()
                ));
            }
            Err(error) => errors.push(format!("{command_label}: {error}")),
        }
    }

    Err(format!(
        "Unable to resolve Kimi Code CLI version for `{program}` ({})",
        errors.join("; ")
    ))
}

pub fn kimi_code_home_dir() -> Result<PathBuf, String> {
    kimi_code_home_dir_from_values(
        std::env::var("KIMI_CODE_HOME").ok().as_deref(),
        user_home_dir().ok().as_deref(),
    )
}

pub fn kimi_code_home_dir_from_values(
    kimi_code_home: Option<&str>,
    user_home: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(home) = kimi_code_home {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    user_home
        .map(|home| home.join(".kimi-code"))
        .ok_or_else(|| "Unable to resolve Kimi Code home directory".to_string())
}

pub fn kimi_code_config_path() -> Result<PathBuf, String> {
    kimi_code_config_file_path(
        "config.toml",
        std::env::var("KIMI_CODE_HOME").ok().as_deref(),
        user_home_dir().ok().as_deref(),
    )
}

pub fn kimi_code_config_file_path(
    file_name: &str,
    kimi_code_home: Option<&str>,
    user_home: Option<&Path>,
) -> Result<PathBuf, String> {
    Ok(kimi_code_home_dir_from_values(kimi_code_home, user_home)?.join(file_name))
}

pub fn parse_kimi_code_version_output(output: &str) -> Option<String> {
    parse_version_from_output(output)
}

pub fn ensure_kimi_code_config_file() -> Result<PathBuf, String> {
    let path = kimi_code_config_path()?;
    ensure_config_file_at(&path)?;
    Ok(path)
}

fn ensure_config_file_at(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_file() => Ok(()),
        Err(error) => Err(format!("Failed to create {}: {error}", path.display())),
    }
}

fn check_kimi_code_config_readiness() -> ConfigReadiness {
    let path = match kimi_code_config_path() {
        Ok(path) => path,
        Err(error) => {
            return ConfigReadiness {
                path: None,
                exists: false,
                ready: false,
                has_default_model: false,
                has_provider_section: false,
                has_model_section: false,
                has_credential_source: false,
                credential_sources: Vec::new(),
                error: Some(error),
            };
        }
    };

    let path_string = path.to_string_lossy().to_string();
    if !path.exists() {
        return ConfigReadiness {
            path: Some(path_string.clone()),
            exists: false,
            ready: false,
            has_default_model: false,
            has_provider_section: false,
            has_model_section: false,
            has_credential_source: false,
            credential_sources: Vec::new(),
            error: None,
        };
    }

    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            return ConfigReadiness {
                path: Some(path_string),
                exists: true,
                ready: false,
                has_default_model: false,
                has_provider_section: false,
                has_model_section: false,
                has_credential_source: false,
                credential_sources: Vec::new(),
                error: Some(format!("Failed to read {}: {error}", path.display())),
            };
        }
    };

    if content.trim().is_empty() {
        return ConfigReadiness {
            path: Some(path_string),
            exists: true,
            ready: false,
            has_default_model: false,
            has_provider_section: false,
            has_model_section: false,
            has_credential_source: false,
            credential_sources: Vec::new(),
            error: None,
        };
    }

    let parsed = match content.parse::<toml::Value>() {
        Ok(parsed) => parsed,
        Err(error) => {
            return ConfigReadiness {
                path: Some(path_string),
                exists: true,
                ready: false,
                has_default_model: false,
                has_provider_section: false,
                has_model_section: false,
                has_credential_source: false,
                credential_sources: Vec::new(),
                error: Some(format!("Invalid Kimi Code config TOML: {error}")),
            };
        }
    };

    let Some(root) = parsed.as_table() else {
        return ConfigReadiness {
            path: Some(path_string),
            exists: true,
            ready: false,
            has_default_model: false,
            has_provider_section: false,
            has_model_section: false,
            has_credential_source: false,
            credential_sources: Vec::new(),
            error: Some("Invalid Kimi Code config TOML: root must be a table.".to_string()),
        };
    };

    if root.is_empty() {
        return ConfigReadiness {
            path: Some(path_string),
            exists: true,
            ready: false,
            has_default_model: false,
            has_provider_section: false,
            has_model_section: false,
            has_credential_source: false,
            credential_sources: Vec::new(),
            error: None,
        };
    }

    let default_model = non_empty_toml_string(root.get("default_model"));
    let providers = root.get("providers").and_then(toml::Value::as_table);
    let models = root.get("models").and_then(toml::Value::as_table);
    let has_default_model = default_model.is_some();
    let has_provider_section = providers.map(|table| !table.is_empty()).unwrap_or(false);
    let has_model_section = models.map(|table| !table.is_empty()).unwrap_or(false);
    let kimi_login_present = crate::managed_usage::credentials_present();
    let credential_sources = collect_credential_sources(providers, kimi_login_present);
    let has_credential_source = !credential_sources.is_empty();

    let default_model_table = default_model
        .and_then(|name| models.and_then(|table| table.get(name)))
        .and_then(toml::Value::as_table);
    let default_provider_name = default_model_table
        .and_then(|table| non_empty_toml_string(table.get("provider")))
        .or(default_model);
    let default_provider_table = default_provider_name
        .and_then(|name| providers.and_then(|table| table.get(name)))
        .and_then(toml::Value::as_table);
    let default_provider_type =
        default_provider_table.and_then(|table| non_empty_toml_string(table.get("type")));
    let default_model_binding_ready = default_model_table
        .and_then(|table| non_empty_toml_string(table.get("model")))
        .is_some()
        && default_provider_type.is_some();
    let default_provider_has_credential = default_provider_table
        .map(|table| provider_has_credential(table, default_provider_type, kimi_login_present))
        .unwrap_or(false);

    let mut missing = Vec::new();
    if !has_default_model {
        missing.push("default_model".to_string());
    }
    if !has_provider_section {
        missing.push("[providers.*]".to_string());
    }
    if !has_model_section {
        missing.push("[models.*]".to_string());
    }
    if has_default_model && !default_model_binding_ready {
        missing.push(format!(
            "model binding for '{0}'",
            default_model.unwrap_or_default()
        ));
    }
    if default_model_binding_ready && !default_provider_has_credential {
        missing.push(format!(
            "credential source for provider '{0}'",
            default_provider_name.unwrap_or_default()
        ));
    }

    let ready = missing.is_empty();

    ConfigReadiness {
        path: Some(path_string),
        exists: true,
        ready,
        has_default_model,
        has_provider_section,
        has_model_section,
        has_credential_source,
        credential_sources,
        error: None,
    }
}

fn non_empty_toml_string(value: Option<&toml::Value>) -> Option<&str> {
    value
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn collect_credential_sources(
    providers: Option<&toml::map::Map<String, toml::Value>>,
    kimi_login_present: bool,
) -> Vec<String> {
    let mut sources = Vec::new();
    let Some(providers) = providers else {
        return sources;
    };

    for provider in providers.values() {
        let Some(table) = provider.as_table() else {
            continue;
        };
        let provider_type = non_empty_toml_string(table.get("type"));
        if non_empty_toml_string(table.get("api_key")).is_some() {
            push_unique_credential_source(&mut sources, "config api_key");
        }
        if provider_api_key_env_is_available(table) {
            push_unique_credential_source(&mut sources, "config api_key_env");
        }
        if provider_env_table_has_api_key(table) {
            push_unique_credential_source(&mut sources, "config env");
        }
        if provider_type
            .map(|value| value.eq_ignore_ascii_case("kimi"))
            .unwrap_or(false)
            && kimi_login_present
        {
            push_unique_credential_source(&mut sources, "Kimi credential file");
        }
    }

    sources
}

fn push_unique_credential_source(sources: &mut Vec<String>, source: &str) {
    if !sources.iter().any(|existing| existing == source) {
        sources.push(source.to_string());
    }
}

fn provider_has_credential(
    table: &toml::map::Map<String, toml::Value>,
    provider_type: Option<&str>,
    kimi_login_present: bool,
) -> bool {
    non_empty_toml_string(table.get("api_key")).is_some()
        || provider_api_key_env_is_available(table)
        || provider_env_table_has_api_key(table)
        || (provider_type
            .map(|value| value.eq_ignore_ascii_case("kimi"))
            .unwrap_or(false)
            && kimi_login_present)
}

fn provider_api_key_env_is_available(table: &toml::map::Map<String, toml::Value>) -> bool {
    non_empty_toml_string(table.get("api_key_env"))
        .map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn provider_env_table_has_api_key(table: &toml::map::Map<String, toml::Value>) -> bool {
    table
        .get("env")
        .and_then(toml::Value::as_table)
        .map(|env| {
            env.iter().any(|(name, value)| {
                is_api_key_name(name) && non_empty_toml_string(Some(value)).is_some()
            })
        })
        .unwrap_or(false)
}

fn is_api_key_name(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    lowered.contains("api_key") || lowered.ends_with("_key") || lowered == "apikey"
}

fn run_kimi_command(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let started_at = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(_) => {
                let output = child.wait_with_output().map_err(|e| e.to_string())?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let combined = format!("{}{}", stdout, stderr);
                if output.status.success() {
                    return Ok(combined);
                }
                return Err(format!(
                    "exited with status {}: {}",
                    output.status,
                    combined.trim()
                ));
            }
            None if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out while running {}", args.join(" ")));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn parse_version_from_output(output: &str) -> Option<String> {
    output
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '+'))
        .find(|token| {
            token.contains('.')
                && token
                    .chars()
                    .next()
                    .map(|ch| ch.is_ascii_digit())
                    .unwrap_or(false)
        })
        .map(str::to_string)
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
    use super::{
        append_config_readiness, build_kimi_code_runtime_readiness,
        check_kimi_code_config_readiness, ensure_kimi_code_config_file, kimi_code_config_file_path,
        kimi_code_home_dir_from_values, legacy_migration_hint, parse_kimi_code_version_output,
        parse_version_from_output, prepare_kimi_code_config_readiness, prepend_macos_cli_paths,
    };
    use crate::test_env::lock::{env_lock, set_kimi_code_home};
    use std::fs;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    fn write_config(temp: &TempDir, content: &str) {
        fs::write(temp.path().join("config.toml"), content).expect("config written");
    }

    #[test]
    fn macos_cli_paths_prefer_uv_and_homebrew_locations_without_duplicates() {
        let existing = vec![
            PathBuf::from("/usr/bin"),
            PathBuf::from("/opt/homebrew/bin"),
        ];
        let paths = prepend_macos_cli_paths(Some(Path::new("/Users/alice")), existing);

        assert_eq!(paths[0], PathBuf::from("/Users/alice/.local/bin"));
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.as_path() == Path::new("/opt/homebrew/bin"))
                .count(),
            1
        );
        assert!(paths.contains(&PathBuf::from("/usr/local/bin")));
    }

    #[test]
    fn kimi_code_home_defaults_to_user_home_dot_kimi_code() {
        let home = Path::new(r"C:\Users\alice");
        assert_eq!(
            kimi_code_home_dir_from_values(None, Some(home)).unwrap(),
            home.join(".kimi-code")
        );
    }

    #[test]
    fn kimi_code_home_honors_kimi_code_home_override() {
        assert_eq!(
            kimi_code_home_dir_from_values(
                Some(r"D:\kimi-data"),
                Some(Path::new(r"C:\Users\alice"))
            )
            .unwrap(),
            Path::new(r"D:\kimi-data")
        );
    }

    #[test]
    fn kimi_code_config_path_appends_config_toml() {
        let home = Path::new(r"C:\Users\alice");
        let kimi_home = kimi_code_home_dir_from_values(None, Some(home)).unwrap();
        assert_eq!(
            kimi_home.join("config.toml"),
            home.join(".kimi-code").join("config.toml")
        );
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn kimi_config_path_uses_kimi_code_home() {
        let path = kimi_code_config_file_path("config.toml", None, Some(Path::new(r"C:\Users\u")))
            .unwrap();
        assert_eq!(path, PathBuf::from(r"C:\Users\u\.kimi-code\config.toml"));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn kimi_config_path_uses_kimi_code_home_posix() {
        let path = kimi_code_config_file_path("config.toml", None, Some(Path::new("/home/u")))
            .unwrap();
        assert_eq!(path, PathBuf::from("/home/u/.kimi-code/config.toml"));
    }

    #[test]
    fn parses_kimi_code_version_output() {
        assert_eq!(
            parse_kimi_code_version_output("0.18.0\n"),
            Some("0.18.0".to_string())
        );
        assert_eq!(
            parse_kimi_code_version_output("kimi-code version 0.18.0"),
            Some("0.18.0".to_string())
        );
    }

    #[test]
    fn parses_generic_cli_version_output() {
        assert_eq!(
            parse_version_from_output("kimi, version 1.45.0"),
            Some("1.45.0".to_string())
        );
    }

    #[test]
    fn ensure_config_file_is_idempotent_and_preserves_existing_content() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _home = set_kimi_code_home(temp.path());

        let path = ensure_kimi_code_config_file().expect("config created");
        assert!(path.is_file());
        assert_eq!(fs::read_to_string(&path).expect("config readable"), "");

        let existing = "default_model = \"demo\"\n[providers.demo]\napi_key = \"keep-me\"\n";
        fs::write(&path, existing).expect("existing config written");
        assert_eq!(ensure_kimi_code_config_file().unwrap(), path);
        assert_eq!(
            fs::read_to_string(path).expect("config preserved"),
            existing
        );
    }

    #[test]
    fn production_config_readiness_creates_missing_config_before_check() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _home = set_kimi_code_home(temp.path());

        let config = prepare_kimi_code_config_readiness();
        let path = temp.path().join("config.toml");
        assert!(path.is_file());
        assert_eq!(fs::read_to_string(&path).expect("config readable"), "");
        assert_eq!(config.path, Some(path.to_string_lossy().to_string()));
        assert!(config.exists);
        assert!(!config.ready);
        assert!(config.error.is_none());

        let mut checks = Vec::new();
        let mut issues = Vec::new();
        append_config_readiness(&config, &mut checks, &mut issues);
        assert_eq!(checks.len(), 1);
        assert!(issues.iter().any(|issue| issue.contains("incomplete")));
    }

    #[test]
    fn missing_config_is_not_ready_and_is_blocking() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _home = set_kimi_code_home(temp.path());

        let config = check_kimi_code_config_readiness();
        assert!(!config.exists);
        assert!(!config.ready);
        assert!(!config.has_default_model);
        assert!(!config.has_provider_section);
        assert!(!config.has_model_section);
        assert!(!config.has_credential_source);
        assert!(config.error.is_none());

        let mut checks = Vec::new();
        let mut issues = Vec::new();
        append_config_readiness(&config, &mut checks, &mut issues);
        assert_eq!(checks.len(), 1);
        assert!(issues.iter().any(|issue| issue.contains("missing")));
        let readiness =
            build_kimi_code_runtime_readiness(checks, issues, Vec::new(), None, None, config);
        assert!(!readiness.ok);
        assert!(readiness.has_blocking_issues);
    }

    #[test]
    fn empty_config_is_not_ready_with_false_structure_flags() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _home = set_kimi_code_home(temp.path());
        ensure_kimi_code_config_file().expect("empty config created");

        let config = check_kimi_code_config_readiness();
        assert!(config.exists);
        assert!(!config.ready);
        assert!(!config.has_default_model);
        assert!(!config.has_provider_section);
        assert!(!config.has_model_section);
        assert!(!config.has_credential_source);
        assert!(config.error.is_none());

        let mut checks = Vec::new();
        let mut issues = Vec::new();
        append_config_readiness(&config, &mut checks, &mut issues);
        assert_eq!(checks.len(), 1);
        assert!(issues.iter().any(|issue| issue.contains("incomplete")));
    }

    #[test]
    fn incomplete_config_reports_existing_structure_flags() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _home = set_kimi_code_home(temp.path());
        write_config(
            &temp,
            r#"default_model = "demo"

[providers.demo]
type = "openai"

[models.demo]
provider = "demo"
model = "gpt-test"
"#,
        );

        let config = check_kimi_code_config_readiness();
        assert!(config.exists);
        assert!(!config.ready);
        assert!(config.has_default_model);
        assert!(config.has_provider_section);
        assert!(config.has_model_section);
        assert!(!config.has_credential_source);
        assert!(config.error.is_none());

        let mut checks = Vec::new();
        let mut issues = Vec::new();
        append_config_readiness(&config, &mut checks, &mut issues);
        assert_eq!(checks.len(), 1);
        assert!(issues
            .iter()
            .any(|issue| issue.contains("credential source")));
    }

    #[test]
    fn invalid_config_is_not_ready_and_does_not_report_structure() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _home = set_kimi_code_home(temp.path());
        write_config(&temp, "default_model = [");

        let config = check_kimi_code_config_readiness();
        assert!(config.exists);
        assert!(!config.ready);
        assert!(!config.has_default_model);
        assert!(!config.has_provider_section);
        assert!(!config.has_model_section);
        assert!(!config.has_credential_source);
        assert!(config.error.as_deref().unwrap_or("").contains("Invalid"));
    }

    #[test]
    fn api_key_provider_is_ready_without_kimi_login() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _home = set_kimi_code_home(temp.path());
        write_config(
            &temp,
            r#"default_model = "demo"

[providers.demo]
type = "openai"
api_key = "test-api-key"

[models.demo]
provider = "demo"
model = "gpt-test"
"#,
        );

        let config = check_kimi_code_config_readiness();
        assert!(config.ready);
        assert!(config.has_default_model);
        assert!(config.has_provider_section);
        assert!(config.has_model_section);
        assert!(config.has_credential_source);
        assert_eq!(config.credential_sources, vec!["config api_key"]);
        assert!(config.error.is_none());
    }

    #[test]
    fn api_key_env_provider_is_ready_without_kimi_login() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _lock = env_lock();
        let previous_home = std::env::var_os("KIMI_CODE_HOME");
        let previous_key = std::env::var_os("RUNTIME_CHECK_TEST_API_KEY");
        std::env::set_var("KIMI_CODE_HOME", temp.path());
        std::env::set_var("RUNTIME_CHECK_TEST_API_KEY", "test-api-key");
        write_config(
            &temp,
            r#"default_model = "demo"

[providers.demo]
type = "openai"
api_key_env = "RUNTIME_CHECK_TEST_API_KEY"

[models.demo]
provider = "demo"
model = "gpt-test"
"#,
        );

        let config = check_kimi_code_config_readiness();
        assert!(config.ready);
        assert!(config.has_credential_source);
        assert_eq!(config.credential_sources, vec!["config api_key_env"]);
        assert!(config.error.is_none());

        match previous_home {
            Some(value) => std::env::set_var("KIMI_CODE_HOME", value),
            None => std::env::remove_var("KIMI_CODE_HOME"),
        }
        match previous_key {
            Some(value) => std::env::set_var("RUNTIME_CHECK_TEST_API_KEY", value),
            None => std::env::remove_var("RUNTIME_CHECK_TEST_API_KEY"),
        }
    }

    #[test]
    fn provider_env_table_is_a_usable_credential_source() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _home = set_kimi_code_home(temp.path());
        write_config(
            &temp,
            r#"default_model = "demo"

[providers.demo]
type = "openai"

[providers.demo.env]
OPENAI_API_KEY = "test-api-key"

[models.demo]
provider = "demo"
model = "gpt-test"
"#,
        );

        let config = check_kimi_code_config_readiness();
        assert!(config.ready);
        assert_eq!(config.credential_sources, vec!["config env"]);
    }

    #[test]
    fn legacy_migration_hint_is_none_without_legacy_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        let _lock = env_lock();
        let previous_kimi_home = std::env::var_os("KIMI_CODE_HOME");
        let previous_userprofile = std::env::var_os("USERPROFILE");
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("KIMI_CODE_HOME", temp.path());
        std::env::set_var("USERPROFILE", temp.path());
        std::env::set_var("HOME", temp.path());

        assert!(legacy_migration_hint().is_none());

        match previous_kimi_home {
            Some(value) => std::env::set_var("KIMI_CODE_HOME", value),
            None => std::env::remove_var("KIMI_CODE_HOME"),
        }
        match previous_userprofile {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }
        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
    }
}
