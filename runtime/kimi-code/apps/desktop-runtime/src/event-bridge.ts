/**
 * runtime-v1 event bridge — per-live-session translation from engine events
 * into the runtime-v1 session event stream.
 *
 * One bridge attaches per live session (wave 3 wires it to
 * `RuntimeSessionHooks.onSessionOpened`) and covers exactly the M1 surface
 * declared in protocol.ts `SESSION_EVENT_NAMES`. Following the node-sdk
 * `v2/session-wiring.ts` pattern, the typed klient hubs are NOT sufficient:
 * they cover 19 agent event types, so the bridge subscribes every live
 * agent's raw `IEventBus` stream (agents present at attach plus every later
 * `onDidCreate`, which covers subagents spawned mid-turn) and drops every
 * engine event without an M1 runtime-v1 counterpart — M3 owns the remaining
 * fidelity.
 *
 * Sources:
 * - agent `IEventBus`: content/thinking deltas, tool.call.* / tool.result,
 *   subagent.*, task.*, plan.revision, agent.status.updated, turn.ended.
 * - `ISessionInteractionService.onDidChangePending`: a newly parked approval
 *   or question becomes `approval.requested` / `question.requested`
 *   (`user_tool` interactions have no M1 slot and are dropped).
 * - `ISessionActivityView.onDidChange`: the busy/idle `session.status` flow.
 *
 * `turn.completed` / `turn.failed` are synthesized from `turn.ended` and
 * carry the Desktop requestId registered by the turn router
 * (`settleActiveTurn`); `turn.ended` for unregistered turns (subagent runs,
 * engine-internal turns) is dropped. Per-event translation is pure
 * (`translateDomainEvent` / `translateTurnEnded` / `statusUpdatedEmissions`
 * / the interaction translators) so golden tests need no engine; only
 * plan.updated leaves the pure layer, because `plan.revision` carries no
 * content and the bridge reads it back from the agent's plan service — that
 * emission is async and can be overtaken by subsequent events.
 */

import {
  IAgentLifecycleService,
  IAgentPlanService,
  IEventBus,
  ISessionActivityView,
  ISessionInteractionService,
  MAIN_AGENT_ID,
  getLiveSessionById,
  type DomainEvent,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Interaction,
  type TokenUsage,
} from '@moonshot-ai/agent-core-v2';

import type { EngineContext } from './engine';
import {
  RuntimeRequestError,
  type JsonObject,
  type JsonValue,
  type SessionEventName,
} from './protocol';
import { getActiveTurn, settleActiveTurn } from './turn-router';

/** Session-event sink handed over by the runtime server composition. */
export type EmitSessionEvent = (
  sessionId: string,
  event: string,
  payload?: JsonValue,
) => Promise<unknown>;

export interface TranslatedSessionEvent {
  readonly event: SessionEventName;
  readonly payload: JsonValue;
}

/** Parent provenance of a subagent, learned from `subagent.spawned`. */
export interface SubagentProvenance {
  readonly parentToolCallId?: string;
  readonly subagentType?: string;
}

/**
 * Context the pure translators may consult. `requestId` is set only when the
 * event's engine turn id matches the session's registered active turn;
 * `provenance` describes the event's subject agent (the publishing agent for
 * tool events, `subagentId` for subagent lifecycle events).
 */
export interface EventTranslateContext {
  readonly agentId: string;
  readonly isMainAgent: boolean;
  readonly requestId?: string;
  readonly provenance?: SubagentProvenance;
}

/**
 * Translate one agent-bus event into its runtime-v1 session event, or null
 * when the type has no M1 counterpart. Pure: no engine access, no emission.
 */
