//! Source Runtime artifact readiness gate (M2 wave 2).
//!
//! Answers "is the bundled source runtime usable, and if it is not, what
//! should the user do next?" — readiness failures are actionable
//! [`ReadinessError`]s with a category code, a human-readable message, and
//! diagnostic details, never bare io errors.
//!
//! The gate has three stages. `check_artifact` checks the runtime artifact
//! file (exists, regular, non-empty, readable); the path is caller-injected —
//! M2 tests pass the fixture worker, M4 resolves the real
//! `runtime/kimi-code/apps/desktop-runtime` dist entry from config before the
//! first supervisor spawn. `check_manifest` is a reserved release-manifest
//! gate (JSON with `kimiSource.tag`/`commit`, produced by the M5 packaging
//! pipeline). `check_runtime` spawns the artifact through
//! [`RuntimeSupervisor`], completes the `runtime.hello` handshake driven by a
//! [`HandshakeConfig`], and gates the reported [`RuntimeInfo`] through
//! `protocol::validate_runtime_info`.

use super::protocol::{validate_runtime_info, KimiSourceInfo, RuntimeInfo, RUNTIME_PROTOCOL};
use super::supervisor::{
    HandshakeConfig, RuntimeError, RuntimeSupervisor, ShutdownConfig, SpawnConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::path::Path;

/// Prefix of `protocol::validate_runtime_info`'s protocol-selection message,
/// surfaced inside `RuntimeError::Readiness`; kept in lockstep with `protocol.rs`.
const PROTOCOL_SELECTION_REASON: &str = "runtime selected protocol";

/// Actionable readiness failure categories; the serialized form is the code
/// the M4 UI keys its recovery copy on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessErrorKind {
    /// The artifact (or manifest) path does not exist.
    ArtifactMissing,
    /// The artifact exists but is unusable: not a file, empty, unreadable,
    /// or not a valid manifest.
    ArtifactInvalid,
    /// The runtime/manifest source commit differs from the pinned one.
    CommitMismatch,
    /// The runtime child did not complete its startup handshake.
    HandshakeFailed,
    /// The runtime selected a protocol other than `runtime-v1`.
    ProtocolMismatch,
}

impl ReadinessErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ArtifactMissing => "artifact_missing",
            Self::ArtifactInvalid => "artifact_invalid",
            Self::CommitMismatch => "commit_mismatch",
            Self::HandshakeFailed => "handshake_failed",
            Self::ProtocolMismatch => "protocol_mismatch",
        }
    }
}

impl fmt::Display for ReadinessErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A readiness failure: `message` says what happened and what to do next,
/// `details` carries structured diagnostics (paths, expected vs. reported).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessError {
    pub kind: ReadinessErrorKind,
    pub message: String,
    pub details: Option<Value>,
}

impl ReadinessError {
    fn artifact_missing(what: &str, path: &Path, io: &std::io::Error) -> Self {
        let path = path.to_string_lossy();
        Self {
            kind: ReadinessErrorKind::ArtifactMissing,
            message: format!(
                "{what} is missing at `{path}` — reinstall the app or restore the runtime bundle"
            ),
            details: Some(json!({
                "path": path,
                "ioError": io.to_string(),
            })),
        }
    }

    fn artifact_invalid(what: &str, path: &Path, reason: impl Into<String>) -> Self {
        let path = path.to_string_lossy();
        let reason = reason.into();
        Self {
            kind: ReadinessErrorKind::ArtifactInvalid,
            message: format!(
                "{what} at `{path}` is not usable: {reason} — reinstall the app or restore the \
                 runtime bundle"
            ),
            details: Some(json!({
                "path": path,
                "reason": reason,
            })),
        }
    }

    fn commit_mismatch(what: &str, expected: &str, reported: &str) -> Self {
        Self {
            kind: ReadinessErrorKind::CommitMismatch,
            message: format!(
                "{what} source commit `{reported}` does not match the pinned commit `{expected}` — \
                 reinstall the app release built for the pinned commit"
            ),
            details: Some(json!({
                "expected": expected,
                "reported": reported,
            })),
        }
    }

    fn protocol_mismatch(selected: &str, required: &str) -> Self {
        Self {
            kind: ReadinessErrorKind::ProtocolMismatch,
            message: format!(
                "runtime selected protocol `{selected}`, but the app requires `{required}` — \
                 reinstall the matching app release"
            ),
            details: Some(json!({
                "selected": selected,
                "required": required,
            })),
        }
    }

