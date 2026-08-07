import { z } from 'zod';

export const RUNTIME_PROTOCOL = 'runtime-v1' as const;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const DESKTOP_RUNTIME_VERSION = '0.0.0';
export const KIMI_SOURCE_TAG = '@moonshot-ai/kimi-code@0.33.0';
export const KIMI_SOURCE_COMMIT = '53c832dfdf9566afd59a8b3d54ebd36d3cb03d72';
export const DATA_SCHEMA_VERSION = 1;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface RuntimeRequestFrame {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: 'request';
  readonly id: string;
  readonly method: string;
  readonly sessionId?: string;
  readonly params: JsonObject;
}

export interface RuntimeErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

export type RuntimeResponseFrame =
  | {
      readonly protocol: typeof RUNTIME_PROTOCOL;
      readonly type: 'response';
      readonly id: string;
      readonly ok: true;
      readonly result: JsonValue;
    }
  | {
      readonly protocol: typeof RUNTIME_PROTOCOL;
      readonly type: 'response';
      readonly id: string;
      readonly ok: false;
      readonly error: RuntimeErrorBody;
    };

/** Session-scoped event: sessionId + per-session monotonic seq are mandatory. */
export interface RuntimeSessionEventFrame {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: 'event';
  readonly sessionId: string;
  readonly seq: number;
  readonly event: string;
  readonly payload: JsonValue;
}

/**
 * Runtime-scoped event: belongs to no session, carries no sessionId/seq, and
 * its event name always uses the `runtime.` prefix (`runtime.ready`,
 * `runtime.warning`).
 */
export interface RuntimeScopedEventFrame {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: 'event';
  readonly event: string;
  readonly payload: JsonValue;
}

export type RuntimeEventFrame = RuntimeSessionEventFrame | RuntimeScopedEventFrame;

export type RuntimeOutputFrame = RuntimeResponseFrame | RuntimeEventFrame;

// ---------------------------------------------------------------------------
// Method and event name registry (M1 contract surface + M3 parity extension)
//
// Contract: docs/plans/2026-08-06-source-runtime-migration.md §5.3/§5.4.
// Deliberate exclusions, decided in the migration contract:
// - `sessions.update` covers runtime-owned fields only (model, cwd). Title
//   and archive state are Desktop metadata owned by the Rust session store
//   and never cross runtime-v1.
// - `TurnBegin` and `ApprovalRequestResolved` are NOT runtime-v1 events; the
//   M2 Rust translate layer synthesizes them from turn.start /
//   approval.respond traffic.
// - The event bridge that translates engine events into the session events
//   below landed in wave 2 (node-sdk `v2/session-wiring.ts`
//   `SessionEventWiring` pattern: typed hubs plus the raw agent-scope events
//   stream, approvals/questions re-fed through
//   `ISessionInteractionService.onDidChangePending` + `decide`/`answer`) and
//   is wired to `session.open` by the protocol server (wave 3).
//
// M3 wave 1 (protocol-parity.ts) extended this registry with the parity
// families — `session.replay`, `auth.*`, `usage.get`, `sessions.fork` — and
// the fidelity event set. Waves 2/3 wired them for real; the registry is the
// single authority both ends (Node zod / Rust serde) and the fixture worker
// code against.
// ---------------------------------------------------------------------------

export const RUNTIME_FAMILY_METHODS = [
  'runtime.hello',
  'runtime.getInfo',
  'runtime.shutdown',
] as const;

export const SESSION_FAMILY_METHODS = [
  'sessions.list',
  'sessions.create',
  'sessions.get',
  'sessions.update',
  'sessions.delete',
  /**
   * Whole-session fork (the pinned v2 engine's native shape). The gate
   * `RuntimeCapabilities.fork` is true; a `turnIndex` param is permanently
   * answered `fork_turn_unsupported` until the engine grows turn-granular
   * fork. See protocol-parity.ts.
   */
  'sessions.fork',
  'session.open',
  'session.close',
] as const;