export function translateDomainEvent(
  event: DomainEvent,
  ctx: EventTranslateContext,
): TranslatedSessionEvent | null {
  switch (event.type) {
    case 'assistant.delta':
      // Subagent assistant streams have no runtime-v1 representation; the M1
      // transcript surface follows the main agent only.
      if (!ctx.isMainAgent) return null;
      return {
        event: 'content.delta',
        payload: asPayload({ text: event.delta, requestId: ctx.requestId }),
      };
    case 'thinking.delta':
      if (!ctx.isMainAgent) return null;
      return {
        event: 'thinking.delta',
        payload: asPayload({ text: event.delta, requestId: ctx.requestId }),
      };
    case 'tool.call.started':
      return {
        event: 'tool.started',
        payload: asPayload({
          toolCallId: event.toolCallId,
          name: event.name,
          arguments:
            typeof event.args === 'string'
              ? event.args
              : event.args === undefined
                ? undefined
                : JSON.stringify(event.args),
          requestId: ctx.requestId,
          parentToolCallId: ctx.isMainAgent
            ? null
            : (ctx.provenance?.parentToolCallId ?? null),
          agentId: ctx.isMainAgent ? null : ctx.agentId,
          description: event.description,
          display: event.display as JsonValue,
        }),
      };
    case 'tool.call.delta':
      return {
        event: 'tool.updated',
        payload: asPayload({ toolCallId: event.toolCallId, argumentsPart: event.argumentsPart }),
      };
    case 'tool.result':
      // The engine publishes only the model-facing output; the ToolInputDisplay
      // rides `tool.call.started`. `output` crosses as a loose extra field.
      return {
        event: 'tool.completed',
        payload: asPayload({
          toolCallId: event.toolCallId,
          isError: event.isError ?? false,
          output: event.output as JsonValue,
        }),
      };
    case 'subagent.spawned':
      return {
        event: 'subagent.updated',
        payload: asPayload({
          phase: 'spawned',
          agentId: event.subagentId,
          parentToolCallId:
            event.parentToolCallId.length === 0 ? null : event.parentToolCallId,
          subagentType: event.subagentName,
          description: event.description,
        }),
      };
    case 'subagent.started':
    case 'subagent.completed':
    case 'subagent.failed':
    case 'subagent.suspended':
      return {
        event: 'subagent.updated',
        payload: asPayload({
          phase: event.type.slice('subagent.'.length),
          agentId: event.subagentId,
          parentToolCallId: ctx.provenance?.parentToolCallId ?? null,
          subagentType: ctx.provenance?.subagentType ?? null,
          resultSummary: event.type === 'subagent.completed' ? event.resultSummary : undefined,
          error: event.type === 'subagent.failed' ? event.error : undefined,
          reason: event.type === 'subagent.suspended' ? event.reason : undefined,
        }),
      };
    case 'task.started':
    case 'task.terminated':
      return { event: 'task.updated', payload: asPayload({ ...event.info }) };
    default:
      // turn.started / turn.step.* / tool.progress / prompt.* /
      // permission.approval.* / agent.activity.updated / compaction.* /
      // shell.* / mcp.* / goal.* / skill.* / context.* / error / warning …
      // have no M1 runtime-v1 counterpart.
      return null;
  }
}

/**
 * Synthesize the terminal event for a registered turn. Cancelled and blocked
 * turns map onto `turn.failed` with a distinguishing error code — runtime-v1
 * has no `turn.cancelled` event.
 */
export function translateTurnEnded(
  event: DomainEvent<'turn.ended'>,
  requestId: string,
  usage?: TokenUsage,
): TranslatedSessionEvent {
  if (event.reason === 'completed') {
    return {
      event: 'turn.completed',
      payload: asPayload({
        requestId,
        usage: usage === undefined ? undefined : toWireTokenUsage(usage),
      }),
    };
  }
  return {
    event: 'turn.failed',
    payload: asPayload({ requestId, error: terminalErrorPayload(event) }),
  };
}

/**
 * The session-level emissions for one `agent.status.updated` slice, given
 * the per-agent accumulator AFTER this slice was folded in. Empty when the
 * slice carries no usage/config facts (e.g. a planMode-only slice).
 */