    /// Protocol mismatch observed only as a validation message (the
    /// supervisor consumed the offending `RuntimeInfo`).
    fn protocol_mismatch_reason(reason: String) -> Self {
        Self {
            kind: ReadinessErrorKind::ProtocolMismatch,
            message: format!(
                "runtime did not select the required `{RUNTIME_PROTOCOL}` protocol — \
                 reinstall the matching app release"
            ),
            details: Some(json!({ "reason": reason })),
        }
    }

    fn handshake_failed(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self {
            kind: ReadinessErrorKind::HandshakeFailed,
            message: format!(
                "runtime did not complete its startup handshake: {reason} — reinstall the app or \
                 check the runtime logs"
            ),
            details: Some(json!({ "reason": reason })),
        }
    }
}

impl fmt::Display for ReadinessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for ReadinessError {}

/// Aggregate readiness result; `ok` is true only when every gate passed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessReport {
    pub ok: bool,
    pub artifact_path: String,
    pub expected_commit: Option<String>,
    pub errors: Vec<ReadinessError>,
}

/// Release manifest shape (reserved, M5 alignment): mirrors the `kimiSource`
/// identity the runtime reports in `RuntimeInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub kimi_source: KimiSourceInfo,
}

/// Gate a parsed `RuntimeInfo` against the protocol contract and the pinned
/// commit, reusing `protocol::validate_runtime_info` for the comparisons.
pub fn validate_info(
    info: &RuntimeInfo,
    expected_commit: Option<&str>,
) -> Result<(), ReadinessError> {
    if validate_runtime_info(info, expected_commit).is_err() {
        // `validate_runtime_info` checks protocol selection first, so a
        // failure with a correct protocol is the commit gate (unreachable
        // when `expected_commit` is None).
        let error = if info.selected_protocol != RUNTIME_PROTOCOL {
            ReadinessError::protocol_mismatch(&info.selected_protocol, RUNTIME_PROTOCOL)
        } else {
            ReadinessError::commit_mismatch(
                "runtime",
                expected_commit.unwrap_or_default(),
                &info.kimi_source.commit,
            )
        };
        return Err(error);
    }
    Ok(())
}

/// Filesystem gate on the runtime artifact: exists, regular file, non-empty,
/// readable. M4 wiring point: the real dist entry path comes from the M4
/// config surface (the `runtime/kimi-code/apps/desktop-runtime` dist entry).
pub fn check_artifact(path: &Path) -> Result<(), ReadinessError> {
    check_artifact_impl("runtime artifact", path)
}

fn check_artifact_impl(what: &str, path: &Path) -> Result<(), ReadinessError> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(ReadinessError::artifact_missing(what, path, &err));
        }
        Err(err) => {
            return Err(ReadinessError::artifact_invalid(
                what,
                path,
                format!("could not be inspected: {err}"),
            ));
        }
    };
    if !metadata.is_file() {
        return Err(ReadinessError::artifact_invalid(
            what,
            path,
            "path is not a regular file",
        ));
    }
    if metadata.len() == 0 {
        return Err(ReadinessError::artifact_invalid(
            what,
            path,
            "file is empty",
        ));
    }
    if let Err(err) = std::fs::File::open(path) {
        return Err(ReadinessError::artifact_invalid(
            what,
            path,
            format!("file is not readable: {err}"),
        ));
    }
    Ok(())
}

/// Release-manifest gate (reserved for M5): the file must pass the artifact
/// checks, parse as JSON carrying `kimiSource.tag`/`commit`, and match the
/// pinned commit when one is set. M5 produces the manifest at packaging time.
pub fn check_manifest(
    path: &Path,
    expected_commit: Option<&str>,
) -> Result<ReleaseManifest, ReadinessError> {
    check_artifact_impl("release manifest", path)?;
    let text = std::fs::read_to_string(path).map_err(|err| {
        ReadinessError::artifact_invalid(
            "release manifest",
            path,
            format!("could not be read: {err}"),
        )
    })?;
    let manifest: ReleaseManifest = serde_json::from_str(&text).map_err(|err| {
        ReadinessError::artifact_invalid(
            "release manifest",
            path,
            format!("not a valid manifest (expected JSON with `kimiSource.tag`/`commit`): {err}"),
        )
    })?;
    if let Some(expected) = expected_commit {
        if manifest.kimi_source.commit != expected {
            return Err(ReadinessError::commit_mismatch(
                "release manifest",
                expected,
                &manifest.kimi_source.commit,
            ));
        }
    }
    Ok(manifest)
}

