# ACP test fixtures (desensitized)

Synthetic Kimi Code ACP JSON payloads for unit tests. No real tokens, session ids, or workspace paths.

Only the payloads consumed by the `session_config` and `session_compat` module tests are retained; all other ACP fixtures were removed together with the ACP backend (M4 cutover, `docs/plans/2026-08-08-runtime-cutover-m4.md`).

| Version | Directory | Notes |
| --- | --- | --- |
| 0.30.x | `v0.30/` | `session/new` may omit `configOptions` |
| 0.31.0 | `v0.31/` | Unified `configOptions[]` on `session/new` / `session/load` |

Retained payloads (4): `v0.30/session_new`, `v0.30/session_resume`, `v0.31/session_new`, `v0.31/session_load`.

Each file holds an RPC `result` object (not the full JSON-RPC envelope).

Consumed by the `session_config` and `session_compat` module tests (the persisted session-config snapshot / replay-prompt migration helpers).
