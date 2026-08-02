# ACP test fixtures (desensitized)

Synthetic Kimi Code ACP JSON payloads for unit tests. No real tokens, session ids, or workspace paths.

| Version | Directory | Notes |
| --- | --- | --- |
| 0.30.x | `v0.30/` | `session/new` may omit `configOptions`; mode changes use `session/set_mode` |
| 0.31.0 | `v0.31/` | Unified `configOptions[]` on `session/new` / `session/load`; `config_option_update` notifications |

Each file holds either an RPC `result` object or a `session/update` `update` payload (not the full JSON-RPC envelope).

Fixtures are consumed by `acp_capabilities` and `acp_translate` tests.
