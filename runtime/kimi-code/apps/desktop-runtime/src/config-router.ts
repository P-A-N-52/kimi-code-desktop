/**
 * runtime-v1 config family — method handlers over the klient global facade.
 *
 * Covers CONFIG_FAMILY_METHODS: `config.get` / `config.update` read and write
 * the layered config service (`global.config.get/getAll/set`),
 * `models.list` / `providers.list` enumerate the kosong catalog
 * (`global.kosong.listModels/listProviders`), and `providers.import` adds
 * providers. Params are validated against the protocol schemas first;
 * `providers.import`'s direct form then tightens the draft wire shape to the
 * klient `ProviderInput` contract. Failures map to structured errors:
 * `invalid_params` for rejected params, `*_not_found` for engine not-found
 * codes, `internal_error` for every other engine failure.
 *
 * M4 additions:
 * - `providers.catalog.list` / `providers.catalog.get` expose the importable
 *   models.dev directory through the engine's `IModelsDevImportService`
 *   (offline built-in snapshot fallback included), mapped onto the Desktop
 *   `ProviderCatalogSummary` / `ProviderCatalogEntry` DTOs.
 * - `providers.import` gains two `source` channels next to the M1 direct
 *   form: `catalog` imports a directory entry through
 *   `importModelsDevProvider` (provider + model aliases, optional
 *   `defaultModel` selection), `registry` imports a custom api.json document
 *   through `importCustomRegistry` — the same apply flow the CLI's
 *   `kimi provider add <url>` uses, so provider records keep their model
 *   aliases and `source` refresh blob. The registry bearer key resolves as
 *   `config.apiKey` → process env `KIMI_REGISTRY_API_KEY` (passed through by
 *   the Rust host at spawn) → the stored key of a previous import from the
 *   same URL (engine behavior); it never enters argv, logs, or events.
 *   Registry failures classify into `registry_auth_required` /
 *   `registry_unavailable` / `registry_invalid` (non-retryable).
 *
 * The klient config/catalog read paths are synchronous snapshots over state
 * the engine loads asynchronously (config.toml load, then kosong provider /
 * model hydration). The readiness barrier (`IConfigService.ready` +
 * `IKosongConfigService.ready`) lives in engine start
 * (`KimiRuntimeAdapter.start`), so the handshake only completes once those
 * snapshots are whole and no per-handler wait remains here.
 */

import { IModelsDevImportService } from '@moonshot-ai/agent-core-v2';
import { KlientValidationError, type ProviderInput } from '@moonshot-ai/klient';
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
  configGetParamsSchema,
  configUpdateParamsSchema,
  modelsListParamsSchema,
  providersCatalogGetParamsSchema,
  providersCatalogListParamsSchema,
  providersImportParamsSchema,
  providersListParamsSchema,
  type ProvidersImportParams,
} from './protocol-schemas';

/** Klient `ProviderInput` wire shape — the tightened providers.import entry. */
const providerImportEntrySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  auth: z.union([
    z.object({ method: z.literal('api-key'), apiKey: z.string().min(1) }),
    z.object({ method: z.literal('oauth') }),
  ]),
  defaultModel: z.string().min(1).optional(),
});

/** Engine typed errors whose codes map onto structured runtime-v1 codes. */
const ENGINE_ERROR_CODES: Readonly<Record<string, { code: string; retryable: boolean }>> = {
  'provider.not_found': { code: 'provider_not_found', retryable: false },
  'model.not_found': { code: 'model_not_found', retryable: false },
  // The models.dev directory fetch failed AND the built-in snapshot was
  // unusable — transient by the engine's own taxonomy.
  'modelsDev.catalog_unavailable': { code: 'catalog_unavailable', retryable: true },
  'modelsDev.catalog_entry_not_found': { code: 'catalog_entry_not_found', retryable: false },
  'modelsDev.import_invalid': { code: 'catalog_import_invalid', retryable: false },
  'provider.oauth_managed': { code: 'provider_oauth_managed', retryable: false },
};

