//! M4 typed runtime-v1 params/results for `client.rs` — `session.setMode`,
//! `providers.catalog.*`, and the `providers.import` source channels.
//!
//! Field-by-field mirror of the M4 schemas in
//! `runtime/kimi-code/apps/desktop-runtime/src/protocol-schemas.ts`; same
//! conventions as `client_types.rs` (params `Serialize` only, results
//! `Deserialize` only, unknown result fields flow through).

use serde::{Deserialize, Serialize};

use super::client_types::ProviderDescriptor;

/// `sessionModePermissionSchema` — the engine `PermissionMode` wire values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionPermissionMode {
    Manual,
    Yolo,
    Auto,
}

/// The `mode` discriminator of `sessionSetModeParamsSchema` /
/// `sessionSetModeResultSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionModeKind {
    Plan,
    Permission,
}

/// `sessionSetModeParamsSchema` — internally tagged on `mode`, mirroring the
/// zod discriminated union: the plan arm carries `enabled`, the permission
/// arm carries `permissionMode`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SessionSetModeParams {
    Plan {
        #[serde(rename = "sessionId")]
        session_id: String,
        enabled: bool,
    },
    Permission {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "permissionMode")]
        permission_mode: SessionPermissionMode,
    },
}

impl SessionSetModeParams {
    /// Envelope-level session id for `call_with_session`.
    pub fn session_id(&self) -> &str {
        match self {
            Self::Plan { session_id, .. } | Self::Permission { session_id, .. } => session_id,
        }
    }
}

/// `sessionSetModeResultSchema` — arm-specific echo: `plan_mode` is set for
/// the plan arm (engine readback), `permission_mode` for the permission arm.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetModeResult {
    pub session_id: String,
    pub mode: SessionModeKind,
    #[serde(default)]
    pub plan_mode: Option<bool>,
    #[serde(default)]
    pub permission_mode: Option<SessionPermissionMode>,
}

/// `providerCatalogSummarySchema` — one importable directory entry
/// (Desktop `ProviderCatalogSummary`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogSummary {
    pub id: String,
    pub name: String,
    pub model_count: u64,
}

/// `providersCatalogListResultSchema`.
#[derive(Debug, Clone, Deserialize)]
pub struct ProvidersCatalogListResult {
    pub providers: Vec<ProviderCatalogSummary>,
}

/// `providerCatalogModelSchema` (Desktop `ProviderCatalogModel`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogModel {
    pub id: String,
    pub name: String,
    pub max_context_tokens: u64,
}

/// `providersCatalogGetResultSchema` (Desktop `ProviderCatalogEntry`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogEntry {
    pub provider_id: String,
    pub name: String,
    pub models: Vec<ProviderCatalogModel>,
}

/// `providersImportCatalogConfigSchema` — catalog channel credentials plus
/// optional selection overrides.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersImportCatalogConfig {
    pub api_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// `providersImportRegistryConfigSchema`. An absent `api_key` falls back to
/// the runtime process env `KIMI_REGISTRY_API_KEY` runtime-side.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersImportRegistryConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

/// The `source` channels of `providersImportParamsSchema` — internally
/// tagged on `source`, mirroring the zod union arms. The M1 direct form
/// stays on `ProvidersImportParams`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum ProvidersImportSourceParams {
    Catalog {
        #[serde(rename = "entryId")]
        entry_id: String,
        config: ProvidersImportCatalogConfig,
    },
    Registry {
        #[serde(rename = "registryUrl")]
        registry_url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        config: Option<ProvidersImportRegistryConfig>,
    },
}

/// `providersImportResultSchema` — every import channel answers this shape.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersImportResult {
    pub provider_id: String,
    pub providers: Vec<ProviderDescriptor>,
    #[serde(default)]
    pub models_imported: Option<u64>,
}
