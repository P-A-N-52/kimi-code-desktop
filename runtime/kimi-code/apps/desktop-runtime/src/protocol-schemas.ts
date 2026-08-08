/**
 * runtime-v1 method/event schema registry — the M1 surface plus the merged
 * tables every consumer validates against. Root contract (envelopes, name
 * registry, capabilities, shared primitives): ./protocol.ts. M3 parity
 * additions (session.replay / auth.* / usage.get / sessions.fork and the
 * fidelity events): ./protocol-parity.ts.
 *
 * Schemas are the contract draft: wave 2 handlers validate against them and
 * tighten them against the engine's real types. All event payloads are loose
 * objects: unknown extra fields must flow through to the Desktop generic
 * fallback untouched.
 */

import { z } from 'zod';

import {
  contentPartSchema,
  displayBlockSchema,
  promptInputSchema,
  questionItemSchema,
  sessionDescriptorSchema,
  tokenUsageSchema,
  RUNTIME_PROTOCOL,
  runtimeHelloParamsSchema,
  type BaseSessionEventName,
  type RuntimeMethodSchema,
  type RuntimeScopedEventName,
  type RuntimeV1Method,
  type SessionEventName,
} from './protocol';
import {
  parityMethodSchemas,
  paritySessionEventPayloadSchemas,
} from './protocol-parity';

// ---------------------------------------------------------------------------
// Method param/result schemas (M1 families)
// ---------------------------------------------------------------------------

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

/**
 * M4 `session.setMode` — one method replacing the ACP-era wire commands
 * `set_plan_mode {enabled}` and `set_permission_mode {mode}`, discriminated
 * on `mode`. The plan arm is idle-gated (a live turn answers `session_busy`,
 * matching the ACP-era `ensure_mode_change_idle`); the permission arm
 * hot-switches mid-turn (existing Desktop behavior — it must not regress to
 * next-turn application). `permissionMode` mirrors the klient
 * `permissionModeSchema` (agent/rpc.ts).
 */
export const sessionModePermissionSchema = z.enum(['manual', 'yolo', 'auto']);

export const sessionSetModeParamsSchema = z.discriminatedUnion('mode', [
  z.object({
    sessionId: z.string().min(1),
    mode: z.literal('plan'),
    enabled: z.boolean(),
  }),
  z.object({
    sessionId: z.string().min(1),
    mode: z.literal('permission'),
    permissionMode: sessionModePermissionSchema,
  }),
]);

/**
 * Arm-specific echo: the plan arm reports the engine readback (`planMode`,
 * from `agentPlanService.status`), the permission arm the applied
 * `permissionMode`. The Desktop merges the result into the same StatusUpdate
 * fields the ACP-era mode response carried; engine-initiated mode changes do
 * not cross runtime-v1 as events, so this result is the only echo channel.
 */
export const sessionSetModeResultSchema = z.looseObject({
  sessionId: z.string(),
  mode: z.enum(['plan', 'permission']),
  planMode: z.boolean().optional(),
  permissionMode: sessionModePermissionSchema.optional(),
});

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

// ---------------------------------------------------------------------------
// M4 provider directory + import channels
//
// `providers.catalog.list` / `providers.catalog.get` expose the importable
// models.dev directory (engine `IModelsDevImportService`) behind the Desktop
// Settings provider picker; `providers.import` gains the catalog/registry
// `source` channels next to the M1 direct form. Wire DTOs mirror the Desktop
// `ProviderCatalogSummary` / `ProviderCatalogEntry` shapes
// (`src/lib/tauri-api.ts`), so the M4 command rewiring is a field-for-field
// pass-through.
// ---------------------------------------------------------------------------

/** Desktop `ProviderCatalogSummary` (`{id, name, modelCount}`). */
export const providerCatalogSummarySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  modelCount: z.number().int().min(0),
});
export const providersCatalogListParamsSchema = z.object({});
export const providersCatalogListResultSchema = z.looseObject({
  providers: z.array(providerCatalogSummarySchema),
});

