# @moonshot-ai/desktop-runtime

Source-built Kimi runtime process for Kimi Code Desktop. Speaks `runtime-v1`
(stdio JSONL: request / response / event frames) and is consumed by the
Desktop's Rust `RuntimeSupervisor`; it owns the engine composition root
(agent-core-v2 `bootstrap()` + klient memory transport) inside this process.

- `src/protocol.ts` — runtime-v1 root contract: envelopes, method/event name
  registry, capability snapshot, shared schema primitives.
- `src/protocol-schemas.ts` — M1 method/event schemas plus the merged
  `runtimeMethodSchemas` / `sessionEventPayloadSchemas` tables.
- `src/protocol-parity.ts` — M3 parity contract: `session.replay`, `auth.*`,
  `usage.get`, `sessions.fork` and the fidelity events (`step.*`,
  `compaction.*`, `mcp.loading.*`, `slash_commands.update`,
  `background_task.observed`, `turn.steered`).
- `src/server.ts` — protocol server: handshake, router wiring, event streams.
- `src/engine.ts` / `src/kimi-runtime-adapter.ts` — engine lifecycle.
- `src/session-manager.ts` / `src/turn-router.ts` / `src/config-router.ts` —
  the three M1 method families (`sessions.fork` is a separate export in
  session-manager.ts); `src/replay-router.ts` (plus `src/replay/`) and
  `src/auth-router.ts` are the M3 parity families — history replay, auth +
  managed usage; `src/event-bridge.ts` translates engine events into
  runtime-v1 session events.

## Commands

```sh
pnpm --filter @moonshot-ai/desktop-runtime run typecheck
pnpm --filter @moonshot-ai/desktop-runtime run test
pnpm --filter @moonshot-ai/desktop-runtime run build
pnpm --filter @moonshot-ai/desktop-runtime run smoke   # needs a build first
```

## M3 status (wired end to end)

All 28 runtime-v1 methods have real handlers and the capability snapshot
reports every family wired (`sessions` / `turns` / `config` / `replay` /
`auth` / `usage` / `fork` = true, `events` = the full 25-name
`SESSION_EVENT_NAMES` set):

- **replay** — `session.replay` re-emits persisted history as ordinary
  session event frames (live-identical names/payloads, per-session seq
  continuing), then answers with the burst counters; replaying a session
  with an open live turn is rejected `session_busy`. The cold-rebuild
  pipeline lives in `src/replay/` (journal read + wire migration +
  transcript fold, then snapshot→event mapping).
- **auth + usage** — `auth.startLogin` / `auth.getFlow` /
  `auth.cancelLogin` / `auth.logout` / `auth.status` pass through to the
  klient `oauthService` (wire shapes mirror it verbatim, snake_case
  included); `usage.get` returns the opaque managed-usage payload (5h/7d
  quotas) fetched via the oauth package. The Rust command adapter maps
  these onto the ACP-era frontend DTOs (mapping table in
  `protocol-parity.ts`).
- **event fidelity** — `event-bridge.ts` emits the fidelity events with the
  payload shapes pinned in `paritySessionEventPayloadSchemas`, each mapping
  to a Desktop wire event. Exception: `background_task.observed` is
  synthesized by the Rust translate layer from `tool.completed` (same side
  as the ACP era).
- **fork** — `sessions.fork` forks whole sessions via the engine lifecycle
  service; a `turnIndex` param is rejected `fork_turn_unsupported`
  (non-retryable) until an engine with turn-granular fork lands.

MCP / provider writes need no new methods: they map onto `config.update` /
`config.get` / `providers.list` / `providers.import` (replacement map §5.2).

## Known limitations

- Turn-granular fork is unsupported: `sessions.fork` with `turnIndex` is
  permanently answered `fork_turn_unsupported` until the engine grows it.
- `session.replay` cold rebuilds cannot backfill live-only fields — step
  usage/finishReason/timing, tool inputText/progress/display/description,
  and task resultSummary/error/output preview are omitted; marker/taskref/
  interaction/subagent positions are approximate; interactions left pending
  at shutdown replay as `*.requested` artifacts folded to `cancelled` (the
  full ten-item degradation list is in `replay-router.ts`).
- `plan.updated` enrichment is async (the bridge reads plan content back from
  the agent's plan service), so it can be overtaken by subsequent events.
- `tool.completed` carries no `display`/`message`: the engine `tool.result`
  event publishes only the model-facing output.
- `user_tool` interactions have no runtime-v1 slot; they are dropped and the
  parked engine call resolves when the session scope tears down.
- Subagent `assistant.delta` / `thinking.delta` streams are dropped; the
  transcript surface follows the main agent only.
- `turn.start` input parts are limited to `text` / `image_url` / `video_url`
  (the engine prompt contract); other part types are `invalid_params`.
- `providers.import` with `auth.method: "oauth"` carries no OAuth material
  (upstream klient facade shape as of the pinned source).
- `TurnBegin` / `ApprovalRequestResolved` are not runtime-v1 events; the M2
  Rust translate layer synthesizes them from `turn.start` /
  `approval.respond` traffic.
- `BackgroundTaskObserved` is synthesized Rust-side from `tool.completed`,
  so only the terminal observation exists — there is no `in_progress`
  intermediate state.
