import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resetModelsDevUpstreamForTest,
  setModelsDevUpstreamForTest,
} from '@moonshot-ai/agent-core-v2';
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

  // -------------------------------------------------------------------------
  // M4: providers.catalog.* (models.dev directory) + providers.import source
  // channels. The models.dev upstream is stubbed to a fixed document; the
  // custom-registry channel is exercised against a loopback HTTP server
  // (offline, random port).
  // -------------------------------------------------------------------------

  describe('provider catalog and import channels', () => {
    const FAKE_CATALOG = {
      beta: {
        id: 'beta',
        name: 'Beta Systems',
        api: 'https://api.beta.test/v1',
        type: 'anthropic',
        models: {
          'beta-1': { id: 'beta-1', limit: { context: 32000 } },
        },
      },
      acme: {
        id: 'acme',
        name: 'Acme Co',
        api: 'https://api.acme.test/v1',
        type: 'openai',
        models: {
          'acme-pro': { id: 'acme-pro', name: 'Acme Pro', limit: { context: 64000 } },
          'acme-mini': { id: 'acme-mini', limit: { context: 32000 } },
        },
      },
    };

    const realFetch = globalThis.fetch;
    let registryServer: Server | undefined;
    let registryUrl = '';
    let lastAuthHeader: string | undefined;
    let registryResponder: (req: IncomingMessage, res: ServerResponse) => void;

    beforeAll(async () => {
      // Route the models.dev directory fetch at a fixed document; everything
      // else (the loopback registry) goes to the real fetch.
      setModelsDevUpstreamForTest({
        fetchImpl: ((...args: Parameters<typeof fetch>) => {
          const url = String(args[0]);
          if (url === 'https://models.dev/api.json') {
            return Promise.resolve(
              new Response(JSON.stringify(FAKE_CATALOG), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
          return realFetch(...args);
        }) as typeof fetch,
      });
      registryResponder = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      };
      registryServer = createServer((req, res) => {
        const auth = req.headers['authorization'];
        lastAuthHeader = typeof auth === 'string' ? auth : undefined;
        registryResponder(req, res);
      });
      await new Promise<void>((resolve) => {
        registryServer!.listen(0, '127.0.0.1', resolve);
      });
      const address = registryServer.address() as AddressInfo;
      registryUrl = `http://127.0.0.1:${String(address.port)}/api.json`;
    }, 60_000);

    afterAll(async () => {
      resetModelsDevUpstreamForTest();
      if (registryServer !== undefined) {
        await new Promise<void>((resolve) => registryServer!.close(() => resolve()));
        registryServer = undefined;
      }
    }, 60_000);

    function serveRegistryDocument(document: unknown, status = 200): void {
      registryResponder = (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(document));
      };
    }

    it('providers.catalog.list maps the directory to sorted summaries', async () => {
      await expect(call('providers.catalog.list')).resolves.toEqual({
        providers: [
          { id: 'acme', name: 'Acme Co', modelCount: 2 },
          { id: 'beta', name: 'Beta Systems', modelCount: 1 },
        ],
      });
    });

    it('providers.catalog.get returns the entry DTO and maps not-found', async () => {
      await expect(call('providers.catalog.get', { entryId: 'acme' })).resolves.toEqual({
        providerId: 'acme',
        name: 'Acme Co',
        models: [
          { id: 'acme-pro', name: 'Acme Pro', maxContextTokens: 64000 },
          { id: 'acme-mini', name: 'acme-mini', maxContextTokens: 32000 },
        ],
      });
      await expect(call('providers.catalog.get', { entryId: 'nope' })).rejects.toMatchObject({
        code: 'catalog_entry_not_found',
        retryable: false,
      });
      await expect(call('providers.catalog.get', {})).rejects.toMatchObject({
        code: 'invalid_params',
      });
      await expect(call('providers.catalog.get', { entryId: '' })).rejects.toMatchObject({
        code: 'invalid_params',
      });
    });

    it('imports a catalog entry with models and applies defaultModel', async () => {
      const result = await call('providers.import', {
        source: 'catalog',
        entryId: 'acme',
        config: { apiKey: 'YOUR_API_KEY', defaultModel: 'acme-mini' },
      });
      expect(result).toMatchObject({ providerId: 'acme', modelsImported: 2 });
      const listed = (await call('providers.list')) as {
        providers: { id: string; models?: string[]; has_api_key?: boolean }[];
      };
      const acme = listed.providers.find((provider) => provider.id === 'acme');
      expect(acme?.models?.sort()).toEqual(['acme/acme-mini', 'acme/acme-pro']);
      expect(acme?.has_api_key).toBe(true);
      // The CLI's --default-model parity: the global default moved to the
      // selected imported alias.
      await expect(call('config.get', { domain: 'defaultModel' })).resolves.toBe('acme/acme-mini');
    });

    it('rejects a catalog defaultModel outside the entry before importing', async () => {
      await expect(
        call('providers.import', {
          source: 'catalog',
          entryId: 'beta',
          config: { apiKey: 'YOUR_API_KEY', defaultModel: 'no-such-model' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_params', retryable: false });
      // The failed validation happened before any engine write.
      const listed = (await call('providers.list')) as { providers: { id: string }[] };
      expect(listed.providers.map((provider) => provider.id)).not.toContain('beta');
    });

    it('rejects catalog imports without an apiKey as invalid_params', async () => {
      await expect(
        call('providers.import', { source: 'catalog', entryId: 'acme' }),
      ).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(
        call('providers.import', {
          source: 'catalog',
          entryId: 'acme',
          config: { defaultModel: 'acme-pro' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_params' });
    });

    it('imports a custom registry over loopback HTTP with a bearer key', async () => {
      serveRegistryDocument({
        acmereg: {
          id: 'acmereg',
          name: 'Acme Registry',
          api: 'https://api.acmereg.test/v1',
          type: 'openai',
          models: {
            'reg-model-1': { id: 'reg-model-1', limit: { context: 128000 } },
          },
        },
      });
      const result = await call('providers.import', {
        source: 'registry',
        registryUrl,
        config: { apiKey: 'registry-key-1' },
      });
      expect(result).toMatchObject({ providerId: 'acmereg', modelsImported: 1 });
      expect(lastAuthHeader).toBe('Bearer registry-key-1');
      const listed = (await call('providers.list')) as {
        providers: { id: string; models?: string[] }[];
      };
      const imported = listed.providers.find((provider) => provider.id === 'acmereg');
      expect(imported?.models).toEqual(['acmereg/reg-model-1']);
    });

    it('falls back to KIMI_REGISTRY_API_KEY when params carry no key', async () => {
      serveRegistryDocument({
        envreg: {
          id: 'envreg',
          name: 'Env Registry',
          api: 'https://api.envreg.test/v1',
          type: 'openai',
          models: { 'env-model': { id: 'env-model', limit: { context: 8192 } } },
        },
      });
      process.env['KIMI_REGISTRY_API_KEY'] = 'env-registry-key';
      try {
        await expect(
          call('providers.import', { source: 'registry', registryUrl }),
        ).resolves.toMatchObject({ providerId: 'envreg' });
        expect(lastAuthHeader).toBe('Bearer env-registry-key');
      } finally {
        delete process.env['KIMI_REGISTRY_API_KEY'];
      }
    });

    it('maps registry HTTP 401 to registry_auth_required', async () => {
      registryResponder = (_req, res) => {
        // No JSON body: the fetch fallback message carries the HTTP status.
        res.writeHead(401).end();
      };
      await expect(
        call('providers.import', {
          source: 'registry',
          registryUrl,
          config: { apiKey: 'wrong-key' },
        }),
      ).rejects.toMatchObject({ code: 'registry_auth_required', retryable: false });
    });

    it('maps an unreachable registry to registry_unavailable', async () => {
      const deadPort = (registryServer!.address() as AddressInfo).port + 10_000;
      await expect(
        call('providers.import', {
          source: 'registry',
          registryUrl: `http://127.0.0.1:${String(deadPort)}/api.json`,
          config: { apiKey: 'registry-key-1' },
        }),
      ).rejects.toMatchObject({ code: 'registry_unavailable', retryable: false });
    });

    it('maps an empty registry document to registry_invalid', async () => {
      serveRegistryDocument({});
      await expect(
        call('providers.import', {
          source: 'registry',
          registryUrl,
          config: { apiKey: 'registry-key-1' },
        }),
      ).rejects.toMatchObject({ code: 'registry_invalid', retryable: false });
    });

    it('rejects non-http registry URLs as invalid_params', async () => {
      await expect(
        call('providers.import', {
          source: 'registry',
          registryUrl: 'file:///tmp/api.json',
          config: { apiKey: 'registry-key-1' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_params', retryable: false });
    });
  });
});
