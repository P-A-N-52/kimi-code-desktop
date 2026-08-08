/**
 * runtime-v1 auth + usage family — method handlers over the klient auth
 * facade and the engine's OAuth toolkit.
 *
 * Covers `AUTH_FAMILY_METHODS` (`auth.startLogin` / `auth.getFlow` /
 * `auth.cancelLogin` / `auth.logout` / `auth.status`) and `usage.get`. The
 * five auth methods mirror the klient `oauthService` contract verbatim
 * (`packages/klient/src/contract/global/auth.ts`): same method names, same
 * snake_case flow fields, and the deliberate `auth.status.loggedIn`
 * camelCase asymmetry (documented in protocol-parity.ts). Params are
 * validated against the protocol-parity schemas first; result shapes pass
 * through from the klient facade untouched.
 *
 * `usage.get` returns the raw `/usages` body — the opaque managed-usage
 * payload the oauth package fetches, which the Desktop frontend parses
 * loosely (`src/lib/managed-usage.ts`). Token resolution goes through the
 * engine's `oauthToolkit` service (`IOAuthToolkit`), the same
 * `KimiOAuthToolkit` instance the v2 auth service uses (configured with the
 * engine homeDir/identity), so `auth.*` and `usage.get` share one credential
 * store. There is no klient facade for managed usage, and the toolkit's own
 * `getManagedUsage` returns the parsed camelCase model — not wire-compatible
 * with the loose frontend parser — so the handler fetches the raw body
 * itself, mirroring `fetchManagedUsage`'s request shape (Bearer header,
 * JSON Accept, 8s timeout, one force-refresh retry on 401 like the ACP-era
 * Rust `fetch_managed_usage_inner`).
 *
 * Error mapping (all non-retryable): klient input-validation failures →
 * `invalid_params`; engine `Error2` codes pass through snake_cased
 * (dots → underscores, e.g. `auth.token_missing` → `auth_token_missing`);
 * missing OAuth credentials (`OAuthUnauthorizedError`) → `unauthorized`;
 * usage fetch/HTTP failures → `usage_unavailable`; everything else →
 * `internal_error`.
 */

import { Error2, IOAuthToolkit } from '@moonshot-ai/agent-core-v2';
import { KlientValidationError } from '@moonshot-ai/klient';
import { OAuthUnauthorizedError, kimiCodeUsageUrl } from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';

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
  authProviderParamsSchema,
  usageGetParamsSchema,
} from './protocol-parity';

/** Match the oauth package's own usage fetch timeout (`managed-usage.ts`). */
const USAGE_FETCH_TIMEOUT_MS = 8000;

export function createAuthHandlers(ctx: RuntimeHandlerContext): RuntimeHandlerEntry[] {
  const authStartLogin = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(authProviderParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const flow = await engine.klient.global.auth.startLogin(params.provider);
      return asWireJson(flow);
    });
  };

  const authGetFlow = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(authProviderParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const snapshot = await engine.klient.global.auth.flow(params.provider);
      // No active flow surfaces as `undefined`; JSONL has no undefined, so
      // encode it as null (`authGetFlowResultSchema` is nullable).
      return snapshot === undefined ? null : asWireJson(snapshot);
    });
  };

  const authCancelLogin = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(authProviderParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const result = await engine.klient.global.auth.cancelLogin(params.provider);
      return asWireJson(result);
    });
  };

  const authLogout = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(authProviderParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const result = await engine.klient.global.auth.logout(params.provider);
      return asWireJson(result);
    });
  };

  const authStatus = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(authProviderParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const status = await engine.klient.global.auth.status(params.provider);
      return asWireJson(status);
    });
  };

  const usageGet = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    parseParams(usageGetParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const toolkit = engine.app.accessor.get(IOAuthToolkit);
      let result = await fetchUsagePayload(await resolveUsageToken(toolkit));
      // A mid-flight token rejection may be stale — force one refresh and
      // retry, mirroring the ACP-era `fetch_managed_usage_inner`.
      if (result.kind === 'error' && result.status === 401) {
        result = await fetchUsagePayload(await resolveUsageToken(toolkit, true));
      }
      if (result.kind === 'error') {
        throw new RuntimeRequestError('usage_unavailable', result.message, false);
      }
      return result.payload;
    });
  };

  return [
    ['auth.startLogin', authStartLogin],
    ['auth.getFlow', authGetFlow],
    ['auth.cancelLogin', authCancelLogin],
    ['auth.logout', authLogout],
    ['auth.status', authStatus],
    ['usage.get', usageGet],
  ];
}

