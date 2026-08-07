//! Runtime spawn resolution and the post-handshake version gates.
//!
//! Split out of `host.rs` to keep each file under the 600-line module
//! budget. Dev default is the source-tree dist entry
//! `runtime/kimi-code/apps/desktop-runtime/dist/main.mjs` spawned with
//! `node`; `KIMI_RUNTIME_ENTRY` overrides the entry point (tests and fixture
//! injection).

use crate::runtime::protocol::RuntimeInfo;
use crate::runtime::supervisor::SpawnConfig;
use std::path::PathBuf;

/// Minimum Node version the source runtime supports (`engines.node` of
/// `apps/desktop-runtime`); gated against the handshake `RuntimeInfo`.
const MIN_NODE_VERSION: (u64, u64, u64) = (24, 15, 0);

/// Env override for the runtime entry point (tests / fixture injection).
const RUNTIME_ENTRY_ENV: &str = "KIMI_RUNTIME_ENTRY";

/// Spawn inputs for the next runtime child plus the resolved entry path
/// (kept apart so `readiness::check_artifact` can gate the file first).
pub(super) struct ResolvedSpawn {
    pub entry: PathBuf,
    pub config: SpawnConfig,
}

/// Dev default: the source-tree dist entry of the pinned desktop runtime.
fn default_runtime_entry() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("runtime")
        .join("kimi-code")
        .join("apps")
        .join("desktop-runtime")
        .join("dist")
        .join("main.mjs")
}

pub(super) fn resolve_spawn_config() -> ResolvedSpawn {
    let entry = std::env::var(RUNTIME_ENTRY_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_runtime_entry);
    ResolvedSpawn {
        config: SpawnConfig {
            program: "node".to_string(),
            args: vec![entry.to_string_lossy().into_owned()],
            env: Vec::new(),
            cwd: None,
        },
        entry,
    }
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.trim().trim_start_matches('v').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

/// Post-handshake gate on the runtime-reported Node version. The desktop
/// never probes `node --version` itself: the handshake `RuntimeInfo` is the
/// single source of truth for the process actually running the runtime.
pub(super) fn validate_node_version(info: &RuntimeInfo) -> Result<(), String> {
    match parse_version(&info.node_version) {
        Some(version) if version >= MIN_NODE_VERSION => Ok(()),
        Some(_) => Err(format!(
            "runtime node version `{}` is below the supported minimum `{}.{}.{}` — \
             reinstall the app so the bundled runtime matches",
            info.node_version, MIN_NODE_VERSION.0, MIN_NODE_VERSION.1, MIN_NODE_VERSION.2,
        )),
        None => Err(format!(
            "runtime reported an unparseable node version `{}`",
            info.node_version
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::protocol::{KimiSourceInfo, RuntimeCapabilities};
    use std::sync::Mutex;

    /// Serializes the env-mutating spawn-resolution test inside this binary.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn info_with_node(version: &str) -> RuntimeInfo {
        RuntimeInfo {
            selected_protocol: "runtime-v1".to_string(),
            runtime_version: "0.0.0-test".to_string(),
            kimi_source: KimiSourceInfo {
                tag: "@moonshot-ai/kimi-code@0.33.0".to_string(),
                commit: "abc".to_string(),
            },
            node_version: version.to_string(),
            capabilities: RuntimeCapabilities {
                methods: Vec::new(),
                sessions: true,
                turns: true,
                config: true,
                replay: true,
                auth: true,
                usage: true,
                fork: true,
                events: Vec::new(),
            },
            data_schema_version: 1,
        }
    }

    #[test]
    fn node_version_gate_accepts_minimum_and_rejects_older_or_garbage() {
        assert!(validate_node_version(&info_with_node("24.15.0")).is_ok());
        assert!(validate_node_version(&info_with_node("26.5.1")).is_ok());
        let err = validate_node_version(&info_with_node("22.9.0")).unwrap_err();
        assert!(err.contains("below the supported minimum"), "{err}");
        let err = validate_node_version(&info_with_node("not-a-version")).unwrap_err();
        assert!(err.contains("unparseable"), "{err}");
    }

    #[test]
    fn spawn_config_defaults_to_source_dist_entry_and_honors_override() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved = std::env::var(RUNTIME_ENTRY_ENV).ok();
        std::env::remove_var(RUNTIME_ENTRY_ENV);
        let resolved = resolve_spawn_config();
        assert!(
            resolved.entry.ends_with(
                PathBuf::from("runtime")
                    .join("kimi-code")
                    .join("apps")
                    .join("desktop-runtime")
                    .join("dist")
                    .join("main.mjs")
            ),
            "default entry: {}",
            resolved.entry.display()
        );
        assert_eq!(resolved.config.program, "node");
        assert_eq!(resolved.config.args.len(), 1);

        std::env::set_var(RUNTIME_ENTRY_ENV, "/tmp/custom-runtime.mjs");
        let resolved = resolve_spawn_config();
        assert_eq!(resolved.entry, PathBuf::from("/tmp/custom-runtime.mjs"));
        assert_eq!(resolved.config.args[0], "/tmp/custom-runtime.mjs");

        match saved {
            Some(value) => std::env::set_var(RUNTIME_ENTRY_ENV, value),
            None => std::env::remove_var(RUNTIME_ENTRY_ENV),
        }
    }
}
