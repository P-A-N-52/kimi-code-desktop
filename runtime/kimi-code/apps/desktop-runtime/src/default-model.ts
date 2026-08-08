/**
 * Default model binding — CLI parity helpers shared by the session and turn
 * families.
 *
 * The pinned engine applies the configured `default_model` at profile-bind
 * time (`AgentProfileService.bind` falls back to the `IConfigService` key
 * `defaultModel` when no explicit alias is passed), but its own session
 * create is lazy: without a `mainAgentBinding` the main agent is materialized
 * on first use with NO binding, and prompting an unbound agent fails with the
 * engine's `model.not_configured` ("Model not set"). The node-sdk v2 client
 * (the CLI/kap-server path) closes the gap by binding the default profile +
 * default model on first use — at resume and before every agent interaction
 * (`materializeMainAgent`, `packages/node-sdk/src/sdk-rpc-client-v2.ts`) —
 * leaving an existing journal binding untouched and a model-less home unbound
 * instead of failing. These helpers are the desktop runtime's equivalent, so
 * create, resume, and prompt all inherit the configured default exactly like
 * the CLI.
 */

import {
  DEFAULT_AGENT_PROFILE_NAME,
  ensureMainAgent,
  getLiveSessionById,
  IAgentProfileService,
  IConfigService,
  IModelService,
  IProviderService,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

import type { EngineContext } from './engine';

/**
 * The node-sdk `modelReady` gate: model alias resolution reads the catalog,
 * which only reflects config.toml once config/model/provider services report
 * ready — binding without the gate races the initial load.
 */
export async function modelCatalogReady(engine: EngineContext): Promise<void> {
  const accessor = engine.app.accessor;
  await Promise.all([
    accessor.get(IConfigService).ready,
    accessor.get(IModelService).ready,
    accessor.get(IProviderService).ready,
  ]).then(() => undefined);
}

/**
 * The configured global default model alias, once config/model/provider are
 * ready — `undefined` when `default_model` is absent or empty. Reads the same
 * `IConfigService` key `AgentProfileService.bind` falls back to, so the value
 * here and the engine's own default resolution can never diverge.
 */
export async function configuredDefaultModel(
  engine: EngineContext,
): Promise<string | undefined> {
  await modelCatalogReady(engine);
  const alias = engine.app.accessor.get(IConfigService).get<string>('defaultModel');
  return typeof alias === 'string' && alias.length > 0 ? alias : undefined;
}

/**
 * Bind the default profile + configured default model on a session whose main
 * agent has no binding yet — the same first-use bind the node-sdk applies on
 * resume/prompt (`materializeMainAgent`). An existing journal binding wins; a
 * home with no configured default leaves the agent unbound instead of failing
 * (the CLI's model-less session reads map onto the unbound state exactly).
 */
export async function bindDefaultModelIfUnbound(
  engine: EngineContext,
  handle: ISessionScopeHandle,
): Promise<void> {
  await modelCatalogReady(engine);
  const agent = await ensureMainAgent(handle);
  const profile = agent.accessor.get(IAgentProfileService);
  if (profile.data().profileName !== undefined) return;
  const model = await configuredDefaultModel(engine);
  if (model === undefined) return;
  await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model });
}

/**
 * Live-session wrapper of {@link bindDefaultModelIfUnbound} for paths that
 * address a session by id. A session that is not live is left alone — the
 * caller's own prompt/agent resolution reports `session_not_found` for it.
 */
export async function ensureLiveDefaultModelBinding(
  engine: EngineContext,
  sessionId: string,
): Promise<void> {
  const handle = getLiveSessionById(engine.app.accessor, sessionId);
  if (handle === undefined) return;
  await bindDefaultModelIfUnbound(engine, handle);
}
