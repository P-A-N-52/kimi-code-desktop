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
// Method and event name registry (M1 contract surface)
//
// Contract: docs/plans/2026-08-06-source-runtime-migration.md §5.3/§5.4.
// Deliberate exclusions, decided in the migration contract:
// - `sessions.fork` is NOT in the M1 method set; it may only be enabled once
//   the Kimi-source path genuinely supports it and it enters the capability
//   snapshot.
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

export const RUNTIME_V1_METHODS = [
  ...RUNTIME_FAMILY_METHODS,
  ...SESSION_FAMILY_METHODS,
  ...TURN_FAMILY_METHODS,
  ...CONFIG_FAMILY_METHODS,
] as const;

export type RuntimeV1Method = (typeof RUNTIME_V1_METHODS)[number];

export const RUNTIME_EVENT_PREFIX = 'runtime.';

export const RUNTIME_SCOPED_EVENTS = ['runtime.ready', 'runtime.warning'] as const;

export const SESSION_EVENT_NAMES = [
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

export type RuntimeScopedEventName = (typeof RUNTIME_SCOPED_EVENTS)[number];
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
 * every method registered in the router; the family gates
 * (`sessions`/`turns`/`config`) report whether the family is wired end to end
 * — the protocol server flips them to true when it registers the real family
 * handlers (M1 wave 3), and the standalone default keeps them false.
 */
export interface RuntimeCapabilities extends JsonObject {
  readonly methods: readonly string[];
  readonly sessions: boolean;
  readonly turns: boolean;
  readonly config: boolean;
}

/** Family gates of the capability snapshot; false until the family is wired. */
export interface RuntimeCapabilityFamilies {
  readonly sessions: boolean;
  readonly turns: boolean;
  readonly config: boolean;
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
// Method param/result schemas
//
// Field shapes follow the migration contract §5.3 and the Desktop wire
// shapes in `src/hooks/wireTypes.ts`. Structural ids (sessionId, requestId,
// toolCallId, approvalId, questionId) are camelCase; content parts keep the
// established snake_case media keys (`image_url`, …) so the M2 Rust
// translate stays a shallow field rename. Schemas are the contract draft:
// wave 2 handlers validate against them and tighten them against the
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

export const sessionsListParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  workspaceId: z.string().optional(),
});
export const sessionsListResultSchema = z.looseObject({
  sessions: z.array(sessionDescriptorSchema),
  nextCursor: z.string().optional(),
});

export const sessionsCreateParamsSchema = z.object({
  /**
   * Desktop-owned explicit session id. The klient facade `global.sessions.create`
   * does not accept one; the wave-2 handler must go through the
   * `workspaceLifecycleService.handlerFor` → `sessionLifecycleService.create`
   * handler chain like the SDK does (`sdk-rpc-client-v2.ts` create bypass).
   */
  sessionId: z.string().optional(),
  cwd: z.string().min(1),
  title: z.string().optional(),
  model: z.string().optional(),
});
export const sessionsCreateResultSchema = sessionDescriptorSchema;

export const sessionsGetParamsSchema = z.object({ sessionId: z.string().min(1) });
export const sessionsGetResultSchema = sessionDescriptorSchema;

/**
 * Runtime-owned session fields only. Title/archive are Desktop metadata
 * (Rust session store) and deliberately absent from runtime-v1.
 */
export const sessionsUpdateParamsSchema = z.object({
  sessionId: z.string().min(1),
  model: z.string().optional(),
  cwd: z.string().optional(),
});
export const sessionsUpdateResultSchema = sessionDescriptorSchema;

export const sessionsDeleteParamsSchema = z.object({ sessionId: z.string().min(1) });
export const sessionsDeleteResultSchema = z.object({ deleted: z.boolean() });

/** Materialize a live engine session and attach its event bridge. */
export const sessionOpenParamsSchema = z.object({ sessionId: z.string().min(1) });
export const sessionOpenResultSchema = sessionDescriptorSchema;

/** Detach the event bridge and close the live engine session. */
export const sessionCloseParamsSchema = z.object({ sessionId: z.string().min(1) });
export const sessionCloseResultSchema = z.object({ closed: z.boolean() });

export const turnStartParamsSchema = z.object({
  sessionId: z.string().min(1),
  /** Desktop-minted turn id; echoed by turn.completed/turn.failed and the response. */
  requestId: z.string().min(1),
  input: promptInputSchema,
  model: z.string().optional(),
  planMode: z.boolean().optional(),
});
/**
 * turn.start answers as soon as the engine accepts the prompt: the response
 * carries the Desktop-minted requestId plus the engine's numeric turn id. The
 * terminal state arrives later as `turn.completed` / `turn.failed` session
 * events echoing the same requestId.
 */
