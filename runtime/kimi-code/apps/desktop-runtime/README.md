# @moonshot-ai/desktop-runtime

Source-built Kimi runtime process for Kimi Code Desktop. Speaks `runtime-v1`
(stdio JSONL: request / response / event frames) and is consumed by the
Desktop's Rust `RuntimeSupervisor`; it owns the engine composition root
(agent-core-v2 `bootstrap()` + klient memory transport) inside this process.

- `src/protocol.ts` — runtime-v1 contract: method/event registry, schemas.
- `src/server.ts` — protocol server: handshake, router wiring, event streams.
- `src/engine.ts` / `src/kimi-runtime-adapter.ts` — engine lifecycle.
- `src/session-manager.ts` / `src/turn-router.ts` / `src/config-router.ts` —
  the three M1 method families; `src/event-bridge.ts` translates engine
  events into runtime-v1 session events.

## Commands

```sh
pnpm --filter @moonshot-ai/desktop-runtime run typecheck
pnpm --filter @moonshot-ai/desktop-runtime run test
pnpm --filter @moonshot-ai/desktop-runtime run build
pnpm --filter @moonshot-ai/desktop-runtime run smoke   # needs a build first
```

## M1 known limitations

- `plan.updated` enrichment is async (the bridge reads plan content back from
  the agent's plan service), so it can be overtaken by subsequent events.
- `tool.completed` carries no `display`/`message`: the engine `tool.result`
  event publishes only the model-facing output.
- `user_tool` interactions have no runtime-v1 slot; they are dropped and the
  parked engine call resolves when the session scope tears down.
- Subagent `assistant.delta` / `thinking.delta` streams are dropped; the M1
  transcript surface follows the main agent only.
- `turn.start` input parts are limited to `text` / `image_url` / `video_url`
  (the engine prompt contract); other part types are `invalid_params`.
- `providers.import` with `auth.method: "oauth"` carries no OAuth material
  (upstream klient facade shape as of the pinned source).
- `TurnBegin` / `ApprovalRequestResolved` are not runtime-v1 events; the M2
  Rust translate layer synthesizes them from `turn.start` /
  `approval.respond` traffic.
