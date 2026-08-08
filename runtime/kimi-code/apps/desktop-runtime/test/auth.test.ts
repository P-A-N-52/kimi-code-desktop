import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuthHandlers } from '../src/auth-router';
import type { RuntimeHandlerContext } from '../src/handler-context';
import { KimiRuntimeAdapter } from '../src/kimi-runtime-adapter';
import {
  AUTH_FAMILY_METHODS,
  RUNTIME_PROTOCOL,
  USAGE_FAMILY_METHODS,
  type JsonObject,
  type JsonValue,
  type RuntimeRequestFrame,
} from '../src/protocol';
import { DEFERRED_RESPONSE, MethodRouter } from '../src/router';

describe('runtime-v1 auth + usage family', () => {
  let homeDir: string;
  const adapter = new KimiRuntimeAdapter();
  const router = new MethodRouter();
  let requestSeq = 0;
  let scrubbedEnv: [string, string][] = [];

  beforeAll(async () => {
    // Hermetic engine env: host KIMI_* variables (API keys, model overrides,
    // base URLs) must not leak into the engine the tests boot. The temp home
    // keeps all auth state (credentials dir) inside the test, so neither the
    // real ~/.kimi-code nor the network is ever touched.
    scrubbedEnv = [];
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('KIMI_') && value !== undefined) {
        scrubbedEnv.push([key, value]);
        delete process.env[key];
      }
    }
    homeDir = await mkdtemp(join(tmpdir(), 'desktop-runtime-auth-'));
    await adapter.start({ homeDir });
    const ctx: RuntimeHandlerContext = {
      adapter,
      emitSessionEvent: () => Promise.resolve(),
      emitRuntimeEvent: () => Promise.resolve(),
    };
    for (const [method, handler] of createAuthHandlers(ctx)) {
      router.register(method, handler);
    }
  }, 120_000);

  afterAll(async () => {
    await adapter.close();
    for (const [key, value] of scrubbedEnv) {
      process.env[key] = value;
    }
    scrubbedEnv = [];
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }, 60_000);

  async function call(method: string, params: JsonObject = {}): Promise<JsonValue> {
    requestSeq += 1;
    const request: RuntimeRequestFrame = {
      protocol: RUNTIME_PROTOCOL,
      type: 'request',
      id: `auth-${requestSeq}`,
      method,
      params,
    };
    const result = await router.dispatch(request);
    expect(result).not.toBe(DEFERRED_RESPONSE);
    return result as JsonValue;
  }

  it('registers exactly the auth and usage family methods', () => {
    expect([...router.methods].sort()).toEqual(
      [...AUTH_FAMILY_METHODS, ...USAGE_FAMILY_METHODS].sort(),
    );
  });

  it('auth.status reports not-logged-in in an empty temp home', async () => {
    // No credentials were provisioned: the status is a structured, offline
    // snapshot — never an error and never a network touch.
    await expect(call('auth.status')).resolves.toEqual({ loggedIn: false });
    await expect(call('auth.status', { provider: 'kimi-code' })).resolves.toEqual({
      loggedIn: false,
    });
  });

  it('auth.getFlow answers null when no flow is active', async () => {
    await expect(call('auth.getFlow')).resolves.toBeNull();
    await expect(call('auth.getFlow', { provider: 'kimi-code' })).resolves.toBeNull();
  });

  it('auth.cancelLogin is idempotent for an unknown flow', async () => {
    // The engine has no in-memory flow for this provider; cancelling is a
    // no-op with a structured response, not an error.
    await expect(call('auth.cancelLogin')).resolves.toEqual({
      cancelled: false,
      status: 'cancelled',
    });
  });

  it('auth.logout is a no-op in the empty state', async () => {
    // Logging out with no credentials removes nothing and reports success.
    // The provider name is the engine's managed-provider key
    // (`KIMI_CODE_PROVIDER_NAME = 'managed:kimi-code'`), passed through from
    // the klient contract verbatim.
    await expect(call('auth.logout')).resolves.toEqual({
      logged_out: true,
      provider: 'managed:kimi-code',
    });
  });

  it('usage.get fails structurally without credentials', async () => {
    // No token -> the engine's oauth toolkit rejects before any fetch: a
    // structured `unauthorized` error (never a hang, never a crash, and no
    // network on this machine).
    await expect(call('usage.get')).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
  });

  it('rejects invalid params before touching the engine', async () => {
    await expect(call('auth.startLogin', { provider: '' })).rejects.toMatchObject({
      code: 'invalid_params',
      retryable: false,
    });
    await expect(call('auth.status', { provider: 42 })).rejects.toMatchObject({
      code: 'invalid_params',
      retryable: false,
    });
    await expect(call('auth.getFlow', { provider: 42 })).rejects.toMatchObject({
      code: 'invalid_params',
      retryable: false,
    });
  });
});
