/**
 * runtime-v1 M3 parity extension — contract groundwork for the behavior-
 * alignment milestone (M3 wave 1). This module owns the zod schemas for the
 * new method families (`session.replay`, `auth.*`, `usage.get`,
 * `sessions.fork`) and the fidelity event set (`step.*`, `compaction.*`,
 * `mcp.loading.*`, `slash_commands.update`, `background_task.observed`,
 * `turn.steered`). The name constants live with the rest of the registry in
 * protocol.ts; the merged schema tables live in protocol-schemas.ts.
 *
 * The families here were capability-gated off in wave 1 and wired for real
 * in waves 2/3 (`replay-router.ts`, `auth-router.ts`,
 * `createForkSessionHandler` in session-manager.ts); the capability snapshot
 * reports `replay` / `.auth` / `.usage` / `.fork` = true and the full
 * `SESSION_EVENT_NAMES` list. MCP / provider writes deliberately get NO new
 * methods: the ACP-era `update_config_toml` / `update_global_config` /
 * `update_mcp_config` commands map onto `config.update` (domain-scoped
 * patch, snapshot refresh via `config.get`), and the provider catalog/import
 * commands map onto `providers.list` / `providers.import` (source-backend
 * replacement map §5.2).
 */

import { z } from 'zod';

import {
  promptInputSchema,
  sessionDescriptorSchema,
  type ParityMethod,
  type ParitySessionEventName,
  type RuntimeMethodSchema,
} from './protocol';

// ---------------------------------------------------------------------------
// session.replay — history replay as a STREAM, not a one-shot array
//
// Request accepted -> the runtime re-emits the session's persisted history
// as ordinary session event frames (same event names and payload shapes as
// the live stream, per-session seq continuing monotonically) -> the response
// closes the burst with counters. Chosen over "one response carrying a
// record array" (the ACP-era `replay_session_history` shape) because:
// 1. MAX_FRAME_BYTES (16 MiB) bounds a single frame; long histories with
//    tool outputs exceed it, while each replayed event frame stays small.
// 2. The Rust side runs replayed frames through the same `WireTranslator`
//    as live traffic, so UI checklist §2 (live/replay wire equivalence)
//    holds by construction instead of via a second translation path.
// 3. The supervisor keeps one ordering rule (per-session monotonic seq) for
//    live and replayed frames alike.
//
// Ordering rule: a replay burst is never interleaved with live events of
// the same session; replaying a session with an open live turn is rejected
// (`session_busy`, enforced by the wave-2 handler). `fromSeq` resumes after
// a known point (incremental re-replay); `limit` bounds the burst and sets
// `truncated` when more history remains.
// ---------------------------------------------------------------------------

export const sessionReplayParamsSchema = z.object({
  sessionId: z.string().min(1),
  /** Replay only events after this per-session seq; absent = full history. */
  fromSeq: z.number().int().min(1).optional(),
  /** Bound the burst; the result's `truncated` reports remaining history. */
  limit: z.number().int().min(1).optional(),
});

export const sessionReplayResultSchema = z.looseObject({
  sessionId: z.string(),
  /** Number of event frames emitted for this replay burst. */
  events: z.number().int().min(0),
  /** First emitted seq; 0 when `events` is 0. */
  fromSeq: z.number().int().min(0),
  /** Last emitted seq; 0 when `events` is 0. */
  toSeq: z.number().int().min(0),
  truncated: z.boolean(),
});

// ---------------------------------------------------------------------------
// auth.* — mirrors the klient `oauthService` contract verbatim
// (packages/klient/src/contract/global/auth.ts): same method names, same
// snake_case flow fields. Deliberate asymmetry kept from klient: the flow
// snapshots are snake_case while `auth.status` keeps `loggedIn` camelCase.
// The Rust adapter (wave 2/3) maps these onto the ACP-era frontend DTOs:
//   flow_id->loginId, user_code->userCode, verification_uri->verificationUri,
//   verification_uri_complete->verificationUriComplete, expires_in->expiresIn
//   poll kinds: authenticated->{kind:"success"}, pending->{kind:"pending"},
//   denied->{kind:"error",message}, expired->{kind:"expired"},
//   cancelled->{kind:"cancelled"}
//   auth.status.loggedIn -> kimi_credentials_status {present}
//   auth.logout.logged_out -> logout_kimi {success}
// ---------------------------------------------------------------------------