export const turnStartResultSchema = z.looseObject({
  requestId: z.string(),
  turnId: z.number(),
});

export const turnCancelParamsSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
});
export const turnCancelResultSchema = z.looseObject({
  requestId: z.string(),
  cancelled: z.boolean(),
});

export const turnSteerParamsSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  input: promptInputSchema,
});
export const turnSteerResultSchema = z.looseObject({
  requestId: z.string(),
  accepted: z.boolean(),
});

/** Mirrors the engine `ApprovalResponse` (klient `approvalResponseSchema`). */
export const approvalRespondParamsSchema = z.object({
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  scope: z.literal('session').optional(),
  feedback: z.string().optional(),
  selectedLabel: z.string().optional(),
});
export const approvalRespondResultSchema = z.object({});

export const questionAnswersSchema = z.record(z.string(), z.union([z.string(), z.literal(true)]));

/** Mirrors the engine `QuestionResult` (klient `questionResultSchema`). */
export const questionRespondParamsSchema = z.object({
  sessionId: z.string().min(1),
  questionId: z.string().min(1),
  result: z.union([
    z.null(),
    questionAnswersSchema,
    z.object({
      answers: questionAnswersSchema,
      method: z.enum(['enter', 'space', 'number_key']).optional(),
    }),
  ]),
});
export const questionRespondResultSchema = z.object({});

export const configTargetSchema = z.enum(['user', 'memory']);

export const configGetParamsSchema = z.object({
  /** Absent means "whole config" (klient `global.config.getAll`). */
  domain: z.string().optional(),
});
/** Domain value for a scoped get, full record for getAll — shape is domain-defined. */
export const configGetResultSchema = z.unknown();

export const configUpdateParamsSchema = z.object({
  domain: z.string().min(1),
  patch: z.unknown(),
  target: configTargetSchema.optional(),
});
export const configUpdateResultSchema = z.object({});

export const modelDescriptorSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  provider: z.string().optional(),
});
export const modelsListParamsSchema = z.object({});
export const modelsListResultSchema = z.looseObject({
  models: z.array(modelDescriptorSchema),
});

export const providerDescriptorSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
});
export const providersListParamsSchema = z.object({});
export const providersListResultSchema = z.looseObject({
  providers: z.array(providerDescriptorSchema),
});

/** Wave 2 owns the full provider-input shape (klient kosong `ProviderInput`). */
export const providersImportParamsSchema = z.object({
  providers: z.array(z.looseObject({ id: z.string() })).min(1),
});
export const providersImportResultSchema = z.object({});

const runtimeInfoResultSchema = z.looseObject({
  selectedProtocol: z.literal(RUNTIME_PROTOCOL),
  runtimeVersion: z.string(),
});

export interface RuntimeMethodSchema {
  readonly params: z.ZodType;
  readonly result: z.ZodType;
}

export const runtimeMethodSchemas = {
  'runtime.hello': { params: runtimeHelloParamsSchema, result: runtimeInfoResultSchema },
  'runtime.getInfo': { params: z.object({}), result: runtimeInfoResultSchema },
  'runtime.shutdown': {
    params: z.object({}),
    result: z.object({ shuttingDown: z.literal(true) }),
  },
  'sessions.list': { params: sessionsListParamsSchema, result: sessionsListResultSchema },
  'sessions.create': { params: sessionsCreateParamsSchema, result: sessionsCreateResultSchema },
  'sessions.get': { params: sessionsGetParamsSchema, result: sessionsGetResultSchema },
  'sessions.update': { params: sessionsUpdateParamsSchema, result: sessionsUpdateResultSchema },
  'sessions.delete': { params: sessionsDeleteParamsSchema, result: sessionsDeleteResultSchema },
  'session.open': { params: sessionOpenParamsSchema, result: sessionOpenResultSchema },
  'session.close': { params: sessionCloseParamsSchema, result: sessionCloseResultSchema },
  'turn.start': { params: turnStartParamsSchema, result: turnStartResultSchema },
  'turn.cancel': { params: turnCancelParamsSchema, result: turnCancelResultSchema },
  'turn.steer': { params: turnSteerParamsSchema, result: turnSteerResultSchema },
  'approval.respond': { params: approvalRespondParamsSchema, result: approvalRespondResultSchema },
  'question.respond': { params: questionRespondParamsSchema, result: questionRespondResultSchema },
  'config.get': { params: configGetParamsSchema, result: configGetResultSchema },
  'config.update': { params: configUpdateParamsSchema, result: configUpdateResultSchema },
  'models.list': { params: modelsListParamsSchema, result: modelsListResultSchema },
  'providers.list': { params: providersListParamsSchema, result: providersListResultSchema },
  'providers.import': { params: providersImportParamsSchema, result: providersImportResultSchema },
} satisfies Record<RuntimeV1Method, RuntimeMethodSchema>;

