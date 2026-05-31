use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

const BUNDLED_RUNTIME_INFO_TIMEOUT: Duration = Duration::from_secs(12);
const KIMI_CLI_INFO_TIMEOUT: Duration = Duration::from_secs(5);
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledRuntimeInfo {
    #[serde(default)]
    available: bool,
    kimi_cli_version: Option<String>,
    kimi_cli_package_path: Option<String>,
    executable: Option<String>,
}

pub async fn check_runtime_readiness(app: &AppHandle) -> RuntimeReadiness {
    let mut checks = Vec::new();
    let mut issues = Vec::new();
    let mut warnings = Vec::new();

    let bundled_runtime = probe_bundled_runtime(app).await;
    if bundled_runtime.available {
        checks.push(RuntimeReadinessCheck {
            id: "bundledRuntime",
            label: "Bundled Kimi CLI runtime",
            status: CheckStatus::Ok,
            detail: bundled_runtime
                .version
                .as_ref()
                .map(|version| format!("Bundled runtime is available: v{}", version))
                .unwrap_or_else(|| "Bundled runtime is available.".to_string()),
        });
    } else {
        let detail = bundled_runtime
            .error
            .clone()
            .unwrap_or_else(|| "Bundled runtime is unavailable.".to_string());
        issues.push(format!(
            "Bundled Kimi CLI runtime is unavailable: {}",
            detail
        ));
        checks.push(RuntimeReadinessCheck {
            id: "bundledRuntime",
            label: "Bundled Kimi CLI runtime",
            status: CheckStatus::Error,
            detail,
        });
    }

    let external_cli = probe_external_cli();
    if external_cli.available {
        checks.push(RuntimeReadinessCheck {
            id: "externalCli",
            label: "External legacy Kimi CLI",
            status: CheckStatus::Ok,
            detail: match (&external_cli.program, &external_cli.version) {
                (Some(program), Some(version)) => {
                    format!(
                        "Compatible legacy login helper found: {} (v{})",
                        program, version
                    )
                }
                (Some(program), None) => {
                    format!("Compatible legacy login helper found: {}", program)
                }
                _ => "Compatible legacy login helper found.".to_string(),
            },
        });
    } else {
        let detail = external_cli.error.clone().unwrap_or_else(|| {
            "External legacy 'kimi' command was not found. The desktop app can use the bundled runtime, but terminal login/setup needs the Python kimi-cli runtime.".to_string()
        });
        warnings.push(detail.clone());
        checks.push(RuntimeReadinessCheck {
            id: "externalCli",
            label: "External legacy Kimi CLI",
            status: CheckStatus::Warning,
            detail,
        });
    }

    let config = check_config_readiness();
    if config.ready {
        checks.push(RuntimeReadinessCheck {
            id: "config",
            label: "Kimi config.toml",
            status: CheckStatus::Ok,
            detail: config
                .path
                .as_ref()
                .map(|path| format!("Config structure is usable: {}", path))
                .unwrap_or_else(|| "Config structure is usable.".to_string()),
        });
    } else {
        let detail = config
            .error
            .clone()
            .unwrap_or_else(|| "Kimi config.toml is not ready.".to_string());
        issues.push(detail.clone());
        checks.push(RuntimeReadinessCheck {
            id: "config",
            label: "Kimi config.toml",
            status: CheckStatus::Error,
            detail,
        });
    }

    if config.ready && config.has_credential_source {
        checks.push(RuntimeReadinessCheck {
            id: "credentials",
            label: "Credential source",
            status: CheckStatus::Ok,
            detail: format!(
                "Credential source detected: {}",
                config.credential_sources.join(", ")
            ),
        });
    } else if config.ready && external_cli.available {
        let detail = "No credential source was detected. Launch can continue because a compatible legacy Kimi CLI is available for login/setup.".to_string();
        warnings.push(detail.clone());
        checks.push(RuntimeReadinessCheck {
            id: "credentials",
            label: "Credential source",
            status: CheckStatus::Warning,
            detail,
        });
    } else if config.ready {
        let detail = "No credential source was detected and no compatible legacy Kimi CLI is available for login/setup.".to_string();
        issues.push(detail.clone());
        checks.push(RuntimeReadinessCheck {
            id: "credentials",
            label: "Credential source",
            status: CheckStatus::Error,
            detail,
        });
    }

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

pub async fn resolve_runtime_kimi_cli_version(app: &AppHandle) -> Result<String, String> {
    let bundled = probe_bundled_runtime(app).await;
    if let Some(version) = bundled.version {
        return Ok(version);
    }

    resolve_external_kimi_cli_version_blocking()
}

pub fn resolve_external_kimi_cli_program_blocking() -> Result<String, String> {
    let mut errors = Vec::new();
    for program in kimi_cli_version_candidates() {
        match resolve_compatible_kimi_cli_version_for_program(&program) {
            Ok(_) => return Ok(program),
            Err(error) => errors.push(format!("{}: {}", program, error)),
        }
    }

    Err(format!("Unable to find Kimi CLI ({})", errors.join("; ")))
}

fn resolve_external_kimi_cli_version_blocking() -> Result<String, String> {
    let mut errors = Vec::new();
    for program in kimi_cli_version_candidates() {
        match resolve_compatible_kimi_cli_version_for_program(&program) {
            Ok(version) => return Ok(version),
            Err(error) => errors.push(format!("{}: {}", program, error)),
        }
    }

    Err(format!(
        "Unable to resolve compatible legacy Kimi CLI version ({})",
        errors.join("; ")
    ))
}

async fn probe_bundled_runtime(app: &AppHandle) -> BundledRuntimeStatus {
    match run_bundled_sidecar_command(
        app,
        &["__desktop-runtime-info"],
        BUNDLED_RUNTIME_INFO_TIMEOUT,
    )
    .await
    {
        Ok(output) => match serde_json::from_str::<BundledRuntimeInfo>(output.trim()) {
            Ok(info) => BundledRuntimeStatus {
                available: info.available,
                version: info.kimi_cli_version,
                package_path: info.kimi_cli_package_path,
                executable: info.executable,
                error: None,
            },
            Err(error) => BundledRuntimeStatus {
                available: false,
                version: None,
                package_path: None,
                executable: None,
                error: Some(format!(
                    "Bundled sidecar returned invalid runtime info: {}",
                    error
                )),
            },
        },
        Err(error) => BundledRuntimeStatus {
            available: false,
            version: None,
            package_path: None,
            executable: None,
            error: Some(error),
        },
    }
}

async fn run_bundled_sidecar_command(
    app: &AppHandle,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let command = app
        .shell()
        .sidecar("kimi-sidecar")
        .map_err(|e| format!("Failed to create bundled sidecar command: {}", e))?
        .args(args);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("Failed to spawn bundled sidecar: {}", e))?;

    let collect = async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => stdout.extend_from_slice(&bytes),
                CommandEvent::Stderr(bytes) => stderr.extend_from_slice(&bytes),
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }

        if stdout.is_empty() {
            let stderr_text = String::from_utf8_lossy(&stderr).trim().to_string();
            if stderr_text.is_empty() {
                return Err("Bundled sidecar produced no runtime info.".to_string());
            }
            return Err(stderr_text);
        }

        Ok(String::from_utf8_lossy(&stdout).to_string())
    };

    match tokio::time::timeout(timeout, collect).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill();
            Err(format!(
                "Bundled sidecar timed out after {}s.",
                timeout.as_secs()
            ))
        }
    }
}

