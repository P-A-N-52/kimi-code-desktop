//! Typed runtime-v1 params/results for `client.rs` (M2 wave 2).
//!
//! Every shape mirrors `runtime/kimi-code/apps/desktop-runtime/src/protocol.ts`
//! zod schema one-to-one: field names, optionality, and snake_case/camelCase
//! details follow the TS contract. Params structs are `Serialize` only;
//! results are `Deserialize` only. Unknown extra fields in results flow
//! through untouched (serde ignores them by default).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ---------------------------------------------------------------------------
// Prompt input (`promptInputSchema`)
// ---------------------------------------------------------------------------

/// A URL reference for an image/audio/video content part.
#[derive(Debug, Clone, Serialize)]
pub struct MediaRef {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// One loose prompt content part (`contentPartSchema`); media keys stay
/// snake_case (`image_url`, …) so the M2 translate stays a shallow rename.
/// `part_type` is the open `type` string, so unknown part kinds flow through.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ContentPart {
    #[serde(rename = "type")]
    pub part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub think: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<MediaRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_url: Option<MediaRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_url: Option<MediaRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ContentPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            part_type: "text".into(),
            text: Some(text.into()),
            ..Self::default()
        }
    }

    pub fn think(text: impl Into<String>) -> Self {
        Self {
            part_type: "think".into(),
            think: Some(text.into()),
            ..Self::default()
        }
    }

    pub fn image(url: impl Into<String>, id: Option<String>) -> Self {
        Self {
            part_type: "image_url".into(),
            image_url: Some(MediaRef {
                url: url.into(),
                id,
            }),
            ..Self::default()
        }
    }
}

/// `promptInputSchema` — a plain string or an array of content parts.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum PromptInput {
    Text(String),
    Parts(Vec<ContentPart>),
}

// ---------------------------------------------------------------------------
// Sessions (`sessions.*`, `session.*`)
// ---------------------------------------------------------------------------

