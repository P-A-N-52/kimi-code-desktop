/**
 * `sessions` method family — runtime-v1 session lifecycle handlers.
 *
 * Covers sessions.list / sessions.create / sessions.get / sessions.update /
 * sessions.delete / session.open / session.close over the engine composition
 * root (./engine). Reads go through the klient `global.sessions` facade
 * (`ISessionIndex`); writes compose `IWorkspaceLifecycleService.handlerFor` →
 * the handler's `ISessionLifecycleService` — there is deliberately no
 * App-scope session lifecycle facade, so this is the same composition the
 * node-sdk v2 client uses (`sdk-rpc-client-v2.ts`). `sessions.create` takes
 * the handler chain because the klient facade `global.sessions.create`
 * accepts no explicit session id; when the Desktop does not supply one, the
 * runtime mints it in the engine's own id shape (`session_<uuid>`). A fresh
 * create leaves the engine session materialized but unopened: `session.open`
 * is the step that registers the session with the adapter and fires
 * `RuntimeSessionHooks.onSessionOpened` so the turns family can attach its
 * event bridge — repeat opens answer the current descriptor without
 * re-firing hooks. `sessions.update` covers runtime-owned fields only
 * (`model`, `cwd`) — title/archive are Desktop metadata and never cross
 * runtime-v1 — and follows the SDK rename pattern for a closed session:
 * resume, mutate, close again.
 *
 * Error mapping: unknown session ids → `session_not_found`; a duplicate
 * explicit create id → `session_already_exists`; param validation →
 * `invalid_params`; any other engine failure → `internal_error` with the
 * original message preserved.
 */

import { randomUUID } from 'node:crypto';