/**
 * Resolve a fresh token for the managed Kimi Code provider. `force` rotates
 * the cached token; a missing credential surfaces as `unauthorized` so the
 * Desktop can drive the user through login instead of a generic failure.
 */
async function resolveUsageToken(toolkit: IOAuthToolkit, force = false): Promise<string> {
  try {
    return await toolkit.tokenProvider().getAccessToken(force ? { force: true } : undefined);
  } catch (error) {
    if (error instanceof OAuthUnauthorizedError) {
      throw new RuntimeRequestError('unauthorized', error.message, false);
    }
    // runEngine maps the rest to internal_error.
    throw error;
  }
}

type UsageFetchResult =
  | { readonly kind: 'ok'; readonly payload: JsonValue }
  | { readonly kind: 'error'; readonly status?: number; readonly message: string };

/**
 * Raw `/usages` fetch mirroring `fetchManagedUsage` (`managed-usage.ts`):
 * same headers, timeout, and user-facing hints — minus the parsing, because
 * the runtime-v1 contract pins the opaque platform body, not the parsed
 * model. Never throws: every failure becomes a structured result.
 */
async function fetchUsagePayload(token: string): Promise<UsageFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(kimiCodeUsageUrl(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const status = res.status;
      const message =
        status === 401
          ? 'Authorization failed. Please check your API key (try /login).'
          : status === 404
            ? 'Usage endpoint not available. Try Kimi For Coding.'
            : `Failed to fetch usage: HTTP ${String(status)}`;
      return { kind: 'error', status, message };
    }
    return { kind: 'ok', payload: (await res.json()) as JsonValue };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: 'Failed to fetch usage: request timed out.' };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to fetch usage: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

function parseParams<S extends z.ZodType>(schema: S, request: RuntimeRequestFrame): z.infer<S> {
  const parsed = schema.safeParse(request.params);
  if (!parsed.success) {
    throw invalidParams(request.method, parsed.error);
  }
  return parsed.data;
}

function invalidParams(method: string, error: z.ZodError): RuntimeRequestError {
  const issue = error.issues[0];
  const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return new RuntimeRequestError(
    'invalid_params',
    `${method} params invalid (${where}${issue?.message ?? 'invalid'}).`,
    false,
  );
}

async function runEngine(fn: () => Promise<JsonValue>): Promise<JsonValue> {
  try {
    return await fn();
  } catch (error) {
    throw mapEngineError(error);
  }
}

function mapEngineError(error: unknown): RuntimeRequestError {
  if (error instanceof RuntimeRequestError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof KlientValidationError && error.phase === 'input') {
    return new RuntimeRequestError('invalid_params', message, false);
  }
  // Engine `Error2` codes (e.g. `auth.token_missing`) pass through
  // snake_cased; see `packages/agent-core-v2/src/app/auth/errors.ts`.
  if (error instanceof Error2) {
    return new RuntimeRequestError(error.code.replace(/\./g, '_'), message, false);
  }
  return new RuntimeRequestError(
    'internal_error',
    `Kimi engine request failed: ${message}`,
    false,
  );
}

/** Klient facade values already crossed the transport's JSON round-trip. */
function asWireJson(value: unknown): JsonValue {
  return value as JsonValue;
}