fn probe_external_cli() -> ExternalCliStatus {
    match resolve_external_kimi_cli_program_and_version() {
        Ok((program, version)) => ExternalCliStatus {
            available: true,
            program: Some(program),
            version: Some(version),
            error: None,
        },
        Err(error) => ExternalCliStatus {
            available: false,
            program: None,
            version: None,
            error: Some(error),
        },
    }
}

fn resolve_external_kimi_cli_program_and_version() -> Result<(String, String), String> {
    let mut errors = Vec::new();
    for program in kimi_cli_version_candidates() {
        match resolve_compatible_kimi_cli_version_for_program(&program) {
            Ok(version) => return Ok((program, version)),
            Err(error) => errors.push(format!("{}: {}", program, error)),
        }
    }

    Err(format!(
        "Unable to find compatible legacy Kimi CLI ({})",
        errors.join("; ")
    ))
}

fn kimi_cli_version_candidates() -> Vec<String> {
    let mut candidates = Vec::new();

    if let Ok(bin) = std::env::var("KIMI_CLI_BIN") {
        push_unique_candidate(&mut candidates, bin);
    }

    push_unique_candidate(&mut candidates, "kimi");

    #[cfg(target_os = "windows")]
    {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            push_unique_candidate(
                &mut candidates,
                Path::new(&user_profile)
                    .join(".local")
                    .join("bin")
                    .join("kimi.exe")
                    .to_string_lossy()
                    .to_string(),
            );
            push_unique_candidate(
                &mut candidates,
                Path::new(&user_profile)
                    .join(".kimi")
                    .join("Scripts")
                    .join("kimi.exe")
                    .to_string_lossy()
                    .to_string(),
            );
        }

        if let Ok(appdata) = std::env::var("APPDATA") {
            push_unique_candidate(
                &mut candidates,
                Path::new(&appdata)
                    .join("uv")
                    .join("tools")
                    .join("kimi-cli")
                    .join("Scripts")
                    .join("kimi.exe")
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }

    candidates
}

fn push_unique_candidate(candidates: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() {
        return;
    }

    if !candidates
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(trimmed))
    {
        candidates.push(trimmed.to_string());
    }
}