import {
  closeSessionById,
  DEFAULT_AGENT_PROFILE_NAME,
  ensureMainAgent,
  ErrorCodes,
  getLiveSessionById,
  handlerForSession,
  IAgentLifecycleService,
  IAgentProfileService,
  IConfigService,
  IModelService,
  IProviderService,
  ISessionContext,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  isError2,
  IWorkspaceLifecycleService,
  MAIN_AGENT_ID,
  resumeSessionById,
  type ISessionScopeHandle,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import type { z } from 'zod';

import type { EngineContext } from './engine';
import {
  requireEngineContext,
  type RuntimeHandlerContext,
  type RuntimeHandlerEntry,
} from './handler-context';
import {
  RuntimeRequestError,
  sessionCloseParamsSchema,
  sessionOpenParamsSchema,
  sessionsCreateParamsSchema,
  sessionsDeleteParamsSchema,
  sessionsGetParamsSchema,
  sessionsListParamsSchema,
  sessionsUpdateParamsSchema,
  type JsonObject,
  type JsonValue,
  type RuntimeRequestFrame,
  type SessionDescriptor,
} from './protocol';

export function createSessionHandlers(ctx: RuntimeHandlerContext): RuntimeHandlerEntry[] {
  // Sessions this family has opened (resumed + adapter-tracked + bridge hook
  // fired). Drives open idempotency: a created-but-never-opened session is
  // live in the engine yet absent here, so its first open still fires hooks.
  const opened = new Set<string>();

  const listSessions = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(sessionsListParamsSchema, 'sessions.list', request.params);
    const engine = requireEngineContext(ctx);
    try {
      const page = await engine.klient.global.sessions.list({
        workspaceIds: params.workspaceId === undefined ? undefined : [params.workspaceId],
        before: params.cursor,
        limit: params.limit,
      });
      return toJson({
        sessions: page.items.map(summaryToDescriptor),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      throw toInternalError(error);
    }
  };

  const createSession = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(sessionsCreateParamsSchema, 'sessions.create', request.params);
    const engine = requireEngineContext(ctx);
    const accessor = engine.app.accessor;
    const sessionId = params.sessionId ?? `session_${randomUUID()}`;
    try {
      // The engine's create silently re-materializes an existing id, so the
      // duplicate guard lives here — the SDK does the same check.
      const existing =
        getLiveSessionById(accessor, sessionId) ??
        (await accessor.get(ISessionIndex).get(sessionId));
      if (existing !== undefined) {
        throw new RuntimeRequestError(
          'session_already_exists',
          `Session "${sessionId}" already exists.`,
          false,
        );
      }
      if (params.model !== undefined) await modelCatalogReady(engine);
      const handler = await accessor
        .get(IWorkspaceLifecycleService)
        .handlerFor({ root: params.cwd });
      const handle = await handler.accessor.get(ISessionLifecycleService).create({
        sessionId,
        workDir: params.cwd,
        mainAgentBinding:
          params.model === undefined
            ? undefined
            : { profile: DEFAULT_AGENT_PROFILE_NAME, model: params.model },
      });
      if (params.title !== undefined) {
        await handle.accessor.get(ISessionMetadata).setTitle(params.title);
      }
      return toJson(await liveDescriptor(handle));
    } catch (error) {
      throw toInternalError(error);
    }
  };

  const getSession = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(sessionsGetParamsSchema, 'sessions.get', request.params);
    const engine = requireEngineContext(ctx);
    let summary: SessionSummary | undefined;
    try {
      summary = await engine.klient.global.sessions.get(params.sessionId);
    } catch (error) {
      throw toInternalError(error);
    }
    if (summary === undefined) throw sessionNotFound(params.sessionId);
    return toJson(summaryToDescriptor(summary));
  };

  const updateSession = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(sessionsUpdateParamsSchema, 'sessions.update', request.params);
    const engine = requireEngineContext(ctx);
    const accessor = engine.app.accessor;
    let handle = getLiveSessionById(accessor, params.sessionId);
    let resumed = false;
    if (handle === undefined) {
      try {
        handle = await resumeSessionById(accessor, params.sessionId);
      } catch (error) {
        throw toInternalError(error);
      }
      if (handle === undefined) throw sessionNotFound(params.sessionId);
      resumed = true;
    }
    try {
      if (params.model !== undefined) {
        await modelCatalogReady(engine);
        const agent = await ensureMainAgent(handle);
        await agent.accessor.get(IAgentProfileService).setModel(params.model);
      }
      if (params.cwd !== undefined) {
        await handle.accessor.get(ISessionMetadata).update({ cwd: params.cwd });
      }
      return toJson(await liveDescriptor(handle));
    } catch (error) {
      throw toInternalError(error);
    } finally {
      // A session resumed only for this mutation goes back to closed; a
      // session that was already live stays live.
      if (resumed) {
        await closeSessionById(accessor, params.sessionId).catch(() => undefined);
      }
    }
  };

  const deleteSession = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(sessionsDeleteParamsSchema, 'sessions.delete', request.params);
    const engine = requireEngineContext(ctx);
    const accessor = engine.app.accessor;
    let handler;
    try {
      handler = await handlerForSession(accessor, params.sessionId);
    } catch (error) {
      throw toInternalError(error);
    }
    if (handler === undefined) throw sessionNotFound(params.sessionId);
    const wasLive = getLiveSessionById(accessor, params.sessionId) !== undefined;
    const wasOpened = opened.delete(params.sessionId);
    try {
      await handler.accessor.get(ISessionLifecycleService).delete(params.sessionId);
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.SESSION_NOT_FOUND) {
        throw sessionNotFound(params.sessionId);
      }
      throw toInternalError(error);
    }
    ctx.adapter.untrackLiveSession(params.sessionId);
    if (wasOpened || wasLive) await ctx.sessionHooks?.onSessionClosed?.(params.sessionId);
    return toJson({ deleted: true });
  };

  const openSession = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(sessionOpenParamsSchema, 'session.open', request.params);
    const engine = requireEngineContext(ctx);
    const accessor = engine.app.accessor;
    if (opened.has(params.sessionId)) {
      const live = getLiveSessionById(accessor, params.sessionId);
      if (live !== undefined) return toJson(await liveDescriptor(live));
      // The engine dropped a session this family still counts as open; fall
      // through and open it for real instead of answering stale state.
      opened.delete(params.sessionId);
    }
    let handle: ISessionScopeHandle | undefined;
    try {
      handle = await resumeSessionById(accessor, params.sessionId);
    } catch (error) {
      throw toInternalError(error);
    }
    if (handle === undefined) throw sessionNotFound(params.sessionId);
    ctx.adapter.trackLiveSession(params.sessionId);
    // Added after the hook so a bridge-attach failure leaves the next open
    // free to retry the hook instead of being absorbed by idempotency.
    await ctx.sessionHooks?.onSessionOpened?.(params.sessionId, engine);
    opened.add(params.sessionId);
    return toJson(await liveDescriptor(handle));
  };

  const closeSession = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(sessionCloseParamsSchema, 'session.close', request.params);
    const engine = requireEngineContext(ctx);
    const accessor = engine.app.accessor;
    if (getLiveSessionById(accessor, params.sessionId) === undefined) {
      // Existing-but-closed is the idempotent end state; a completely unknown
      // id is an error.
      let summary: SessionSummary | undefined;
      try {
        summary = await accessor.get(ISessionIndex).get(params.sessionId);
      } catch (error) {
        throw toInternalError(error);
      }
      if (summary === undefined) throw sessionNotFound(params.sessionId);
      opened.delete(params.sessionId);
      ctx.adapter.untrackLiveSession(params.sessionId);
      return toJson({ closed: true });
    }
    try {
      await closeSessionById(accessor, params.sessionId);
    } catch (error) {
      throw toInternalError(error);
    }
    opened.delete(params.sessionId);
    ctx.adapter.untrackLiveSession(params.sessionId);
    await ctx.sessionHooks?.onSessionClosed?.(params.sessionId);
    return toJson({ closed: true });
  };

  return [
    ['sessions.list', listSessions],
    ['sessions.create', createSession],
    ['sessions.get', getSession],
    ['sessions.update', updateSession],
    ['sessions.delete', deleteSession],
    ['session.open', openSession],
    ['session.close', closeSession],
  ];
}

