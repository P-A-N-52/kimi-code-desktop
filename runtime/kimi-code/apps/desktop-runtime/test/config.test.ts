import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createConfigHandlers } from '../src/config-router';
import type { RuntimeHandlerContext } from '../src/handler-context';
import { KimiRuntimeAdapter } from '../src/kimi-runtime-adapter';
import {
  CONFIG_FAMILY_METHODS,
  RUNTIME_PROTOCOL,
  type JsonObject,
  type JsonValue,
  type RuntimeRequestFrame,
} from '../src/protocol';
import { DEFERRED_RESPONSE, MethodRouter } from '../src/router';

describe('runtime-v1 config family', () => {
  let homeDir: string;
  let configPath: string;
  const adapter = new KimiRuntimeAdapter();
  const router = new MethodRouter();
  let requestSeq = 0;
  let scrubbedEnv: [string, string][] = [];

  beforeAll(async () => {
    // Hermetic engine env: host KIMI_* variables (API keys, model overrides)
    // must not leak into the config the test engine resolves.
    scrubbedEnv = [];
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('KIMI_') && value !== undefined) {
        scrubbedEnv.push([key, value]);
        delete process.env[key];
      }
    }
    homeDir = await mkdtemp(join(tmpdir(), 'desktop-runtime-config-'));
    configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, 'default_plan_mode = true\n', 'utf8');
    await adapter.start({ homeDir });
    const ctx: RuntimeHandlerContext = {
      adapter,
      emitSessionEvent: () => Promise.resolve(),
      emitRuntimeEvent: () => Promise.resolve(),
    };
    for (const [method, handler] of createConfigHandlers(ctx)) {
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
      id: `config-${requestSeq}`,
      method,
      params,
    };
    const result = await router.dispatch(request);
    expect(result).not.toBe(DEFERRED_RESPONSE);
    return result as JsonValue;
  }

  it('registers exactly the config family methods', () => {
    expect([...router.methods].sort()).toEqual([...CONFIG_FAMILY_METHODS].sort());
  });

  it('config.get returns registered defaults and on-disk values', async () => {
    const all = await call('config.get');
    expect(all).toMatchObject({
      // Read back from the config.toml written before boot.
      defaultPlanMode: true,
      // Registered section default, absent from the file.
      builtinProductSkills: true,
    });
    await expect(call('config.get', { domain: 'defaultPlanMode' })).resolves.toBe(true);
    // An unset domain crosses JSONL as null, never undefined.
    await expect(call('config.get', { domain: 'noSuchDomain' })).resolves.toBeNull();
  });

  it('config.update writes a user patch and returns the refreshed snapshot', async () => {
    const result = await call('config.update', { domain: 'defaultPlanMode', patch: false });
    expect(result).toEqual({ domain: 'defaultPlanMode', value: false });
    await expect(call('config.get', { domain: 'defaultPlanMode' })).resolves.toBe(false);
    expect(await readFile(configPath, 'utf8')).toContain('default_plan_mode = false');
  });

  it('config.update with memory target skips persistence', async () => {
    const before = await readFile(configPath, 'utf8');
    const result = await call('config.update', {
      domain: 'desktopMemoryProbe',
      patch: { enabled: true },
      target: 'memory',
    });
    expect(result).toEqual({ domain: 'desktopMemoryProbe', value: { enabled: true } });
    await expect(call('config.get', { domain: 'desktopMemoryProbe' })).resolves.toEqual({
      enabled: true,
    });
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('models.list and providers.list return empty tables on a fresh home', async () => {
    await expect(call('models.list')).resolves.toEqual({ models: [] });
    await expect(call('providers.list')).resolves.toEqual({ providers: [] });
  });

  it('providers.import adds a named provider visible to providers.list', async () => {
    const result = await call('providers.import', {
      providers: [
        {
          id: 'example-openai',
          type: 'openai',
          baseUrl: 'https://example.com/v1',
          auth: { method: 'api-key', apiKey: 'YOUR_API_KEY' },
          defaultModel: 'example-model',
        },
      ],
    });
    expect(result).toMatchObject({
      providerId: 'example-openai',
      providers: [
        {
          id: 'example-openai',
          type: 'openai',
          base_url: 'https://example.com/v1',
          default_model: 'example-model',
          has_api_key: true,
          status: 'connected',
        },
      ],
    });
    await expect(call('providers.list')).resolves.toMatchObject({
      providers: [{ id: 'example-openai', type: 'openai' }],
    });
  });

  it('rejects invalid params with a structured non-retryable error', async () => {
    await expect(call('config.update', { patch: {} })).rejects.toMatchObject({
      code: 'invalid_params',
      retryable: false,
    });
    await expect(
      call('config.update', { domain: 'defaultPlanMode', patch: true, target: 'project' }),
    ).rejects.toMatchObject({ code: 'invalid_params', retryable: false });
    await expect(call('providers.import', { providers: [] })).rejects.toMatchObject({
      code: 'invalid_params',
      retryable: false,
    });
    // Passes the draft protocol shape but fails the tightened ProviderInput.
    await expect(call('providers.import', { providers: [{ id: 'example' }] })).rejects.toMatchObject(
      { code: 'invalid_params', retryable: false },
    );
    await expect(call('config.get', { domain: 42 })).rejects.toMatchObject({
      code: 'invalid_params',
      retryable: false,
    });
  });

  it('wraps engine-side validation failures as internal_error', async () => {
    await expect(
      call('config.update', { domain: 'defaultPlanMode', patch: 'not-a-boolean' }),
    ).rejects.toMatchObject({ code: 'internal_error', retryable: false });
  });

  it('fails structurally when the engine is not started', async () => {
    const coldRouter = new MethodRouter();
    const ctx: RuntimeHandlerContext = {
      adapter: new KimiRuntimeAdapter(),
      emitSessionEvent: () => Promise.resolve(),
      emitRuntimeEvent: () => Promise.resolve(),
    };
    for (const [method, handler] of createConfigHandlers(ctx)) {
      coldRouter.register(method, handler);
    }
    requestSeq += 1;
    await expect(
      coldRouter.dispatch({
        protocol: RUNTIME_PROTOCOL,
        type: 'request',
        id: `config-${requestSeq}`,
        method: 'providers.list',
        params: {},
      }),
    ).rejects.toMatchObject({ code: 'engine_not_available', retryable: false });
  });
});