/** Shared params for all five auth methods (klient's optional provider arg). */
export const authProviderParamsSchema = z.object({
  provider: z.string().min(1).optional(),
});

export const oAuthFlowStatusSchema = z.enum([
  'pending',
  'authenticated',
  'denied',
  'expired',
  'cancelled',
]);

export const authStartLoginResultSchema = z.discriminatedUnion('status', [
  z.looseObject({
    flow_id: z.string(),
    provider: z.string(),
    status: z.literal('pending'),
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    user_code: z.string(),
    expires_in: z.number(),
    interval: z.number(),
    expires_at: z.string(),
  }),
  z.looseObject({
    flow_id: z.string(),
    provider: z.string(),
    status: z.literal('authenticated'),
  }),
]);

/** `null` when no flow is active (klient `maybe(oAuthFlowSnapshotSchema)`). */
export const authGetFlowResultSchema = z
  .looseObject({
    flow_id: z.string(),
    provider: z.string(),
    status: oAuthFlowStatusSchema,
    verification_uri: z.string(),
    verification_uri_complete: z.string(),
    user_code: z.string(),
    expires_in: z.number(),
    expires_at: z.string(),
    interval: z.number(),
    resolved_at: z.string().optional(),
    error_message: z.string().optional(),
  })
  .nullable();

export const authCancelLoginResultSchema = z.looseObject({
  cancelled: z.boolean(),
  status: oAuthFlowStatusSchema,
});

export const authLogoutResultSchema = z.looseObject({
  logged_out: z.literal(true),
  provider: z.string(),
});

export const authStatusResultSchema = z.looseObject({
  loggedIn: z.boolean(),
  provider: z.string().optional(),
});

// ---------------------------------------------------------------------------
// usage.get — managed platform quotas (5h / 7d)
//
// The result is the opaque managed-usage payload (the `/usages` body the
// runtime's oauth package fetches); the Desktop frontend parses it loosely
// (`src/lib/managed-usage.ts` accepts several key variants), so the contract
// pins "a JSON object" and nothing more. The Rust adapter wraps it into the
// ACP-era DTO: ok -> `{kind:"ok", payload}`, error-response -> `{kind:
// "error", message}`. Distinct from the per-turn `usage.updated` session
// event (context token usage), which is unchanged.
// ---------------------------------------------------------------------------

export const usageGetParamsSchema = z.object({});
export const usageGetResultSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// sessions.fork — capability-gated (`RuntimeCapabilities.fork`, false in
// wave 1). The v2 engine forks natively via `sessionLifecycleService.fork`
// ({sourceSessionId, newSessionId?, title?, metadata?}); `sessionId` here is
// the source. `turnIndex` carries the Desktop's fork-at-turn request
// (fork_session command contract): the pinned engine forks whole sessions,
// so wave 2 decides the turnIndex mapping (truncate-at-turn or an explicit
// unsupported error) — the gate must stay false until then.
// ---------------------------------------------------------------------------

export const sessionsForkParamsSchema = z.object({
  sessionId: z.string().min(1),
  newSessionId: z.string().min(1).optional(),
  title: z.string().optional(),
  turnIndex: z.number().int().min(0).optional(),
});
export const sessionsForkResultSchema = sessionDescriptorSchema;

/** Method schemas of the M3 parity families; merged into `runtimeMethodSchemas`. */
export const parityMethodSchemas = {
  'session.replay': { params: sessionReplayParamsSchema, result: sessionReplayResultSchema },
  'auth.startLogin': { params: authProviderParamsSchema, result: authStartLoginResultSchema },
  'auth.getFlow': { params: authProviderParamsSchema, result: authGetFlowResultSchema },
  'auth.cancelLogin': { params: authProviderParamsSchema, result: authCancelLoginResultSchema },
  'auth.logout': { params: authProviderParamsSchema, result: authLogoutResultSchema },
  'auth.status': { params: authProviderParamsSchema, result: authStatusResultSchema },
  'usage.get': { params: usageGetParamsSchema, result: usageGetResultSchema },
  'sessions.fork': { params: sessionsForkParamsSchema, result: sessionsForkResultSchema },
} satisfies Record<ParityMethod, RuntimeMethodSchema>;