export function statusUpdatedEmissions(
  event: DomainEvent<'agent.status.updated'>,
  snapshot: AgentStatusSnapshot,
): readonly TranslatedSessionEvent[] {
  const emissions: TranslatedSessionEvent[] = [];
  if (
    event.usage !== undefined ||
    event.contextTokens !== undefined ||
    event.maxContextTokens !== undefined
  ) {
    emissions.push({
      event: 'usage.updated',
      payload: asPayload({
        contextUsage:
          snapshot.contextTokens !== undefined &&
          snapshot.maxContextTokens !== undefined &&
          snapshot.maxContextTokens > 0
            ? snapshot.contextTokens / snapshot.maxContextTokens
            : null,
        contextTokens: snapshot.contextTokens ?? null,
        maxContextTokens: snapshot.maxContextTokens ?? null,
        tokenUsage:
          snapshot.totalUsage === undefined ? null : toWireTokenUsage(snapshot.totalUsage),
      }),
    });
  }
  if (event.model !== undefined) {
    emissions.push({
      event: 'session.config',
      payload: asPayload({ model: event.model }),
    });
  }
  return emissions;
}

/** Accumulated status facts for one agent (the v2 engine emits slices). */
export interface AgentStatusSnapshot {
  contextTokens?: number;
  maxContextTokens?: number;
  model?: string;
  totalUsage?: TokenUsage;
  currentTurnUsage?: TokenUsage;
}

/** The v2 approval payload parked in the interaction kernel. */
interface ApprovalInteractionPayload {
  readonly toolName?: string;
  readonly action?: string;
  readonly toolCallId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly display?: JsonObject & { readonly kind?: unknown };
}

/** Translate a parked approval interaction into `approval.requested`. */
export function translateApprovalInteraction(interaction: Interaction): TranslatedSessionEvent {
  const payload = interaction.payload as ApprovalInteractionPayload;
  const display = payload.display;
  return {
    event: 'approval.requested',
    payload: asPayload({
      approvalId: interaction.id,
      action: payload.action ?? payload.toolName ?? 'approval',
      toolCallId: payload.toolCallId,
      // The ACP tool kind has no engine counterpart; the display blocks carry
      // the structured ToolInputDisplay under the desktop {type, data} shape.
      kind: null,
      display:
        display === undefined
          ? undefined
          : [
              {
                type: typeof display.kind === 'string' ? display.kind : 'generic',
                data: display,
              },
            ],
      toolName: payload.toolName,
      agentId: payload.agentId ?? interaction.origin.agentId ?? null,
      turnId: payload.turnId ?? interaction.origin.turnId ?? null,
    }),
  };
}

/** The v2 question payload parked in the interaction kernel. */
interface QuestionInteractionPayload {
  readonly toolCallId?: string;
  readonly questions?: readonly {
    readonly question: string;
    readonly header?: string;
    readonly body?: string;
    readonly options: readonly { readonly label: string; readonly description?: string }[];
    readonly multiSelect?: boolean;
    readonly otherLabel?: string;
    readonly otherDescription?: string;
  }[];
}

/** Translate a parked question interaction into `question.requested`. */
export function translateQuestionInteraction(interaction: Interaction): TranslatedSessionEvent {
  const payload = interaction.payload as QuestionInteractionPayload;
  return {
    event: 'question.requested',
    payload: asPayload({
      questionId: interaction.id,
      toolCallId: payload.toolCallId,
      // In-process question items are camelCase; runtime-v1 mirrors the
      // Desktop wire's snake_case item shape.
      questions: (payload.questions ?? []).map((item) => ({
        question: item.question,
        header: item.header,
        body: item.body,
        options: item.options.map((option) => ({
          label: option.label,
          description: option.description,
        })),
        multi_select: item.multiSelect,
        other_label: item.otherLabel,
        other_description: item.otherDescription,
      })),
    }),
  };
}

/**
 * Attach the bridge to a live engine session and return the detach function.
 * Throws `session_not_found` when the session is not live — attach is a
 * session.open concern, so a cold session is a structural error here.
 */
export function attachSessionEvents(
  engine: EngineContext,
  sessionId: string,
  emit: EmitSessionEvent,
): Promise<() => Promise<void>> {
  const session = getLiveSessionById(engine.app.accessor, sessionId);
  if (session === undefined) {
    return Promise.reject(
      new RuntimeRequestError(
        'session_not_found',
        `No live engine session to attach: ${sessionId}.`,
        false,
      ),
    );
  }
  const bridge = new SessionEventBridge(engine, session, emit);
  bridge.attach();
  let detached = false;
  return Promise.resolve(() => {
    if (detached) return Promise.resolve();
    detached = true;
    bridge.dispose();
    return Promise.resolve();
  });
}