export function createConfigHandlers(ctx: RuntimeHandlerContext): RuntimeHandlerEntry[] {
  const configGet = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(configGetParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      // Absent domain means "whole config" (klient `getAll`).
      if (params.domain === undefined) {
        return asWireJson(await engine.klient.global.config.getAll());
      }
      const value: unknown = await engine.klient.global.config.get(params.domain);
      // `undefined` (unset domain) cannot cross JSONL — encode it as null.
      return value === undefined ? null : asWireJson(value);
    });
  };

  const configUpdate = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(configUpdateParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      await engine.klient.global.config.set({
        domain: params.domain,
        patch: params.patch,
        target: params.target,
      });
      // Carry the refreshed effective value so the Desktop can re-render
      // without a follow-up config.get.
      const value: unknown = await engine.klient.global.config.get(params.domain);
      return { domain: params.domain, value: value === undefined ? null : asWireJson(value) };
    });
  };

  const modelsList = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    parseParams(modelsListParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const items = await engine.klient.global.kosong.listModels();
      // Catalog fields (snake_case) pass through untouched; `id`/`name` are
      // the camelCase descriptor keys the protocol schema requires/allows.
      const models = items.map((item) => ({
        ...item,
        id: item.model,
        name: item.display_name ?? item.model,
      }));
      return asWireJson({ models });
    });
  };

  const providersList = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    parseParams(providersListParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const items = await engine.klient.global.kosong.listProviders();
      // Catalog items already carry the descriptor's `id`; pass through.
      return asWireJson({ providers: items.map((item) => ({ ...item })) });
    });
  };

  const providersCatalogList = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    parseParams(providersCatalogListParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const items = await modelsDevImport(engine).listModelsDevProviders();
      // Same case-insensitive name ordering the ACP-era provider_cli.rs
      // summary produced for the Settings picker.
      const providers = items
        .map((item) => ({ id: item.id, name: item.name, modelCount: item.models.length }))
        .sort((a, b) => {
          const left = a.name.toLowerCase();
          const right = b.name.toLowerCase();
          return left < right ? -1 : left > right ? 1 : 0;
        });
      return asWireJson({ providers });
    });
  };

  const providersCatalogGet = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(providersCatalogGetParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      const item = await modelsDevImport(engine).getModelsDevProvider(params.entryId);
      return asWireJson({
        providerId: item.id,
        name: item.name,
        models: item.models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          maxContextTokens: model.max_context_size,
        })),
      });
    });
  };

  const providersImport = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(providersImportParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
      if (!('providers' in params)) {
        return params.source === 'catalog'
          ? importFromCatalog(engine, params)
          : importFromRegistry(engine, params);
      }
      // M1 direct channel: explicit ProviderInput entries.
      const entries = params.providers.map((entry) => parseProviderImportEntry(entry, request));
      for (const entry of entries) {
        await engine.klient.global.kosong.addProvider(entry.id, entry.input);
      }
      const [first] = entries;
      if (first === undefined) {
        // Unreachable: the protocol schema enforces providers.min(1).
        throw new RuntimeRequestError(
          'invalid_params',
          'providers.import requires at least one provider.',
          false,
        );
      }
      return asWireJson({
        providerId: first.id,
        providers: await listProviderItems(engine),
      });
    });
  };

  return [
    ['config.get', configGet],
    ['config.update', configUpdate],
    ['models.list', modelsList],
    ['providers.list', providersList],
    ['providers.catalog.list', providersCatalogList],
    ['providers.catalog.get', providersCatalogGet],
    ['providers.import', providersImport],
  ];
}

/** The engine's models.dev directory + custom-registry import service. */
function modelsDevImport(engine: EngineContext): IModelsDevImportService {
  return engine.app.accessor.get(IModelsDevImportService);
}

/** Refreshed configured-provider list (engine catalog items pass through). */
async function listProviderItems(engine: EngineContext): Promise<readonly JsonValue[]> {
  const items = await engine.klient.global.kosong.listProviders();
  return items.map((item) => asWireJson({ ...item }));
}

type CatalogImportParams = Extract<ProvidersImportParams, { source: 'catalog' }>;
type RegistryImportParams = Extract<ProvidersImportParams, { source: 'registry' }>;

/**
 * Catalog channel: import a models.dev directory entry as a configured
 * provider (provider record + model aliases land in one engine write). An
 * explicit `defaultModel` is validated against the entry BEFORE the import —
 * same ordering as the CLI's `provider catalog add --default-model` — and
 * applied as the global default model alias afterwards.
 */