fn resolve_compatible_kimi_cli_version_for_program(program: &str) -> Result<String, String> {
    match run_kimi_command(program, &["info"], KIMI_CLI_INFO_TIMEOUT) {
        Ok(output) => {
            if let Some(version) = parse_legacy_kimi_info_version(&output) {
                return Ok(version);
            }
            let detected_version = resolve_kimi_cli_version_for_program(program).ok();
            let suffix = detected_version
                .map(|version| format!(" Detected version: v{}.", version))
                .unwrap_or_default();
            Err(format!(
                "not a compatible legacy Python kimi-cli runtime; `kimi info` did not report kimi-cli, wire, and Python runtime details.{}",
                suffix
            ))
        }
        Err(info_error) => match resolve_kimi_cli_version_for_program(program) {
            Ok(version) => Err(format!(
                "found Kimi CLI v{}, but it does not expose the legacy Python `kimi info` runtime contract required by Kimi Code Desktop: {}",
                version, info_error
            )),
            Err(version_error) => Err(format!(
                "not a runnable compatible Kimi CLI (info: {}; version: {})",
                info_error, version_error
            )),
        },
    }
}

fn resolve_kimi_cli_version_for_program(program: &str) -> Result<String, String> {
    let mut errors = Vec::new();
    for args in KIMI_CLI_VERSION_COMMANDS {
        let command_label = args.join(" ");
        match run_kimi_command(program, args, KIMI_CLI_VERSION_TIMEOUT) {
            Ok(output) => {
                if let Some(version) = parse_version_from_output(&output) {
                    return Ok(version);
                }
                errors.push(format!(
                    "{} returned unparseable output: {}",
                    command_label,
                    output.trim()
                ));
            }
            Err(error) => errors.push(format!("{}: {}", command_label, error)),
        }
    }

    Err(errors.join("; "))
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

fn parse_legacy_kimi_info_version(output: &str) -> Option<String> {
    let normalized = output.to_ascii_lowercase();
    if !normalized.contains("kimi-cli version")
        || !normalized.contains("wire protocol")
        || !normalized.contains("python version")
    {
        return None;
    }

    output.lines().find_map(|line| {
        let (label, value) = line.split_once(':')?;
        if label.trim().eq_ignore_ascii_case("kimi-cli version") {
            parse_version_from_output(value)
        } else {
            None
        }
    })
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

fn check_config_readiness() -> ConfigReadiness {
    let path = match user_home_dir() {
        Ok(home) => home.join(".kimi").join("config.toml"),
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

    if !path.exists() {
        return ConfigReadiness {
            path: Some(path.to_string_lossy().to_string()),
            exists: false,
            ready: false,
            has_default_model: false,
            has_provider_section: false,
            has_model_section: false,
            has_credential_source: false,
            credential_sources: credential_sources(false, false),
            error: Some(format!("Kimi config not found: {}", path.display())),
        };
    }

    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            return ConfigReadiness {
                path: Some(path.to_string_lossy().to_string()),
                exists: true,
                ready: false,
                has_default_model: false,
                has_provider_section: false,
                has_model_section: false,
                has_credential_source: false,
                credential_sources: credential_sources(false, false),
                error: Some(format!("Failed to read {}: {}", path.display(), error)),
            };
        }
    };

    let parsed = match content.parse::<toml::Value>() {
        Ok(value) => value,
        Err(error) => {
            return ConfigReadiness {
                path: Some(path.to_string_lossy().to_string()),
                exists: true,
                ready: false,
                has_default_model: false,
                has_provider_section: false,
                has_model_section: false,
                has_credential_source: false,
                credential_sources: credential_sources(false, false),
                error: Some(format!("Invalid Kimi config TOML: {}", error)),
            };
        }
    };

    let has_default_model = parsed
        .get("default_model")
        .and_then(toml::Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let has_provider_section = has_non_empty_table(parsed.get("providers"));
    let has_model_section = has_non_empty_table(parsed.get("models"));
    let has_config_api_key = toml_has_non_empty_key(&parsed, "api_key");
    let has_config_env = toml_has_key(&parsed, "env");
    let sources = credential_sources(has_config_api_key, has_config_env);
    let has_credential_source = !sources.is_empty();
    let ready = has_default_model && has_provider_section && has_model_section;

    let error = if ready {
        None
    } else {
        let mut missing = Vec::new();
        if !has_default_model {
            missing.push("default_model");
        }
        if !has_provider_section {
            missing.push("[providers.*]");
        }
        if !has_model_section {
            missing.push("[models.*]");
        }
        Some(format!("config.toml is missing {}.", missing.join(", ")))
    };

    ConfigReadiness {
        path: Some(path.to_string_lossy().to_string()),
        exists: true,
        ready,
        has_default_model,
        has_provider_section,
        has_model_section,
        has_credential_source,
        credential_sources: sources,
        error,
    }
}

fn user_home_dir() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve user home directory".to_string())
}

fn has_non_empty_table(value: Option<&toml::Value>) -> bool {
    value
        .and_then(toml::Value::as_table)
        .map(|table| !table.is_empty())
        .unwrap_or(false)
}

fn toml_has_non_empty_key(value: &toml::Value, key: &str) -> bool {
    match value {
        toml::Value::Table(table) => table.iter().any(|(candidate, nested)| {
            if candidate == key {
                return match nested {
                    toml::Value::String(value) => !value.trim().is_empty(),
                    toml::Value::Boolean(_) => true,
                    toml::Value::Integer(_) => true,
                    toml::Value::Float(_) => true,
                    toml::Value::Datetime(_) => true,
                    toml::Value::Array(values) => !values.is_empty(),
                    toml::Value::Table(values) => !values.is_empty(),
                };
            }
            toml_has_non_empty_key(nested, key)
        }),
        toml::Value::Array(values) => values
            .iter()
            .any(|nested| toml_has_non_empty_key(nested, key)),
        _ => false,
    }
}

fn toml_has_key(value: &toml::Value, key: &str) -> bool {
    match value {
        toml::Value::Table(table) => table
            .iter()
            .any(|(candidate, nested)| candidate == key || toml_has_key(nested, key)),
        toml::Value::Array(values) => values.iter().any(|nested| toml_has_key(nested, key)),
        _ => false,
    }
}

fn credential_sources(has_config_api_key: bool, has_config_env: bool) -> Vec<String> {
    let mut sources = Vec::new();
    if has_config_api_key {
        sources.push("config api_key".to_string());
    }
    if has_config_env {
        sources.push("config env".to_string());
    }
    sources.extend(runtime_env_credential_sources());
    if has_credential_files() {
        sources.push("Kimi credential file".to_string());
    }
    sources
}

fn runtime_env_credential_sources() -> Vec<String> {
    let keys = [
        "KIMI_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "VERTEXAI_PROJECT",
    ];
    keys.iter()
        .filter(|key| {
            std::env::var(key)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        })
        .map(|key| format!("{} env", key))
        .collect()
}

fn has_credential_files() -> bool {
    let Ok(home) = user_home_dir() else {
        return false;
    };
    let credentials_dir = home.join(".kimi").join("credentials");
    let Ok(entries) = fs::read_dir(credentials_dir) else {
        return false;
    };

    entries.filter_map(Result::ok).any(|entry| {
        let path = entry.path();
        path.is_file()
            && path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("json"))
                .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_legacy_kimi_info_version, parse_version_from_output};

    #[test]
    fn parses_legacy_python_kimi_info_version() {
        let output = "\
kimi-cli version: 1.45.0
agent spec versions: 1
wire protocol: 1.10
python version: 3.13.2
";
        assert_eq!(
            parse_legacy_kimi_info_version(output),
            Some("1.45.0".to_string())
        );
    }

    #[test]
    fn rejects_plain_node_kimi_code_version_as_legacy_info() {
        assert_eq!(parse_legacy_kimi_info_version("0.6.0"), None);
    }

    #[test]
    fn rejects_incomplete_info_output() {
        let output = "\
kimi-cli version: 1.45.0
python version: 3.13.2
";
        assert_eq!(parse_legacy_kimi_info_version(output), None);
    }

    #[test]
    fn parses_generic_cli_version_output() {
        assert_eq!(
            parse_version_from_output("kimi, version 1.45.0"),
            Some("1.45.0".to_string())
        );
    }
}