class SessionEventBridge {
  private readonly disposables: IDisposable[] = [];
  private readonly agentSubscriptions = new Map<string, IDisposable>();
  /** Pending interactions already bridged (the kernel re-fires the full pending set on every change). */
  private readonly bridgedInteractionIds = new Set<string>();
  private readonly subagentProvenance = new Map<string, SubagentProvenance>();
  private readonly statusSnapshots = new Map<string, AgentStatusSnapshot>();
  private disposed = false;

  constructor(
    private readonly engine: EngineContext,
    private readonly session: ISessionScopeHandle,
    private readonly emit: EmitSessionEvent,
  ) {}

  attach(): void {
    const interactions = this.session.accessor.get(ISessionInteractionService);
    this.disposables.push(
      interactions.onDidChangePending(() => {
        this.bridgePendingInteractions();
      }),
    );
    const activity = this.session.accessor.get(ISessionActivityView);
    this.disposables.push(
      activity.onDidChange(({ state }) => {
        this.emitSafe('session.status', { state: state.busy ? 'busy' : 'idle' });
      }),
    );
    const lifecycle = this.session.accessor.get(IAgentLifecycleService);
    this.disposables.push(
      lifecycle.onDidCreate((agent) => {
        this.attachAgent(agent);
      }),
      lifecycle.onDidDispose((agentId) => {
        this.detachAgent(agentId);
      }),
    );
    for (const agent of lifecycle.list()) {
      this.attachAgent(agent);
    }
    // Initial snapshot: the Desktop learns the idle state and any pre-attach
    // pending interactions without waiting for the first transition.
    this.emitSafe('session.status', { state: activity.state().busy ? 'busy' : 'idle' });
    this.bridgePendingInteractions();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const subscription of this.agentSubscriptions.values()) {
      subscription.dispose();
    }
    this.agentSubscriptions.clear();
  }

  private attachAgent(agent: IAgentScopeHandle): void {
    if (this.disposed || this.agentSubscriptions.has(agent.id)) return;
    this.agentSubscriptions.set(
      agent.id,
      agent.accessor.get(IEventBus).subscribe((event) => {
        this.handleAgentEvent(agent, event);
      }),
    );
  }

  private detachAgent(agentId: string): void {
    const subscription = this.agentSubscriptions.get(agentId);
    if (subscription === undefined) return;
    this.agentSubscriptions.delete(agentId);
    subscription.dispose();
    this.statusSnapshots.delete(agentId);
    this.subagentProvenance.delete(agentId);
  }

  private handleAgentEvent(agent: IAgentScopeHandle, event: DomainEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'agent.status.updated':
        this.handleAgentStatus(agent, event);
        return;
      case 'plan.revision':
        this.handlePlanRevision(agent);
        return;
      case 'turn.ended':
        this.handleTurnEnded(agent, event);
        return;
      case 'subagent.spawned':
        this.subagentProvenance.set(event.subagentId, {
          parentToolCallId:
            event.parentToolCallId.length === 0 ? undefined : event.parentToolCallId,
          subagentType: event.subagentName,
        });
        break;
      default:
        break;
    }
    const translated = translateDomainEvent(event, this.contextFor(agent, event));
    if (translated !== null) {
      this.emitSafe(translated.event, translated.payload);
    }
  }

  private contextFor(agent: IAgentScopeHandle, event: DomainEvent): EventTranslateContext {
    const turnId = readNumberField(event, 'turnId');
    const active = getActiveTurn(this.engine, this.session.id);
    const subjectId = readStringField(event, 'subagentId') ?? agent.id;
    return {
      agentId: agent.id,
      isMainAgent: agent.id === MAIN_AGENT_ID,
      requestId:
        active?.turnId !== undefined && turnId !== undefined && active.turnId === turnId
          ? active.requestId
          : undefined,
      provenance: this.subagentProvenance.get(subjectId),
    };
  }

  private handleAgentStatus(
    agent: IAgentScopeHandle,
    event: DomainEvent<'agent.status.updated'>,
  ): void {
    const snapshot = this.statusSnapshots.get(agent.id) ?? {};
    if (event.usage?.total !== undefined) snapshot.totalUsage = event.usage.total;
    if (event.usage?.currentTurn !== undefined) {
      snapshot.currentTurnUsage = event.usage.currentTurn;
    }
    if (event.contextTokens !== undefined) snapshot.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) snapshot.maxContextTokens = event.maxContextTokens;
    if (event.model !== undefined) snapshot.model = event.model;
    this.statusSnapshots.set(agent.id, snapshot);
    // Session-level usage/config follow the main agent; subagent slices would
    // pollute the session snapshot.
    if (agent.id !== MAIN_AGENT_ID) return;
    for (const translated of statusUpdatedEmissions(event, snapshot)) {
      this.emitSafe(translated.event, translated.payload);
    }
  }

  private handlePlanRevision(agent: IAgentScopeHandle): void {
    void (async () => {
      try {
        const plan = await agent.accessor.get(IAgentPlanService).status();
        if (plan === null || this.disposed) return;
        this.emitSafe('plan.updated', { content: plan.content, filePath: plan.path });
      } catch {
        // The agent scope died mid-read (session close); the event is dropped.
      }
    })();
  }

  private handleTurnEnded(agent: IAgentScopeHandle, event: DomainEvent<'turn.ended'>): void {
    const settled = settleActiveTurn(this.engine, this.session.id, event.turnId);
    if (settled === undefined) return;
    const snapshot = this.statusSnapshots.get(agent.id);
    const usage = snapshot?.currentTurnUsage ?? snapshot?.totalUsage;
    const translated = translateTurnEnded(event, settled.requestId, usage);
    this.emitSafe(translated.event, translated.payload);
  }

  private bridgePendingInteractions(): void {
    if (this.disposed) return;
    const pending = this.session.accessor.get(ISessionInteractionService).listPending();
    for (const interaction of pending) {
      if (this.bridgedInteractionIds.has(interaction.id)) continue;
      this.bridgedInteractionIds.add(interaction.id);
      if (interaction.kind === 'approval') {
        const translated = translateApprovalInteraction(interaction);
        this.emitSafe(translated.event, translated.payload);
      } else if (interaction.kind === 'question') {
        const translated = translateQuestionInteraction(interaction);
        this.emitSafe(translated.event, translated.payload);
      }
      // `user_tool` interactions have no M1 runtime-v1 slot; the parked engine
      // call resolves when the session scope tears down.
    }
  }

  private emitSafe(event: SessionEventName, payload: JsonValue): void {
    if (this.disposed) return;
    void this.emit(this.session.id, event, payload).catch(() => {
      // Output teardown (closed after the shutdown drain) must not reach
      // engine event callbacks.
    });
  }
}

function toWireTokenUsage(usage: TokenUsage): JsonObject {
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function terminalErrorPayload(event: DomainEvent<'turn.ended'>): JsonObject {
  if (event.reason === 'cancelled') {
    return { code: 'cancelled', message: 'Turn cancelled.', retryable: false };
  }
  const error = event.error;
  if (error !== undefined) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: event.reason === 'blocked' ? 'turn_blocked' : 'turn_failed',
    message: event.reason === 'blocked' ? 'Turn blocked.' : 'Turn failed.',
    retryable: false,
  };
}

function readNumberField(event: DomainEvent, field: string): number | undefined {
  const value = (event as { readonly [key: string]: unknown })[field];
  return typeof value === 'number' ? value : undefined;
}

function readStringField(event: DomainEvent, field: string): string | undefined {
  const value = (event as { readonly [key: string]: unknown })[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Payloads carry optional fields as explicit `undefined` (JSON.stringify
 * drops them); the cast bridges that with the closed JsonValue type.
 */
function asPayload(value: { readonly [key: string]: unknown }): JsonValue {
  return value as JsonValue;
}