export const TURN_FAMILY_METHODS = [
  'turn.start',
  'turn.cancel',
  'turn.steer',
  'approval.respond',
  'question.respond',
] as const;

export const CONFIG_FAMILY_METHODS = [
  'config.get',
  'config.update',
  'models.list',
  'providers.list',
  'providers.import',
] as const;

/**
 * M3 parity families — wired for real in waves 2/3 (the snapshot gates
 * `RuntimeCapabilities.replay` / `.auth` / `.usage` report true). Method
 * schemas and the rationale for each shape live in protocol-parity.ts.
 */
export const REPLAY_FAMILY_METHODS = ['session.replay'] as const;

/** Names mirror the klient `oauthService` methods verbatim (see protocol-parity.ts). */
export const AUTH_FAMILY_METHODS = [
  'auth.startLogin',
  'auth.getFlow',
  'auth.cancelLogin',
  'auth.logout',
  'auth.status',
] as const;

export const USAGE_FAMILY_METHODS = ['usage.get'] as const;

export const RUNTIME_V1_METHODS = [
  ...RUNTIME_FAMILY_METHODS,
  ...SESSION_FAMILY_METHODS,
  ...TURN_FAMILY_METHODS,
  ...CONFIG_FAMILY_METHODS,
  ...REPLAY_FAMILY_METHODS,
  ...AUTH_FAMILY_METHODS,
  ...USAGE_FAMILY_METHODS,
] as const;

export type RuntimeV1Method = (typeof RUNTIME_V1_METHODS)[number];

/** The M3 wave-1 additions to the method registry (parity families + fork). */
export type ParityMethod =
  | (typeof REPLAY_FAMILY_METHODS)[number]
  | (typeof AUTH_FAMILY_METHODS)[number]
  | (typeof USAGE_FAMILY_METHODS)[number]
  | 'sessions.fork';

export const RUNTIME_EVENT_PREFIX = 'runtime.';

export const RUNTIME_SCOPED_EVENTS = ['runtime.ready', 'runtime.warning'] as const;

/**
 * M1 session events — the base set the event bridge (event-bridge.ts) has
 * emitted since M1. `RuntimeCapabilities.events` advertises the full
 * SESSION_EVENT_NAMES list (base + parity) now that M3 is wired.
 */
export const BASE_SESSION_EVENT_NAMES = [
  'session.status',
  'session.config',
  'content.delta',
  'thinking.delta',
  'tool.started',
  'tool.updated',
  'tool.completed',
  'plan.updated',
  'usage.updated',
  'task.updated',
  'subagent.updated',
  'approval.requested',
  'question.requested',
  'turn.completed',
  'turn.failed',
] as const;

/**
 * M3 fidelity events (payload schemas and wire mapping in
 * protocol-parity.ts). The bridge emits nine of them;
 * `background_task.observed` is synthesized by the Rust translate layer from
 * `tool.completed` (same side as the ACP era), so the Desktop still receives
 * the full advertised set.
 */
export const PARITY_SESSION_EVENT_NAMES = [
  'step.begin',
  'step.interrupted',
  'step.retry',
  'compaction.begin',
  'compaction.end',
  'mcp.loading.begin',
  'mcp.loading.end',
  'slash_commands.update',
  'background_task.observed',
  'turn.steered',
] as const;

export const SESSION_EVENT_NAMES = [
  ...BASE_SESSION_EVENT_NAMES,
  ...PARITY_SESSION_EVENT_NAMES,
] as const;

export type RuntimeScopedEventName = (typeof RUNTIME_SCOPED_EVENTS)[number];
export type BaseSessionEventName = (typeof BASE_SESSION_EVENT_NAMES)[number];
export type ParitySessionEventName = (typeof PARITY_SESSION_EVENT_NAMES)[number];
export type SessionEventName = (typeof SESSION_EVENT_NAMES)[number];

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export interface RuntimeHelloParams extends JsonObject {
  readonly desktopVersion: string;
  readonly supportedProtocols: readonly string[];
  readonly dataRoot: string;
  readonly platform: string;
  readonly arch: string;
  readonly locale: string;
}