// ---------------------------------------------------------------------------
// Event payload schemas
//
// Payloads mirror the Desktop wire shapes in `src/hooks/wireTypes.ts`, under
// the runtime-v1 naming above. All are loose objects: unknown extra fields
// must flow through to the Desktop generic fallback untouched.
// ---------------------------------------------------------------------------

const tokenUsageSchema = z.looseObject({
  input_other: z.number(),
  output: z.number(),
  input_cache_read: z.number(),
  input_cache_creation: z.number(),
});

const displayBlockSchema = z.looseObject({ type: z.string() });

export const questionItemSchema = z.looseObject({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })),
  multi_select: z.boolean().optional(),
  body: z.string().optional(),
  other_label: z.string().optional(),
  other_description: z.string().optional(),
});

export const runtimeEventPayloadSchemas = {
  'runtime.ready': z.looseObject({ runtimeVersion: z.string().optional() }),
  'runtime.warning': z.looseObject({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
} satisfies Record<RuntimeScopedEventName, z.ZodType>;

export const sessionEventPayloadSchemas = {
  'session.status': z.looseObject({
    state: z.enum(['stopped', 'idle', 'busy', 'restarting', 'error']),
    reason: z.string().nullish(),
    detail: z.string().nullish(),
    requestId: z.string().nullish(),
  }),
  'session.config': z.looseObject({
    model: z.string().nullish(),
  }),
  'content.delta': z.looseObject({
    text: z.string(),
    requestId: z.string().optional(),
    messageId: z.string().optional(),
  }),
  'thinking.delta': z.looseObject({
    text: z.string(),
    requestId: z.string().optional(),
    messageId: z.string().optional(),
  }),
  'tool.started': z.looseObject({
    toolCallId: z.string(),
    name: z.string(),
    arguments: z.string().optional(),
    requestId: z.string().optional(),
    parentToolCallId: z.string().nullish(),
    agentId: z.string().nullish(),
  }),
  'tool.updated': z.looseObject({
    toolCallId: z.string(),
    argumentsPart: z.string().optional(),
  }),
  'tool.completed': z.looseObject({
    toolCallId: z.string(),
    isError: z.boolean(),
    message: z.string().optional(),
    display: z.array(displayBlockSchema).optional(),
  }),
  'plan.updated': z.looseObject({
    content: z.string(),
    filePath: z.string().optional(),
  }),
  'usage.updated': z.looseObject({
    contextUsage: z.number().nullish(),
    contextTokens: z.number().nullish(),
    maxContextTokens: z.number().nullish(),
    tokenUsage: tokenUsageSchema.nullish(),
  }),
  'task.updated': z.looseObject({
    taskId: z.string(),
    status: z.string(),
  }),
  'subagent.updated': z.looseObject({
    phase: z.string(),
    agentId: z.string().optional(),
    parentToolCallId: z.string().nullish(),
    subagentType: z.string().nullish(),
  }),
  'approval.requested': z.looseObject({
    approvalId: z.string(),
    action: z.string(),
    description: z.string().optional(),
    toolCallId: z.string().optional(),
    kind: z.string().nullish(),
    display: z.array(displayBlockSchema).optional(),
  }),
  'question.requested': z.looseObject({
    questionId: z.string(),
    toolCallId: z.string().optional(),
    questions: z.array(questionItemSchema),
  }),
  'turn.completed': z.looseObject({
    requestId: z.string(),
    usage: z.unknown().optional(),
  }),
  'turn.failed': z.looseObject({
    requestId: z.string(),
    error: z.looseObject({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional(),
    }),
  }),
} satisfies Record<SessionEventName, z.ZodType>;

// ---------------------------------------------------------------------------
// Derived TypeScript types for wave-2 handlers
// ---------------------------------------------------------------------------

export type SessionDescriptor = z.infer<typeof sessionDescriptorSchema>;
export type SessionsCreateParams = z.infer<typeof sessionsCreateParamsSchema>;
export type SessionsUpdateParams = z.infer<typeof sessionsUpdateParamsSchema>;
export type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
export type ApprovalRespondParams = z.infer<typeof approvalRespondParamsSchema>;
export type QuestionRespondParams = z.infer<typeof questionRespondParamsSchema>;
export type ConfigUpdateParams = z.infer<typeof configUpdateParamsSchema>;

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
