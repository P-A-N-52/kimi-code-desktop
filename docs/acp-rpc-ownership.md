# ACP RPC ownership (G0)

Decision date: 2026-07-31. Scope: Kimi Code Desktop ACP-only runtime.

## Question

Who sends `session/set_config_option` for model / thinking / mode changes?

## Decision

**Per-session wire worker** (`AcpProcessManager` → `AcpWorker::rpc`).

Do **not** add a second RPC channel on `AcpDesktopClient`.

## Evidence

| Path | Already sends | Session-bound subprocess |
| --- | --- | --- |
| Wire worker | `session/set_mode`, `session/prompt`, `session/cancel`, `session/load`, `session/resume` | Yes — one `kimi acp` child per connected `sessionId` |
| `AcpDesktopClient` | `session/list`, `session/new`, `session/close` | Shared probe worker; not tied to live prompt stream |

Official Kimi ACP docs ([kimi acp reference](https://moonshotai.github.io/kimi-code/zh/reference/kimi-acp.html)) state:

- `session/set_config_option` — unified model / thinking / mode dispatcher
- `session/set_mode` — compatibility alias to `set_config_option({ configId: "mode" })`

Desktop plan/permission handlers already call `session/set_mode` on the wire worker (`acp.rs` `handle_set_plan_mode` / `handle_set_permission_mode`).

## Assumption (no local 0.31 CLI trace in CI)

G1 will implement `session/set_config_option` beside existing `session/set_mode` in the same `wire_send` → `AcpProcessManager::send` path. Params shape follows ACP fixtures in `src-tauri/src/test-fixtures/acp/v0.31/`.

## Non-goals

- No parallel RPC owner on `AcpDesktopClient`
- No bundling config options into `initialize` / `AgentRuntimeCapabilities`

See also module docs in `src-tauri/src/acp_capabilities.rs`.
