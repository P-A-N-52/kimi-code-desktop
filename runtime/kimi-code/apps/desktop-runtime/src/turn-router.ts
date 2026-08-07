/**
 * runtime-v1 turn family — method handlers over the klient session/agent
 * facade, plus the active-turn correlation registry the event bridge uses to
 * bind engine turn ids back to Desktop request ids.
 *
 * Covers TURN_FAMILY_METHODS: `turn.start` / `turn.steer` / `turn.cancel`
 * drive the session's main agent through `agentRPCService` (facade
 * `session(id).agent('main').prompt/steer/cancel`), while `approval.respond`
 * / `question.respond` resolve parked interactions through
 * `sessionApprovalService.decide` / `sessionQuestionService.answer`
 * (`dismiss` when the result is null). `turn.start` answers as soon as the
 * engine accepts the prompt — the terminal state arrives later as a
 * `turn.completed` / `turn.failed` session event carrying the same
 * requestId. The engine's own prompt service queues a second prompt instead
 * of rejecting it, so the one-active-turn-per-session invariant is enforced
 * here against the registry with a structured `session_busy` error.
 *
 * The registry binds a Desktop-minted requestId to the engine's numeric turn
 * id for as long as the turn is live: the router registers on acceptance,
 * and the event bridge settles (removes) the entry when it synthesizes the
 * terminal event — a cancel-induced `turn.ended` settles through the same
 * path, so the entry must survive `turn.cancel`. Entries are keyed per
 * EngineContext, so engines never cross-talk.
 */

import { MAIN_AGENT_ID, type ContentPart } from '@moonshot-ai/agent-core-v2';
import { KlientValidationError, RPCError } from '@moonshot-ai/klient';
import { z } from 'zod';

import type { EngineContext } from './engine';
import {
  requireEngineContext,
  type RuntimeHandlerContext,
  type RuntimeHandlerEntry,
} from './handler-context';
import {
  RuntimeRequestError,
  type JsonValue,
  type RuntimeRequestFrame,
} from './protocol';
import {
  turnCancelParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  approvalRespondParamsSchema,
  questionRespondParamsSchema,
  type TurnStartParams,
} from './protocol-schemas';

/** A live turn started through `turn.start`, awaiting its terminal event. */
export interface ActiveTurnRegistration {
  readonly requestId: string;
  /** Engine numeric turn id; bound once `agentRPCService.prompt` launches. */
  turnId?: number;
}

const activeTurns = new WeakMap<EngineContext, Map<string, ActiveTurnRegistration>>();

function sessionTurns(engine: EngineContext): Map<string, ActiveTurnRegistration> {
  let turns = activeTurns.get(engine);
  if (turns === undefined) {
    turns = new Map();
    activeTurns.set(engine, turns);
  }
  return turns;
}

/**
 * Reserve the session's single active-turn slot for a requestId. Synchronous
 * on purpose: the busy check and the reservation stay inside one tick, so
 * concurrently dispatched `turn.start` requests cannot both pass.
 */
export function registerActiveTurn(
  engine: EngineContext,
  sessionId: string,
  requestId: string,
): void {
  const turns = sessionTurns(engine);
  const active = turns.get(sessionId);
  if (active !== undefined) {
    throw new RuntimeRequestError(
      'session_busy',
      `Session ${sessionId} already has an active turn (${active.requestId}).`,
      false,
    );
  }
  turns.set(sessionId, { requestId });
}

/** Bind the engine turn id once the prompt launch resolves. */
export function bindActiveTurnId(
  engine: EngineContext,
  sessionId: string,
  requestId: string,
  turnId: number,
): void {
  const active = sessionTurns(engine).get(sessionId);
  if (active?.requestId !== requestId) return;
  active.turnId = turnId;
}

/** Release a reservation whose launch failed before any terminal event exists. */
export function releaseActiveTurn(engine: EngineContext, sessionId: string, requestId: string): void {
  const turns = sessionTurns(engine);
  if (turns.get(sessionId)?.requestId === requestId) {
    turns.delete(sessionId);
  }
}

/** The session's live turn registration, when one exists. */
export function getActiveTurn(
  engine: EngineContext,
  sessionId: string,
): ActiveTurnRegistration | undefined {
  return sessionTurns(engine).get(sessionId);
}

/**
 * Read-only busy probe for sibling families that must not interleave with a
 * live turn (`session.replay` rejects its burst with `session_busy` while one
 * is open). Pure query: never registers, settles, or clears anything.
 */