function parseParams<Schema extends z.ZodType>(
  schema: Schema,
  method: string,
  params: JsonObject,
): z.infer<Schema> {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new RuntimeRequestError(
      'invalid_params',
      `${method} params invalid (${where}${issue?.message ?? 'invalid'}).`,
      false,
    );
  }
  return parsed.data as z.infer<Schema>;
}

function sessionNotFound(sessionId: string): RuntimeRequestError {
  return new RuntimeRequestError(
    'session_not_found',
    `Session "${sessionId}" does not exist.`,
    false,
  );
}

function toInternalError(error: unknown): RuntimeRequestError {
  if (error instanceof RuntimeRequestError) return error;
  return new RuntimeRequestError(
    'internal_error',
    error instanceof Error ? error.message : String(error),
    false,
  );
}

/** `z.looseObject` inference carries an `unknown` catchall; the wire shapes built here are plain JSON. */
function toJson(value: unknown): JsonValue {
  return value as JsonValue;
}

/**
 * The node-sdk `modelReady` gate: model alias resolution reads the catalog,
 * which only reflects config.toml once config/model/provider services report
 * ready — binding without the gate races the initial load.
 */
async function modelCatalogReady(engine: EngineContext): Promise<void> {
  const accessor = engine.app.accessor;
  await Promise.all([
    accessor.get(IConfigService).ready,
    accessor.get(IModelService).ready,
    accessor.get(IProviderService).ready,
  ]).then(() => undefined);
}

/**
 * Index summaries carry no model binding (that state lives on the agent
 * profile), so list/get descriptors report `model: null` rather than
 * resuming every session to find out.
 */
function summaryToDescriptor(summary: SessionSummary): SessionDescriptor {
  return {
    sessionId: summary.id,
    workspaceId: summary.workspaceId,
    cwd: summary.cwd,
    title: summary.title ?? null,
    model: null,
    archived: summary.archived,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}

/** Descriptor of a live session, read from its own scope services (metadata, context, main-agent profile). */
async function liveDescriptor(handle: ISessionScopeHandle): Promise<SessionDescriptor> {
  const meta = await handle.accessor.get(ISessionMetadata).read();
  const sessionCtx = handle.accessor.get(ISessionContext);
  const main = handle.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
  const model =
    main === undefined
      ? null
      : (main.accessor.get(IAgentProfileService).data().modelAlias ?? null);
  return {
    sessionId: meta.id,
    workspaceId: sessionCtx.workspaceId,
    cwd: meta.cwd ?? sessionCtx.cwd,
    title: meta.title ?? null,
    model,
    archived: meta.archived,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}