/** Desktop `ProviderCatalogModel` (`{id, name, maxContextTokens}`). */
export const providerCatalogModelSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  maxContextTokens: z.number().int().min(0),
});
export const providersCatalogGetParamsSchema = z.object({
  /** models.dev directory entry id (the engine contract's `catalogId`). */
  entryId: z.string().min(1),
});
/** Desktop `ProviderCatalogEntry` (`{providerId, name, models}`). */
export const providersCatalogGetResultSchema = z.looseObject({
  providerId: z.string(),
  name: z.string(),
  models: z.array(providerCatalogModelSchema),
});

/**
 * Catalog channel config (ACP-era `import_provider_from_catalog` fields).
 * `defaultModel` picks the global default among the imported aliases after
 * the import, like the CLI's `provider catalog add --default-model`.
 */
export const providersImportCatalogConfigSchema = z.object({
  apiKey: z.string().min(1),
  defaultModel: z.string().min(1).optional(),
  baseUrl: z.string().min(1).max(2048).optional(),
});

/**
 * Registry channel config. `apiKey` is the api.json bearer key; when absent
 * the handler falls back to the runtime process env KIMI_REGISTRY_API_KEY
 * (the Rust host passes it through at spawn), then to the stored key of a
 * previous import from the same URL (engine behavior). It never enters argv,
 * logs, or protocol events.
 */
export const providersImportRegistryConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
});

/**
 * providers.import — three channels. The M1 direct form `{providers: [...]}`
 * is unchanged (entries are tightened to the klient `ProviderInput` contract
 * by the handler). `{source: 'catalog', entryId, config}` imports a
 * models.dev directory entry through the engine's `importModelsDevProvider`
 * (provider + model aliases). `{source: 'registry', registryUrl, config?}`
 * imports a custom api.json registry through the engine's
 * `importCustomRegistry` (the CLI `kimi provider add <url>` flow).
 */
export const providersImportParamsSchema = z.union([
  z.object({
    providers: z.array(z.looseObject({ id: z.string() })).min(1),
  }),
  z.object({
    source: z.literal('catalog'),
    entryId: z.string().min(1),
    config: providersImportCatalogConfigSchema,
  }),
  z.object({
    source: z.literal('registry'),
    registryUrl: z.string().min(1).max(2048),
    config: providersImportRegistryConfigSchema.optional(),
  }),
]);
/**
 * All channels answer the same shape: the first imported provider id plus
 * the refreshed configured-provider list (`providerDescriptorSchema`-loose
 * engine catalog items). `modelsImported` is present for the catalog and
 * registry channels.
 */
export const providersImportResultSchema = z.looseObject({
  providerId: z.string(),
  providers: z.array(providerDescriptorSchema),
  modelsImported: z.number().int().min(0).optional(),
});

const runtimeInfoResultSchema = z.looseObject({
  selectedProtocol: z.literal(RUNTIME_PROTOCOL),
  runtimeVersion: z.string(),
});

/**
 * Merged method schema table — M1 families plus the M3 parity families
 * (protocol-parity.ts). Keys must cover the full `RUNTIME_V1_METHODS`
 * registry.
 */
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
  'session.setMode': { params: sessionSetModeParamsSchema, result: sessionSetModeResultSchema },
  'turn.start': { params: turnStartParamsSchema, result: turnStartResultSchema },
  'turn.cancel': { params: turnCancelParamsSchema, result: turnCancelResultSchema },
  'turn.steer': { params: turnSteerParamsSchema, result: turnSteerResultSchema },
  'approval.respond': { params: approvalRespondParamsSchema, result: approvalRespondResultSchema },
  'question.respond': { params: questionRespondParamsSchema, result: questionRespondResultSchema },
  'config.get': { params: configGetParamsSchema, result: configGetResultSchema },
  'config.update': { params: configUpdateParamsSchema, result: configUpdateResultSchema },
  'models.list': { params: modelsListParamsSchema, result: modelsListResultSchema },
  'providers.list': { params: providersListParamsSchema, result: providersListResultSchema },
  'providers.catalog.list': {
    params: providersCatalogListParamsSchema,
    result: providersCatalogListResultSchema,
  },
  'providers.catalog.get': {
    params: providersCatalogGetParamsSchema,
    result: providersCatalogGetResultSchema,
  },
  'providers.import': { params: providersImportParamsSchema, result: providersImportResultSchema },
  ...parityMethodSchemas,
} satisfies Record<RuntimeV1Method, RuntimeMethodSchema>;