/// Neutral session descriptor (`sessionDescriptorSchema`); `title`/`model`
/// are `nullish` on the wire, `createdAt`/`updatedAt` string-or-number.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptor {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub created_at: Option<Value>,
    #[serde(default)]
    pub updated_at: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsListResult {
    pub sessions: Vec<SessionDescriptor>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsCreateParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Runtime-owned session fields only; title/archive are Desktop metadata and
/// deliberately absent from runtime-v1.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsUpdateParams {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionDeleted {
    pub deleted: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionClosed {
    pub closed: bool,
}

// ---------------------------------------------------------------------------
// Turns (`turn.*`, `approval.*`, `question.*`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    pub session_id: String,
    /// Desktop-minted turn id; echoed by turn.completed/turn.failed.
    pub request_id: String,
    pub input: PromptInput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_mode: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResult {
    pub request_id: String,
    /// Engine turn id; `z.number()` accepts integers and floats.
    pub turn_id: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCancelParams {
    pub session_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCancelResult {
    pub request_id: String,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerParams {
    pub session_id: String,
    pub request_id: String,
    pub input: PromptInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerResult {
    pub request_id: String,
    pub accepted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approved,
    Rejected,
    Cancelled,
}

/// `scope: z.literal('session')`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalScope {
    Session,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRespondParams {
    pub session_id: String,
    pub approval_id: String,
    pub decision: ApprovalDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<ApprovalScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionMethod {
    Enter,
    Space,
    NumberKey,
}

/// `question.respond` result — `null`, a flat answers record, or answers
/// plus the input method used to submit them.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum QuestionResult {
    /// Answer `null` — dismiss the question.
    Skip,
    /// Flat `question -> answer` record (string answer or literal `true`).
    Answers(Map<String, Value>),
    /// Answers plus the input method used to submit them.
    WithMethod {
        answers: Map<String, Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        method: Option<QuestionMethod>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRespondParams {
    pub session_id: String,
    pub question_id: String,
    pub result: QuestionResult,
}

// ---------------------------------------------------------------------------
// Config, models, providers (`config.*`, `models.*`, `providers.*`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigTarget {
    User,
    Memory,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUpdateParams {
    pub domain: String,
    /// Domain-defined patch; kept as raw JSON per `z.unknown()`.
    pub patch: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ConfigTarget>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelDescriptor {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelsListResult {
    pub models: Vec<ModelDescriptor>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderDescriptor {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProvidersListResult {
    pub providers: Vec<ProviderDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderImport {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProvidersImportParams {
    pub providers: Vec<ProviderImport>,
}

/// Result of methods whose contract result is an empty object (`z.object({})`).
/// The braces are intentional: serde deserializes `{}` into a braced empty
/// struct, but `null` into a unit struct.
#[allow(clippy::empty_structs_with_brackets)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct EmptyResult {}

/// `runtime.shutdown` drain response (`{shuttingDown: true}`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownResult {
    pub shutting_down: bool,
}

// ---------------------------------------------------------------------------
// M3 parity families (`session.replay`, `sessions.fork`, `auth.*`, `usage.get`)
//
// Field-by-field mirror of `protocol-parity.ts`; capability-gated off in
// wave 1. `usage.get` needs no types here: its params are the empty object
// and its result is the opaque managed-usage payload (`Value`), wrapped by
// the command adapter into the ACP-era `{kind, payload|message}` DTO.
// ---------------------------------------------------------------------------

/// `sessionReplayParamsSchema`. The replayed history arrives as session event
/// frames ahead of the response (streaming replay — see protocol-parity.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayParams {
    pub session_id: String,
    /// Replay only events after this per-session seq; absent = full history.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
}

/// `sessionReplayResultSchema`; `from_seq`/`to_seq` are 0 when `events` is 0.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayResult {
    pub session_id: String,
    pub events: u64,
    pub from_seq: u64,
    pub to_seq: u64,
    pub truncated: bool,
}

/// `sessionsForkParamsSchema`. `session_id` is the source session;
/// `turn_index` carries the Desktop's fork-at-turn request (mapping decided
/// in the implementation wave).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsForkParams {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_index: Option<u64>,
}

/// `authProviderParamsSchema` — shared by all five `auth.*` methods
/// (klient `oauthService`'s optional provider arg).
#[derive(Debug, Clone, Default, Serialize)]
pub struct AuthProviderParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// `oAuthFlowStatusSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthFlowStatus {
    Pending,
    Authenticated,
    Denied,
    Expired,
    Cancelled,
}

/// `authStartLoginResultSchema` — tagged on `status` like the zod
/// discriminated union. Numeric fields are `f64` because the TS side is
/// `z.number()` (same convention as `TurnStartResult::turn_id`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OAuthFlowStart {
    Pending {
        flow_id: String,
        provider: String,
        verification_uri: String,
        verification_uri_complete: String,
        user_code: String,
        expires_in: f64,
        interval: f64,
        expires_at: String,
    },
    Authenticated {
        flow_id: String,
        provider: String,
    },
}

/// `authGetFlowResultSchema`'s non-null arm; the wire result is
/// `Option<OAuthFlowSnapshot>` (`null` when no flow is active).
#[derive(Debug, Clone, Deserialize)]
pub struct OAuthFlowSnapshot {
    pub flow_id: String,
    pub provider: String,
    pub status: OAuthFlowStatus,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub user_code: String,
    pub expires_in: f64,
    pub expires_at: String,
    pub interval: f64,
    #[serde(default)]
    pub resolved_at: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

/// `authCancelLoginResultSchema`.
#[derive(Debug, Clone, Deserialize)]
pub struct AuthCancelLoginResult {
    pub cancelled: bool,
    pub status: OAuthFlowStatus,
}

/// `authLogoutResultSchema`; `logged_out` is `z.literal(true)` on the wire.
#[derive(Debug, Clone, Deserialize)]
pub struct AuthLogoutResult {
    pub logged_out: bool,
    pub provider: String,
}

/// `authStatusResultSchema`. Deliberate klient asymmetry kept: `loggedIn`
/// stays camelCase while the flow snapshots are snake_case.
#[derive(Debug, Clone, Deserialize)]
pub struct AuthStatusResult {
    #[serde(rename = "loggedIn")]
    pub logged_in: bool,
    #[serde(default)]
    pub provider: Option<String>,
}
