//! Source Runtime (runtime-v1) client module — M2.
//!
//! - `protocol`: typed envelopes, handshake params, and the `RuntimeInfo`
//!   readiness gate.
//! - `codec`: request encoding and the size-capped stdio JSONL frame decoder.
//! - `supervisor`: single runtime child-process lifecycle (spawn, pending
//!   table, handshake/shutdown orchestration, fail-closed faults).
//! - `pump` (crate-private): stdio pump threads, response routing, and the
//!   fail-closed path used by `supervisor`.
//! - `client`: typed calls for the M1 runtime-v1 methods over the supervisor
//!   pending table (the M3 parity families are contract-only until wave 2 —
//!   see `client_types` and `protocol-parity.ts`).
//! - `translate`: runtime-v1 events to Desktop wire messages (the UI
//!   compatibility surface; generic fallback for unknown payloads).
//! - `readiness`: artifact/manifest/handshake validation with actionable
//!   errors.
//!
//! Nothing here is wired to Tauri commands or app state yet (M4); the module
//! is consumed by tests only.

pub mod client;
pub mod codec;
pub mod protocol;
pub(crate) mod pump;
pub mod readiness;
pub mod supervisor;
pub mod translate;

pub use client::RuntimeClient;
pub use protocol::{
    EventFrame, HelloParams, OutputFrame, ProtocolFault, ResponseFrame, RuntimeInfo,
    RUNTIME_PROTOCOL,
};
pub use readiness::{check_readiness, ReadinessError, ReadinessErrorKind, ReadinessReport};
pub use supervisor::{
    HandshakeConfig, RuntimeError, RuntimeSupervisor, ShutdownConfig, SpawnConfig, SupervisorState,
};
pub use translate::{
    synthesize_approval_resolved, synthesize_turn_begin, translate_event, WireTranslator,
};