// ---------------------------------------------------------------------------
// Fidelity event payloads (PARITY_SESSION_EVENT_NAMES)
//
// Each payload mirrors the Desktop wire shape it translates into
// (`src/hooks/wireTypes.ts`, with `acp_translate.rs` as the behavioral
// baseline). Domain fields keep the wire's snake_case; structural ids stay
// camelCase per the runtime-v1 convention. All loose objects: unknown extra
// fields must flow through to the Desktop generic fallback untouched. The
// Rust translate maps them in the event-fidelity wave; until then they fall
// back to the generic notice like any unknown event.
// ---------------------------------------------------------------------------

export const paritySessionEventPayloadSchemas = {
  /** -> wire `StepBegin` `{n}`. */
  'step.begin': z.looseObject({
    n: z.number().int().min(1),
    requestId: z.string().optional(),
  }),
  /** -> wire `StepInterrupted` (empty payload). */
  'step.interrupted': z.looseObject({
    requestId: z.string().optional(),
  }),
  /** -> wire `StepRetry` (snake_case fields kept from the wire shape). */
  'step.retry': z.looseObject({
    n: z.number().int().min(1),
    next_attempt: z.number().int(),
    max_attempts: z.number().int(),
    wait_s: z.number(),
    error_type: z.string(),
    status_code: z.number().nullish(),
    requestId: z.string().optional(),
  }),
  /** -> wire `CompactionBegin` (empty payload; engine may add `source`). */
  'compaction.begin': z.looseObject({}),
  /** -> wire `CompactionEnd` (empty payload). */
  'compaction.end': z.looseObject({}),
  /** -> wire `MCPLoadingBegin` (empty payload). */
  'mcp.loading.begin': z.looseObject({}),
  /** -> wire `MCPLoadingEnd` (empty payload). */
  'mcp.loading.end': z.looseObject({}),
  /**
   * -> wire `SlashCommandsUpdate`. Item shape mirrors the wire
   * (`input_hint` and `inputHint` both tolerated by the frontend).
   */
  'slash_commands.update': z.looseObject({
    slash_commands: z.array(
      z.looseObject({
        name: z.string(),
        description: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        input_hint: z.string().nullish(),
        inputHint: z.string().nullish(),
        source: z.string().nullish(),
      }),
    ),
  }),
  /**
   * -> wire `BackgroundTaskObserved` (snake_case fields kept from the wire
   * shape). `session_id` comes from the event envelope, not the payload. In
   * the ACP era the Rust translate also synthesizes these from tool results
   * (the `extras.tool_title` heuristic); the event-fidelity wave decides
   * which side emits.
   */
  'background_task.observed': z.looseObject({
    tool_call_id: z.string(),
    tool_name: z.string(),
    snapshot: z.string(),
    terminal_state: z.enum(['running', 'completed', 'failed', 'stopped', 'unknown']),
    task_id: z.string().nullish(),
    output_path: z.string().nullish(),
    cron_id: z.string().nullish(),
    cron_expression: z.string().nullish(),
    human_schedule: z.string().nullish(),
    next_fire_at: z.union([z.string(), z.number()]).nullish(),
    recurring: z.boolean().nullish(),
  }),
  /**
   * Steer echo -> wire `SteerInput` `{user_input}`. Emitted when the engine
   * accepts a `turn.steer`, so the UI renders the steered input in the
   * transcript exactly like the replay path (`session_store.rs`
   * synthesizes the same wire event from persisted steer records).
   */
  'turn.steered': z.looseObject({
    requestId: z.string(),
    input: promptInputSchema,
  }),
} satisfies Record<ParitySessionEventName, z.ZodType>;

// ---------------------------------------------------------------------------
// Derived TypeScript types for the wave-2 handlers
// ---------------------------------------------------------------------------

export type SessionReplayParams = z.infer<typeof sessionReplayParamsSchema>;
export type SessionReplayResult = z.infer<typeof sessionReplayResultSchema>;
export type AuthProviderParams = z.infer<typeof authProviderParamsSchema>;
export type OAuthFlowStatus = z.infer<typeof oAuthFlowStatusSchema>;
export type AuthStartLoginResult = z.infer<typeof authStartLoginResultSchema>;
export type AuthGetFlowResult = z.infer<typeof authGetFlowResultSchema>;
export type AuthCancelLoginResult = z.infer<typeof authCancelLoginResultSchema>;
export type AuthLogoutResult = z.infer<typeof authLogoutResultSchema>;
export type AuthStatusResult = z.infer<typeof authStatusResultSchema>;
export type SessionsForkParams = z.infer<typeof sessionsForkParamsSchema>;