/// Live gate: spawn the artifact through [`RuntimeSupervisor`] and complete
/// the `runtime.hello` handshake with the given [`HandshakeConfig`]. Any
/// failure becomes an actionable [`ReadinessError`]; the probe shuts the
/// runtime down before returning. M4 wiring point: called with the artifact
/// spawn config and the frozen-commit `HandshakeConfig`; the returned
/// `RuntimeInfo` can drive the runtime version banner.
pub fn check_runtime(
    spawn: &SpawnConfig,
    handshake: &HandshakeConfig,
) -> Result<RuntimeInfo, ReadinessError> {
    let supervisor = RuntimeSupervisor::new(spawn.clone());
    supervisor
        .start()
        .map_err(|err| ReadinessError::handshake_failed(err.to_string()))?;

    // Probe commit-free first: the supervisor handshake validates protocol
    // selection internally, keeping a mismatch observable for classification.
    let probe = HandshakeConfig {
        hello: handshake.hello.clone(),
        expected_commit: None,
        timeout: handshake.timeout,
    };
    let info = match supervisor.handshake(&probe) {
        Ok(info) => info,
        Err(RuntimeError::Readiness(reason)) => {
            let failure = match classify_readiness_reason(&reason) {
                ReadinessErrorKind::ProtocolMismatch => {
                    ReadinessError::protocol_mismatch_reason(reason)
                }
                _ => ReadinessError::handshake_failed(reason),
            };
            let _ = supervisor.shutdown(&ShutdownConfig::default());
            return Err(failure);
        }
        Err(err) => {
            let failure = ReadinessError::handshake_failed(err.to_string());
            let _ = supervisor.shutdown(&ShutdownConfig::default());
            return Err(failure);
        }
    };

    let gate = validate_info(&info, handshake.expected_commit.as_deref());
    let _ = supervisor.shutdown(&ShutdownConfig::default());
    gate?;
    Ok(info)
}

/// Classify a handshake validation message that arrived without the offending
/// `RuntimeInfo` (see `check_runtime`).
fn classify_readiness_reason(reason: &str) -> ReadinessErrorKind {
    if reason.starts_with(PROTOCOL_SELECTION_REASON) {
        ReadinessErrorKind::ProtocolMismatch
    } else {
        ReadinessErrorKind::HandshakeFailed
    }
}