// ---------------------------------------------------------------------------
// Event payload schemas (M1 session events + runtime-scoped events)
//
// Payloads mirror the Desktop wire shapes in `src/hooks/wireTypes.ts`, under
// the runtime-v1 naming in protocol.ts.
// ---------------------------------------------------------------------------

/**
 * One `ConfigOptionUpdate` option record (wireTypes.ts), mirrored so
 * `session.config` can carry the full option set, not just the model.
 */
export const sessionConfigOptionSchema = z.looseObject({
  id: z.string(),
  optionType: z.string().optional(),
  type: z.string().optional(),
  label: z.string().nullish(),
  currentValue: z.unknown(),
  options: z.array(z.looseObject({ value: z.unknown(), label: z.string().nullish() })).nullish(),
});

export const runtimeEventPayloadSchemas = {
  'runtime.ready': z.looseObject({ runtimeVersion: z.string().optional() }),
  'runtime.warning': z.looseObject({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
} satisfies Record<RuntimeScopedEventName, z.ZodType>;

const baseSessionEventPayloadSchemas = {
  'session.status': z.looseObject({
    state: z.enum(['stopped', 'idle', 'busy', 'restarting', 'error']),
    reason: z.string().nullish(),
    detail: z.string().nullish(),
    requestId: z.string().nullish(),
  }),
  /**
   * `model` is the M1 minimal form; `options` (added in M3 wave 1) carries
   * the full ConfigOptionUpdate option set so the Rust translate no longer
   * synthesizes a single model-only record.
   */
  'session.config': z.looseObject({
    model: z.string().nullish(),
    options: z.array(sessionConfigOptionSchema).optional(),
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
} satisfies Record<BaseSessionEventName, z.ZodType>;

/**
 * Merged session event payload table — M1 base events plus the M3 fidelity
 * events (protocol-parity.ts). Keys must cover `SESSION_EVENT_NAMES`.
 */
export const sessionEventPayloadSchemas = {
  ...baseSessionEventPayloadSchemas,
  ...paritySessionEventPayloadSchemas,
} satisfies Record<SessionEventName, z.ZodType>;

// Re-exported so consumers can import every schema from this one registry
// module (the primitive definitions live in protocol.ts).
export { contentPartSchema, promptInputSchema, sessionDescriptorSchema };
export type { SessionDescriptor } from './protocol';

// ---------------------------------------------------------------------------
// Derived TypeScript types for wave-2 handlers
// ---------------------------------------------------------------------------

export type SessionsCreateParams = z.infer<typeof sessionsCreateParamsSchema>;
export type SessionsUpdateParams = z.infer<typeof sessionsUpdateParamsSchema>;
export type SessionSetModeParams = z.infer<typeof sessionSetModeParamsSchema>;
export type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
export type ApprovalRespondParams = z.infer<typeof approvalRespondParamsSchema>;
export type QuestionRespondParams = z.infer<typeof questionRespondParamsSchema>;
export type ConfigUpdateParams = z.infer<typeof configUpdateParamsSchema>;
export type ProvidersImportParams = z.infer<typeof providersImportParamsSchema>;