export const runtimeHelloParamsSchema = z.object({
  desktopVersion: z.string().min(1),
  supportedProtocols: z.array(z.string()),
  dataRoot: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  locale: z.string().min(1),
});

/**
 * Capability snapshot returned by hello/getInfo. `methods` truthfully lists
 * every method registered in the router; the family gates report whether the
 * family is wired end to end — all true since M3 wave 3. `events` lists the
 * session event names the wired bridge may emit (the full
 * SESSION_EVENT_NAMES set; `background_task.observed` is synthesized
 * Rust-side) — the Desktop diffs it against `SESSION_EVENT_NAMES` for the
 * UI compatibility checklist's completeness gate.
 */
export interface RuntimeCapabilities extends JsonObject {
  readonly methods: readonly string[];
  readonly sessions: boolean;
  readonly turns: boolean;
  readonly config: boolean;
  readonly replay: boolean;
  readonly auth: boolean;
  readonly usage: boolean;
  readonly fork: boolean;
  readonly events: readonly string[];
}

/** Family gates of the capability snapshot (all true once wired). */
export interface RuntimeCapabilityFamilies {
  readonly sessions: boolean;
  readonly turns: boolean;
  readonly config: boolean;
  readonly replay: boolean;
  readonly auth: boolean;
  readonly usage: boolean;
  readonly fork: boolean;
  readonly events: readonly string[];
}

export interface RuntimeInfo extends JsonObject {
  readonly selectedProtocol: typeof RUNTIME_PROTOCOL;
  readonly runtimeVersion: string;
  readonly kimiSource: {
    readonly tag: string;
    readonly commit: string;
  };
  readonly nodeVersion: string;
  readonly capabilities: RuntimeCapabilities;
  readonly dataSchemaVersion: number;
}

export class RuntimeProtocolFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeProtocolFault';
  }
}

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'RuntimeRequestError';
  }
}

const NO_WIRED_FAMILIES: RuntimeCapabilityFamilies = {
  sessions: false,
  turns: false,
  config: false,
  replay: false,
  auth: false,
  usage: false,
  fork: false,
  events: [],
};

export function runtimeInfo(
  methods: readonly string[] = RUNTIME_V1_METHODS,
  families: RuntimeCapabilityFamilies = NO_WIRED_FAMILIES,
): RuntimeInfo {
  return {
    selectedProtocol: RUNTIME_PROTOCOL,
    runtimeVersion: DESKTOP_RUNTIME_VERSION,
    kimiSource: {
      tag: KIMI_SOURCE_TAG,
      commit: KIMI_SOURCE_COMMIT,
    },
    nodeVersion: process.versions.node,
    capabilities: {
      methods,
      sessions: families.sessions,
      turns: families.turns,
      config: families.config,
      replay: families.replay,
      auth: families.auth,
      usage: families.usage,
      fork: families.fork,
      events: families.events,
    },
    dataSchemaVersion: DATA_SCHEMA_VERSION,
  };
}

export function parseRequestFrame(value: unknown): RuntimeRequestFrame {
  if (!isJsonObject(value)) {
    throw new RuntimeProtocolFault('invalid_envelope', 'Runtime frame must be a JSON object.');
  }
  if (value['protocol'] !== RUNTIME_PROTOCOL) {
    throw new RuntimeProtocolFault(
      'protocol_mismatch',
      `Expected protocol ${RUNTIME_PROTOCOL}.`,
    );
  }
  if (value['type'] !== 'request') {
    throw new RuntimeProtocolFault('invalid_envelope_type', 'Runtime input must be a request.');
  }
  const id = requiredString(value['id'], 'id');
  const method = requiredString(value['method'], 'method');
  const sessionId = optionalString(value['sessionId'], 'sessionId');
  const params = value['params'] === undefined ? {} : value['params'];
  if (!isJsonObject(params)) {
    throw new RuntimeProtocolFault('invalid_params', 'Request params must be a JSON object.');
  }
  return {
    protocol: RUNTIME_PROTOCOL,
    type: 'request',
    id,
    method,
    sessionId,
    params,
  };
}

