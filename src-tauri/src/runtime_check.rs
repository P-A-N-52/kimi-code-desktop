use crate::acp::{resolve_acp_command_validated, validate_kimi_acp_command};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
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

fn check_kimi_code_runtime_readiness() -> RuntimeReadiness {
    let mut checks = Vec::new();
    let mut issues = Vec::new();
    let mut warnings = Vec::new();

    let program = match resolve_kimi_code_cli_program_blocking() {
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
            return build_kimi_code_runtime_readiness(checks, issues, warnings, None, None);
        }
    };

    let version = match resolve_kimi_code_cli_version_for_program(&program) {
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

    if let Err(error) = validate_kimi_acp_command(&program) {
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

    let config = check_kimi_code_config_readiness();
    match &config {
        ConfigReadiness {
            path: Some(path),
            exists: true,
            ready: true,
            ..
        } => {
            checks.push(RuntimeReadinessCheck {
                id: "kimiCodeConfig",
                label: "Kimi Code config.toml",
                status: CheckStatus::Ok,
                detail: format!("Kimi Code config is readable: {path}"),
            });
        }
        ConfigReadiness {
            path: Some(_path),
            exists: true,
            ready: false,
            error: Some(error),
            ..
        } => {
            issues.push(error.clone());
            checks.push(RuntimeReadinessCheck {
                id: "kimiCodeConfig",
                label: "Kimi Code config.toml",
                status: CheckStatus::Error,
                detail: error.clone(),
            });
        }
        ConfigReadiness {
            path: Some(path),
            exists: false,
            ..
        } => {
            let detail = format!(
                "Kimi Code config path resolved but file is not present yet: {path}. Run `kimi login` or `kimi migrate` if migrating from legacy."
            );
            warnings.push(detail.clone());
            checks.push(RuntimeReadinessCheck {
                id: "kimiCodeConfig",
                label: "Kimi Code config.toml",
                status: CheckStatus::Warning,
                detail,
            });
        }
        ConfigReadiness {
            error: Some(error), ..
        } => {
            issues.push(error.clone());
            checks.push(RuntimeReadinessCheck {
                id: "kimiCodeConfig",
                label: "Kimi Code config.toml",
                status: CheckStatus::Error,
                detail: error.clone(),
            });
        }
        _ => {}
    }

    if crate::managed_usage::credentials_present() {
        checks.push(RuntimeReadinessCheck {
            id: "credentials",
            label: "Kimi Code login",
            status: CheckStatus::Ok,
            detail: "Kimi Code credentials found under ~/.kimi-code/credentials/.".to_string(),
        });
    } else {
        let detail = "No Kimi Code credentials found. Sign in from Settings or this screen (device code), or run `kimi login`.".to_string();
        warnings.push(detail.clone());
        checks.push(RuntimeReadinessCheck {
            id: "credentials",
            label: "Kimi Code login",
            status: CheckStatus::Warning,
            detail,
        });
    }

    if let Some(hint) = legacy_migration_hint() {
        warnings.push(hint.clone());
        checks.push(RuntimeReadinessCheck {
            id: "legacyMigration",
            label: "Legacy Kimi migration",
            status: CheckStatus::Warning,
            detail: hint,
        });
    }

    build_kimi_code_runtime_readiness(checks, issues, warnings, Some(program), version)
}

fn build_kimi_code_runtime_readiness(
    checks: Vec<RuntimeReadinessCheck>,
    issues: Vec<String>,
    warnings: Vec<String>,
    program: Option<String>,
    version: Option<String>,
) -> RuntimeReadiness {
    let config = check_kimi_code_config_readiness();
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
            path: Some(path_string),
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
                error: Some(format!("Failed to read {}: {}", path.display(), error)),
            };
        }
    };

    match content.parse::<toml::Value>() {
        Ok(_) => ConfigReadiness {
            path: Some(path_string),
            exists: true,
            ready: true,
            has_default_model: false,
            has_provider_section: false,
            has_model_section: false,
            has_credential_source: false,
            credential_sources: Vec::new(),
            error: None,
        },
        Err(error) => ConfigReadiness {
            path: Some(path_string),
            exists: true,
            ready: false,
            has_default_model: false,
            has_provider_section: false,
            has_model_section: false,
            has_credential_source: false,
            credential_sources: Vec::new(),
            error: Some(format!("Invalid Kimi Code config TOML: {error}")),
        },
    }
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
        kimi_code_config_file_path, kimi_code_home_dir_from_values, legacy_migration_hint,
        parse_kimi_code_version_output, parse_version_from_output,
    };
    use std::path::{Path, PathBuf};

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
    fn kimi_config_path_uses_kimi_code_home() {
        let path = kimi_code_config_file_path("config.toml", None, Some(Path::new(r"C:\Users\u")))
            .unwrap();
        assert_eq!(path, PathBuf::from(r"C:\Users\u\.kimi-code\config.toml"));
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
    fn legacy_migration_hint_is_none_without_legacy_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::env::set_var("USERPROFILE", temp.path());
        std::env::set_var("HOME", temp.path());
        assert!(legacy_migration_hint().is_none());
        std::env::remove_var("USERPROFILE");
        std::env::remove_var("HOME");
    }
}
