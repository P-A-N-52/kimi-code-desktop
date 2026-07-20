//! Runtime backend selection — desktop is ACP-only (`kimi acp`).

use serde::Serialize;

/// Selected desktop runtime backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeBackend {
    Acp,
}

/// App-managed runtime selection snapshot (always ACP).
#[derive(Debug, Clone)]
pub struct RuntimeSelection {
    backend: RuntimeBackend,
}

impl RuntimeSelection {
    /// Read `KIMI_DESKTOP_RUNTIME` for deprecation warnings; backend is always ACP.
    pub fn from_env() -> Self {
        if let Ok(value) = std::env::var("KIMI_DESKTOP_RUNTIME") {
            let trimmed = value.trim().to_ascii_lowercase();
            if !trimmed.is_empty() && trimmed != "acp" {
                eprintln!(
                    "[WARN] KIMI_DESKTOP_RUNTIME={value} is deprecated; desktop is ACP-only now."
                );
            }
        }
        Self {
            backend: RuntimeBackend::Acp,
        }
    }

    pub fn backend(&self) -> RuntimeBackend {
        self.backend
    }

    pub fn is_acp(&self) -> bool {
        true
    }
}

/// Parse a runtime env value without touching the process environment.
pub fn runtime_backend_from_env_value(_value: Option<&str>) -> RuntimeBackend {
    RuntimeBackend::Acp
}

#[cfg(test)]
mod tests {
    use super::{runtime_backend_from_env_value, RuntimeBackend, RuntimeSelection};

    #[test]
    fn missing_env_selects_acp() {
        assert_eq!(runtime_backend_from_env_value(None), RuntimeBackend::Acp);
    }

    #[test]
    fn legacy_env_value_still_selects_acp() {
        assert_eq!(
            runtime_backend_from_env_value(Some("legacy")),
            RuntimeBackend::Acp
        );
    }

    #[test]
    fn acp_env_selects_acp() {
        assert_eq!(
            runtime_backend_from_env_value(Some("acp")),
            RuntimeBackend::Acp
        );
    }

    #[test]
    fn selection_is_always_acp() {
        let selection = RuntimeSelection::from_env();
        assert!(selection.is_acp());
        assert_eq!(selection.backend(), RuntimeBackend::Acp);
    }
}
