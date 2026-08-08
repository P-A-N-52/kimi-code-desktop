/**
 * runtime-v1 config family — method handlers over the klient global facade.
 *
 * Covers CONFIG_FAMILY_METHODS: `config.get` / `config.update` read and write
 * the layered config service (`global.config.get/getAll/set`),
 * `models.list` / `providers.list` enumerate the kosong catalog
 * (`global.kosong.listModels/listProviders`), and `providers.import` adds
 * named providers through `global.kosong.addProvider`. Params are validated
 * against the protocol schemas first; `providers.import` then tightens the
 * draft wire shape to the klient `ProviderInput` contract. Failures map to
 * structured, non-retryable errors: `invalid_params` for rejected params,
 * `*_not_found` for engine not-found codes, `internal_error` for every other
 * engine failure.
 *
 * The klient config/catalog read paths are synchronous snapshots over state
 * the engine loads asynchronously (config.toml load, then kosong provider /
 * model hydration). The readiness barrier (`IConfigService.ready` +
 * `IKosongConfigService.ready`) lives in engine start
 * (`KimiRuntimeAdapter.start`), so the handshake only completes once those
 * snapshots are whole and no per-handler wait remains here.
 */

import { KlientValidationError, type ProviderInput } from '@moonshot-ai/klient';
import { z } from 'zod';

import {
  requireEngineContext,
  type RuntimeHandlerContext,
  type RuntimeHandlerEntry,
} from './handler-context';
import {
  RuntimeRequestError,
  configGetParamsSchema,
  configUpdateParamsSchema,
  modelsListParamsSchema,
  providersImportParamsSchema,
  providersListParamsSchema,
  type JsonValue,
  type RuntimeRequestFrame,
} from './protocol';

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
const ENGINE_NOT_FOUND_CODES: Readonly<Record<string, string>> = {
  'provider.not_found': 'provider_not_found',
  'model.not_found': 'model_not_found',
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

  const providersImport = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(providersImportParamsSchema, request);
    const engine = requireEngineContext(ctx);
    return runEngine(async () => {
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
      const items = await engine.klient.global.kosong.listProviders();
      return asWireJson({
        providerId: first.id,
        providers: items.map((item) => ({ ...item })),
      });
    });
  };

  return [
    ['config.get', configGet],
    ['config.update', configUpdate],
    ['models.list', modelsList],
    ['providers.list', providersList],
    ['providers.import', providersImport],
  ];
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
  const mapped = engineCode === undefined ? undefined : ENGINE_NOT_FOUND_CODES[engineCode];
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

/** Klient facade values already crossed the transport's JSON round-trip. */
function asWireJson(value: unknown): JsonValue {
  return value as JsonValue;
}