async function importFromCatalog(
  engine: EngineContext,
  params: CatalogImportParams,
): Promise<JsonValue> {
  const { entryId, config } = params;
  if (config.baseUrl !== undefined) requireHttpUrl(config.baseUrl, 'baseUrl');
  const service = modelsDevImport(engine);
  if (config.defaultModel !== undefined) {
    const entry = await service.getModelsDevProvider(entryId);
    if (!entry.models.some((model) => model.id === config.defaultModel)) {
      throw new RuntimeRequestError(
        'invalid_params',
        `Model "${config.defaultModel}" is not in catalog entry "${entryId}".`,
        false,
      );
    }
  }
  const imported = await service.importModelsDevProvider({
    catalogId: entryId,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
  if (config.defaultModel !== undefined) {
    await engine.klient.global.kosong.setDefaultModel(
      `${imported.provider.id}/${config.defaultModel}`,
    );
  }
  return asWireJson({
    providerId: imported.provider.id,
    providers: await listProviderItems(engine),
    modelsImported: imported.modelsImported,
  });
}

/**
 * Registry channel: import a custom api.json document. The engine fetches it
 * with the same `fetchCustomRegistry` the CLI's `kimi provider add <url>`
 * uses (GET, `Accept: application/json`, `Authorization: Bearer <key>`) and
 * applies entries with provider records, model aliases, and the `source`
 * refresh blob intact. The bearer key resolves as params → env
 * KIMI_REGISTRY_API_KEY → the stored key of a previous import from the same
 * URL (engine `registryKeyFromExisting`); an absent key simply sends no
 * Authorization header, so protected registries answer 401/403, classified
 * below as `registry_auth_required`.
 */
async function importFromRegistry(
  engine: EngineContext,
  params: RegistryImportParams,
): Promise<JsonValue> {
  requireHttpUrl(params.registryUrl, 'registryUrl');
  const apiKey = params.config?.apiKey ?? process.env['KIMI_REGISTRY_API_KEY'];
  const imported = await modelsDevImport(engine).importCustomRegistry({
    url: params.registryUrl,
    apiKey,
  });
  const [first] = imported.providers;
  if (first === undefined) {
    // Unreachable: the engine rejects empty registries before any write.
    throw new RuntimeRequestError(
      'registry_invalid',
      `Registry at ${params.registryUrl} imported no providers.`,
      false,
    );
  }
  return asWireJson({
    providerId: first.id,
    providers: await listProviderItems(engine),
    modelsImported: imported.modelsImported,
  });
}

/** Desktop hardening kept from provider_cli.rs: only http(s) URLs cross. */
function requireHttpUrl(value: string, label: string): void {
  if (!value.startsWith('https://') && !value.startsWith('http://')) {
    throw new RuntimeRequestError('invalid_params', `${label} must be an http(s) URL.`, false);
  }
}

/**
 * Classify an engine `modelsDev.registry_import_invalid` failure. The engine
 * folds every fetch/parse failure into that one code with the upstream
 * message preserved, so the HTTP status survives only when the registry
 * answered without a JSON error body (`readApiErrorMessage` falls back to a
 * message carrying `HTTP <status>`). A 401/403 with a JSON message body is
 * therefore reported as `registry_unavailable` with the upstream text intact
 * — an engine-contract limitation to lift upstream, not here.
 */
function classifyRegistryError(message: string): string {
  if (/HTTP (401|403)\b/.test(message)) return 'registry_auth_required';
  if (/HTTP \d+/.test(message)) return 'registry_unavailable';
  if (message.includes('no importable providers')) return 'registry_invalid';
  return 'registry_unavailable';
}

function parseParams<S extends z.ZodType>(schema: S, request: RuntimeRequestFrame): z.infer<S> {
  const parsed = schema.safeParse(request.params);
  if (!parsed.success) {
    throw invalidParams(request.method, parsed.error);
  }
  return parsed.data;
}

function parseProviderImportEntry(
  entry: unknown,
  request: RuntimeRequestFrame,
): { readonly id: string; readonly input: ProviderInput } {
  const parsed = providerImportEntrySchema.safeParse(entry);
  if (!parsed.success) {
    throw invalidParams(request.method, parsed.error);
  }
  const { id, ...input } = parsed.data;
  return { id, input };
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
  const engineCode = readEngineErrorCode(error);
  if (engineCode === 'modelsDev.registry_import_invalid') {
    return new RuntimeRequestError(classifyRegistryError(message), message, false);
  }
  const mapped = engineCode === undefined ? undefined : ENGINE_ERROR_CODES[engineCode];
  if (mapped !== undefined) {
    return new RuntimeRequestError(mapped.code, message, mapped.retryable);
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

/** Klient facade values already crossed the transport's JSON round-trip. */
function asWireJson(value: unknown): JsonValue {
  return value as JsonValue;
}