export function hasActiveTurn(engine: EngineContext, sessionId: string): boolean {
  return sessionTurns(engine).has(sessionId);
}

/**
 * Settle the registration for an engine turn that reached a terminal state:
 * remove it and hand it back for terminal-event synthesis. Undefined when no
 * registered turn owns the engine turn id (subagent or engine-internal turn).
 */
export function settleActiveTurn(
  engine: EngineContext,
  sessionId: string,
  turnId: number,
): ActiveTurnRegistration | undefined {
  const turns = sessionTurns(engine);
  const active = turns.get(sessionId);
  if (active?.turnId !== turnId) return undefined;
  turns.delete(sessionId);
  return active;
}

/**
 * Drop every registration of a session whose live engine scope is gone
 * (session.close, shutdown). Wave 3 calls this from the session-close path —
 * a settled turn never reaches the registry once its scope is disposed.
 */
export function clearActiveTurns(engine: EngineContext, sessionId: string): void {
  sessionTurns(engine).delete(sessionId);
}

export function createTurnHandlers(ctx: RuntimeHandlerContext): RuntimeHandlerEntry[] {
  const turnStart = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(turnStartParamsSchema, request);
    const engine = requireEngineContext(ctx);
    registerActiveTurn(engine, params.sessionId, params.requestId);
    try {
      const agent = engine.klient.session(params.sessionId).agent(MAIN_AGENT_ID);
      if (params.model !== undefined) {
        try {
          await agent.setModel(params.model);
        } catch (error) {
          // setModel resolves the alias against the configured catalog, so its
          // `config.invalid` failure is the turn surface's model_not_found.
          throw readEngineErrorCode(error) === 'config.invalid'
            ? new RuntimeRequestError(
                'model_not_found',
                error instanceof Error ? error.message : String(error),
                false,
              )
            : mapTurnError(error);
        }
      }
      if (params.planMode === true) {
        // Idempotent: the Desktop may have already entered plan mode through
        // session.setMode (M4) — the ACP-era wire always re-sent the mode
        // state with the prompt, and re-entering an active plan mode throws
        // `session.plan_mode_invalid` engine-side.
        if ((await agent.getPlan()) === null) {
          await agent.enterPlan();
        }
      }
      const launched = await agent.prompt({
        input: toPromptParts(params.input, request.method),
      });
      if (launched === undefined) {
        // The engine accepted the prompt but launched no turn (hook-blocked
        // or a launch failure); no terminal event will follow, so the
        // request fails here instead of hanging.
        throw new RuntimeRequestError(
          'turn_launch_failed',
          'The engine accepted the prompt but launched no turn.',
          false,
        );
      }
      bindActiveTurnId(engine, params.sessionId, params.requestId, launched.turn_id);
      return { requestId: params.requestId, turnId: launched.turn_id };
    } catch (error) {
      releaseActiveTurn(engine, params.sessionId, params.requestId);
      throw mapTurnError(error);
    }
  };

  const turnCancel = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(turnCancelParamsSchema, request);
    const engine = requireEngineContext(ctx);
    const active = getActiveTurn(engine, params.sessionId);
    if (active === undefined || active.requestId !== params.requestId) {
      // Idempotent: a cancel racing the terminal event is not an error.
      return { requestId: params.requestId, cancelled: false };
    }
    await runTurnEngine(() =>
      engine.klient
        .session(params.sessionId)
        .agent(MAIN_AGENT_ID)
        .cancel({ turnId: active.turnId }),
    );
    // The registration stays: the cancel-induced `turn.ended` settles it and
    // carries the requestId onto the terminal event.
    return { requestId: params.requestId, cancelled: true };
  };

  const turnSteer = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(turnSteerParamsSchema, request);
    const engine = requireEngineContext(ctx);
    const active = getActiveTurn(engine, params.sessionId);
    if (active === undefined || active.requestId !== params.requestId) {
      throw new RuntimeRequestError(
        'no_active_turn',
        `Session ${params.sessionId} has no active turn ${params.requestId} to steer.`,
        false,
      );
    }
    const steered = await runTurnEngine(() =>
      engine.klient
        .session(params.sessionId)
        .agent(MAIN_AGENT_ID)
        .steer({ input: toPromptParts(params.input, request.method) }),
    );
    return { requestId: params.requestId, accepted: steered !== undefined };
  };

  const approvalRespond = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(approvalRespondParamsSchema, request);
    const engine = requireEngineContext(ctx);
    // The interaction kernel no-ops on an id that is no longer pending, so a
    // late answer after a turn cancellation resolves cleanly.
    await runTurnEngine(() =>
      engine.klient.session(params.sessionId).approvals.decide(params.approvalId, {
        decision: params.decision,
        scope: params.scope,
        feedback: params.feedback,
        selectedLabel: params.selectedLabel,
      }),
    );
    return {};
  };

  const questionRespond = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(questionRespondParamsSchema, request);
    const engine = requireEngineContext(ctx);
    const questions = engine.klient.session(params.sessionId).questions;
    await runTurnEngine(() =>
      params.result === null
        ? questions.dismiss(params.questionId)
        : questions.answer(params.questionId, params.result),
    );
    return {};
  };

  return [
    ['turn.start', turnStart],
    ['turn.cancel', turnCancel],
    ['turn.steer', turnSteer],
    ['approval.respond', approvalRespond],
    ['question.respond', questionRespond],
  ];
}