/// Aggregate readiness gate: artifact, optional manifest, then the live
/// runtime probe (skipped when the artifact gate failed). Never fails;
/// failures land in `report.errors`.
pub fn check_readiness(
    artifact_path: &Path,
    manifest_path: Option<&Path>,
    spawn: &SpawnConfig,
    handshake: &HandshakeConfig,
) -> ReadinessReport {
    let mut errors = Vec::new();
    let artifact_result = check_artifact(artifact_path);
    match &artifact_result {
        Ok(()) => {}
        Err(err) => errors.push(err.clone()),
    }
    if let Some(manifest_path) = manifest_path {
        if let Err(err) = check_manifest(manifest_path, handshake.expected_commit.as_deref()) {
            errors.push(err);
        }
    }
    if let Ok(()) = artifact_result {
        if let Err(err) = check_runtime(spawn, handshake) {
            errors.push(err);
        }
    }
    ReadinessReport {
        ok: errors.is_empty(),
        artifact_path: artifact_path.to_string_lossy().into_owned(),
        expected_commit: handshake.expected_commit.clone(),
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::super::protocol::{HelloParams, RuntimeCapabilities};
    use super::*;
    use std::time::Duration;

    /// Fixture worker used as the injected artifact.
    const FIXTURE_WORKER: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/runtime-fixture-worker.mjs"
    );
    const EXPECTED_COMMIT: &str = "53c832dfdf9566afd59a8b3d54ebd36d3cb03d72";

    fn runtime_info(protocol: &str, commit: &str) -> RuntimeInfo {
        RuntimeInfo {
            selected_protocol: protocol.to_string(),
            runtime_version: "0.0.0-fixture".to_string(),
            kimi_source: KimiSourceInfo {
                tag: "@moonshot-ai/kimi-code@0.33.0".to_string(),
                commit: commit.to_string(),
            },
            node_version: "24.15.0".to_string(),
            capabilities: RuntimeCapabilities {
                methods: Vec::new(),
                sessions: false,
                turns: false,
                config: false,
                replay: false,
                auth: false,
                usage: false,
                fork: false,
                events: Vec::new(),
            },
            data_schema_version: 1,
        }
    }

    #[test]
    fn artifact_check_accepts_fixture_worker_and_reports_bad_paths() {
        check_artifact(Path::new(FIXTURE_WORKER)).expect("fixture worker is a valid artifact");

        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("no-such-worker.mjs");
        let err = check_artifact(&missing).unwrap_err();
        assert_eq!(err.kind, ReadinessErrorKind::ArtifactMissing);
        assert!(err.message.contains("reinstall"), "{err}");
        assert_eq!(
            err.details.unwrap()["path"].as_str().unwrap(),
            missing.to_string_lossy()
        );

        let empty = dir.path().join("empty-worker.mjs");
        std::fs::write(&empty, b"").expect("write empty file");
        let err = check_artifact(&empty).unwrap_err();
        assert_eq!(err.kind, ReadinessErrorKind::ArtifactInvalid);
        assert!(err.message.contains("empty"));
    }

    #[test]
    fn validate_info_accepts_valid_info_and_reports_mismatches() {
        let info = runtime_info(RUNTIME_PROTOCOL, EXPECTED_COMMIT);
        assert!(validate_info(&info, Some(EXPECTED_COMMIT)).is_ok());
        assert!(validate_info(&info, None).is_ok());
        assert!(validate_info(&runtime_info(RUNTIME_PROTOCOL, "anything"), None).is_ok());

        let info = runtime_info(RUNTIME_PROTOCOL, "deadbeef");
        let err = validate_info(&info, Some(EXPECTED_COMMIT)).unwrap_err();
        assert_eq!(err.kind, ReadinessErrorKind::CommitMismatch);
        let details = err.details.as_ref().expect("details");
        assert_eq!(details["expected"], json!(EXPECTED_COMMIT));
        assert_eq!(details["reported"], json!("deadbeef"));
        assert!(err.message.contains("reinstall"), "{err}");

        // Protocol mismatch wins even with a matching commit.
        let info = runtime_info("runtime-v2", EXPECTED_COMMIT);
        let err = validate_info(&info, Some(EXPECTED_COMMIT)).unwrap_err();
        assert_eq!(err.kind, ReadinessErrorKind::ProtocolMismatch);
        let details = err.details.as_ref().expect("details");
        assert_eq!(details["selected"], json!("runtime-v2"));
        assert_eq!(details["required"], json!(RUNTIME_PROTOCOL));
        assert!(err.message.contains("reinstall"), "{err}");
    }

    #[test]
    fn manifest_check_gates_matching_and_reports_bad_manifests() {
        let dir = tempfile::tempdir().expect("tempdir");
        let write_manifest = |name: &str, commit: &str| {
            let path = dir.path().join(name);
            std::fs::write(
                &path,
                format!(
                    r#"{{"kimiSource": {{"tag": "@moonshot-ai/kimi-code@0.33.0", "commit": "{commit}"}}}}"#
                ),
            )
            .expect("write manifest");
            path
        };

        let matching = write_manifest("matching.json", EXPECTED_COMMIT);
        let manifest = check_manifest(&matching, Some(EXPECTED_COMMIT)).expect("manifest ok");
        assert_eq!(manifest.kimi_source.tag, "@moonshot-ai/kimi-code@0.33.0");
        assert_eq!(manifest.kimi_source.commit, EXPECTED_COMMIT);

        let mismatched = write_manifest("mismatched.json", "deadbeef");
        let err = check_manifest(&mismatched, Some(EXPECTED_COMMIT)).unwrap_err();
        assert_eq!(err.kind, ReadinessErrorKind::CommitMismatch);
        let details = err.details.as_ref().expect("details");
        assert_eq!(details["expected"], json!(EXPECTED_COMMIT));
        assert_eq!(details["reported"], json!("deadbeef"));
        assert!(err.message.contains("reinstall"), "{err}");

        let missing = dir.path().join("missing.json");
        let err = check_manifest(&missing, Some(EXPECTED_COMMIT)).unwrap_err();
        assert_eq!(err.kind, ReadinessErrorKind::ArtifactMissing);

        let malformed = write_manifest("malformed.json", "");
        std::fs::write(&malformed, "not json").expect("overwrite with malformed manifest");
        let err = check_manifest(&malformed, Some(EXPECTED_COMMIT)).unwrap_err();
        assert_eq!(err.kind, ReadinessErrorKind::ArtifactInvalid);
        assert!(err.message.contains("kimiSource"));
    }

    #[test]
    fn readiness_error_kinds_serialize_and_display_as_codes() {
        for (kind, code) in [
            (ReadinessErrorKind::ArtifactMissing, "artifact_missing"),
            (ReadinessErrorKind::ArtifactInvalid, "artifact_invalid"),
            (ReadinessErrorKind::CommitMismatch, "commit_mismatch"),
            (ReadinessErrorKind::HandshakeFailed, "handshake_failed"),
            (ReadinessErrorKind::ProtocolMismatch, "protocol_mismatch"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(code));
            assert_eq!(kind.to_string(), code);
        }
        let err = ReadinessError::commit_mismatch("runtime", "abc", "def");
        let text = err.to_string();
        assert!(text.starts_with("commit_mismatch: "));
        assert!(text.contains("`def`") && text.contains("`abc`"));

        // Handshake-validation messages without the offending info classify by
        // the stable protocol-selection prefix.
        assert_eq!(
            classify_readiness_reason(
                "runtime selected protocol `runtime-v2`, expected `runtime-v1`"
            ),
            ReadinessErrorKind::ProtocolMismatch
        );
        assert_eq!(
            classify_readiness_reason(
                "hello result is not a runtimeInfo: missing field `capabilities`"
            ),
            ReadinessErrorKind::HandshakeFailed
        );
    }

    #[test]
    fn readiness_report_serializes_to_stable_shape_and_aggregates() {
        let report = ReadinessReport {
            ok: false,
            artifact_path: "/opt/kimi/runtime/index.mjs".to_string(),
            expected_commit: Some(EXPECTED_COMMIT.to_string()),
            errors: vec![
                ReadinessError::artifact_missing(
                    "runtime artifact",
                    Path::new("/opt/kimi/runtime/index.mjs"),
                    &std::io::Error::new(std::io::ErrorKind::NotFound, "no such file"),
                ),
                ReadinessError::commit_mismatch("runtime", "abc", "def"),
            ],
        };
        let value = serde_json::to_value(&report).unwrap();
        let obj = value.as_object().expect("report serializes to an object");
        assert_eq!(obj.len(), 4, "report shape: {obj:?}");
        assert_eq!(obj["ok"], json!(false));
        assert_eq!(obj["artifactPath"], json!("/opt/kimi/runtime/index.mjs"));
        assert_eq!(obj["expectedCommit"], json!(EXPECTED_COMMIT));
        let errors = obj["errors"].as_array().expect("errors array");
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0]["kind"], json!("artifact_missing"));
        assert_eq!(
            errors[0]["details"]["path"],
            json!("/opt/kimi/runtime/index.mjs")
        );
        assert_eq!(errors[1]["kind"], json!("commit_mismatch"));
        assert_eq!(errors[1]["details"]["expected"], json!("abc"));
        assert_eq!(errors[1]["details"]["reported"], json!("def"));

        // The report round-trips through JSON unchanged.
        let back: ReadinessReport = serde_json::from_value(value).unwrap();
        assert_eq!(back, report);

        // Aggregate gate: a missing artifact is the only error and the live
        // probe is skipped so it cannot pile a spawn failure on top.
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing-worker.mjs");
        let spawn = SpawnConfig {
            program: "node".to_string(),
            args: vec![missing.to_string_lossy().into_owned()],
            env: Vec::new(),
            cwd: None,
        };
        let handshake = HandshakeConfig {
            hello: HelloParams::new(
                env!("CARGO_PKG_VERSION"),
                std::env::temp_dir().to_string_lossy().into_owned(),
                std::env::consts::OS,
                std::env::consts::ARCH,
                "en-US",
            ),
            expected_commit: Some(EXPECTED_COMMIT.to_string()),
            timeout: Duration::from_secs(15),
        };
        let report = check_readiness(&missing, None, &spawn, &handshake);
        assert!(!report.ok);
        assert_eq!(report.errors.len(), 1, "probe must be skipped: {report:?}");
        assert_eq!(report.errors[0].kind, ReadinessErrorKind::ArtifactMissing);
        assert_eq!(report.artifact_path, missing.to_string_lossy().as_ref());
    }
}