export function parseHelloParams(params: JsonObject): RuntimeHelloParams {
  const parsed = runtimeHelloParamsSchema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new RuntimeRequestError(
      'invalid_params',
      `runtime.hello params invalid (${where}${issue?.message ?? 'invalid'}).`,
    );
  }
  if (!parsed.data.supportedProtocols.includes(RUNTIME_PROTOCOL)) {
    throw new RuntimeRequestError(
      'protocol_mismatch',
      `Desktop does not advertise support for ${RUNTIME_PROTOCOL}.`,
    );
  }
  return parsed.data;
}

export function errorResponse(id: string, error: RuntimeRequestError): RuntimeResponseFrame {
  return {
    protocol: RUNTIME_PROTOCOL,
    type: 'response',
    id,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
  };
}

export function okResponse(id: string, result: JsonValue): RuntimeResponseFrame {
  return {
    protocol: RUNTIME_PROTOCOL,
    type: 'response',
    id,
    ok: true,
    result,
  };
}

// ---------------------------------------------------------------------------
// Shared schema primitives
//
// Field shapes follow the migration contract §5.3 and the Desktop wire
// shapes in `src/hooks/wireTypes.ts`. Structural ids (sessionId, requestId,
// toolCallId, approvalId, questionId) are camelCase; content parts keep the
// established snake_case media keys (`image_url`, …) so the M2 Rust
// translate stays a shallow field rename. These primitives are shared by the
// M1 schemas (protocol-schemas.ts) and the M3 parity schemas
// (protocol-parity.ts); the concrete method/event schemas are the contract
// draft: wave 2 handlers validate against them and tighten them against the
// engine's real types.
// ---------------------------------------------------------------------------

/**
 * Prompt content part — mirrors the `ContentPart` union in the Desktop
 * `wireTypes.ts` (snake_case media keys preserved on purpose).
 */
export const contentPartSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  think: z.string().optional(),
  image_url: z.looseObject({ url: z.string(), id: z.string().nullish() }).optional(),
  audio_url: z.looseObject({ url: z.string(), id: z.string().nullish() }).optional(),
  video_url: z.looseObject({ url: z.string(), id: z.string().nullish() }).optional(),
  mime_type: z.string().optional(),
  data: z.unknown().optional(),
});

export const promptInputSchema = z.union([z.string(), z.array(contentPartSchema)]);

/** Neutral session descriptor returned by every sessions.* read method. */
export const sessionDescriptorSchema = z.looseObject({
  sessionId: z.string(),
  workspaceId: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().nullish(),
  model: z.string().nullish(),
  archived: z.boolean().optional(),
  createdAt: z.union([z.string(), z.number()]).optional(),
  updatedAt: z.union([z.string(), z.number()]).optional(),
});

/** Wire `TokenUsage` — snake_case keys kept from the Desktop wire shape. */
export const tokenUsageSchema = z.looseObject({
  input_other: z.number(),
  output: z.number(),
  input_cache_read: z.number(),
  input_cache_creation: z.number(),
});

/** Display block envelope (`{type, ...}`); unknown types hit the UI fallback. */
export const displayBlockSchema = z.looseObject({ type: z.string() });

export const questionItemSchema = z.looseObject({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })),
  multi_select: z.boolean().optional(),
  body: z.string().optional(),
  other_label: z.string().optional(),
  other_description: z.string().optional(),
});

export interface RuntimeMethodSchema {
  readonly params: z.ZodType;
  readonly result: z.ZodType;
}

export type SessionDescriptor = z.infer<typeof sessionDescriptorSchema>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeProtocolFault('invalid_envelope', `Request ${field} must be non-empty.`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeProtocolFault('invalid_envelope', `Request ${field} must be non-empty.`);
  }
  return value;
}