/** One validated prompt input part (the protocol contentPartSchema shape). */
type PromptInputPart = Exclude<TurnStartParams['input'], string>[number];

/**
 * Translate the Desktop prompt input into engine `ContentPart`s. The engine
 * prompt contract accepts text / image_url / video_url parts only; every
 * other part type is rejected as `invalid_params` instead of failing deep in
 * the klient validation layer.
 */
function toPromptParts(input: TurnStartParams['input'], method: string): ContentPart[] {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input }];
  }
  return input.map((part) => toPromptPart(part, method));
}

function toPromptPart(part: PromptInputPart, method: string): ContentPart {
  switch (part.type) {
    case 'text': {
      if (part.text === undefined) {
        throw new RuntimeRequestError(
          'invalid_params',
          `${method} input text part requires a text string.`,
          false,
        );
      }
      return { type: 'text', text: part.text };
    }
    case 'image_url':
    case 'video_url': {
      const media = part.type === 'image_url' ? part.image_url : part.video_url;
      if (media === undefined || media.url.length === 0) {
        throw new RuntimeRequestError(
          'invalid_params',
          `${method} input ${part.type} part requires a non-empty url.`,
          false,
        );
      }
      const mediaUrl = { url: media.url, id: media.id ?? undefined };
      return part.type === 'image_url'
        ? { type: 'image_url', imageUrl: mediaUrl }
        : { type: 'video_url', videoUrl: mediaUrl };
    }
    default:
      throw new RuntimeRequestError(
        'invalid_params',
        `${method} input part type "${part.type}" is not supported by the engine prompt contract.`,
        false,
      );
  }
}

function parseParams<S extends z.ZodType>(schema: S, request: RuntimeRequestFrame): z.infer<S> {
  const parsed = schema.safeParse(request.params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new RuntimeRequestError(
      'invalid_params',
      `${request.method} params invalid (${where}${issue?.message ?? 'invalid'}).`,
      false,
    );
  }
  return parsed.data;
}

async function runTurnEngine<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapTurnError(error);
  }
}

/** Klient RPC code the dispatcher raises for a session that is not live. */
const SESSION_NOT_FOUND_RPC_CODE = 40404;

/** Engine typed error codes mapped onto structured runtime-v1 codes. */
const ENGINE_ERROR_CODES: Readonly<Record<string, string>> = {
  'prompt.not_found': 'no_active_turn',
  'model.not_found': 'model_not_found',
  'provider.not_found': 'provider_not_found',
  'session.busy': 'session_busy',
};

function mapTurnError(error: unknown): RuntimeRequestError {
  if (error instanceof RuntimeRequestError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof KlientValidationError && error.phase === 'input') {
    return new RuntimeRequestError('invalid_params', message, false);
  }
  if (error instanceof RPCError && error.code === SESSION_NOT_FOUND_RPC_CODE) {
    return new RuntimeRequestError('session_not_found', message, false);
  }
  const engineCode = readEngineErrorCode(error);
  const mapped = engineCode === undefined ? undefined : ENGINE_ERROR_CODES[engineCode];
  if (mapped !== undefined) {
    return new RuntimeRequestError(mapped, message, false);
  }
  return new RuntimeRequestError(
    'internal_error',
    `Kimi engine request failed: ${message}`,
    false,
  );
}

/** Engine errors cross the in-process transport as-is; read their typed code. */
function readEngineErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
