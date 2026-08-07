export const RUNTIME_PROTOCOL = 'runtime-v1' as const;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const DESKTOP_RUNTIME_VERSION = '0.0.0';
export const KIMI_SOURCE_TAG = '@moonshot-ai/kimi-code@0.33.0';
export const KIMI_SOURCE_COMMIT = '53c832dfdf9566afd59a8b3d54ebd36d3cb03d72';
export const DATA_SCHEMA_VERSION = 1;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface RuntimeRequestFrame {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: 'request';
  readonly id: string;
  readonly method: string;
  readonly sessionId?: string;
  readonly params: JsonObject;
}

export interface RuntimeErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

export type RuntimeResponseFrame =
  | {
      readonly protocol: typeof RUNTIME_PROTOCOL;
      readonly type: 'response';
      readonly id: string;
      readonly ok: true;
      readonly result: JsonValue;
    }
  | {
      readonly protocol: typeof RUNTIME_PROTOCOL;
      readonly type: 'response';
      readonly id: string;
      readonly ok: false;
      readonly error: RuntimeErrorBody;
    };

export interface RuntimeEventFrame {
  readonly protocol: typeof RUNTIME_PROTOCOL;
  readonly type: 'event';
  readonly sessionId: string;
  readonly seq: number;
  readonly event: string;
  readonly payload: JsonValue;
}

export type RuntimeOutputFrame = RuntimeResponseFrame | RuntimeEventFrame;

export interface RuntimeHelloParams extends JsonObject {
  readonly desktopVersion: string;
  readonly supportedProtocols: readonly string[];
  readonly dataRoot: string;
  readonly platform: string;
  readonly arch: string;
  readonly locale: string;
}

export interface RuntimeInfo extends JsonObject {
  readonly selectedProtocol: typeof RUNTIME_PROTOCOL;
  readonly runtimeVersion: string;
  readonly kimiSource: {
    readonly tag: string;
    readonly commit: string;
  };
  readonly nodeVersion: string;
  readonly capabilities: {
    readonly methods: readonly string[];
    readonly sessions: false;
    readonly turns: false;
    readonly config: false;
  };
  readonly dataSchemaVersion: number;
}

export class RuntimeProtocolFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeProtocolFault';
  }
}

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'RuntimeRequestError';
  }
}

export function runtimeInfo(): RuntimeInfo {
  return {
    selectedProtocol: RUNTIME_PROTOCOL,
    runtimeVersion: DESKTOP_RUNTIME_VERSION,
    kimiSource: {
      tag: KIMI_SOURCE_TAG,
      commit: KIMI_SOURCE_COMMIT,
    },
    nodeVersion: process.versions.node,
    capabilities: {
      methods: ['runtime.hello', 'runtime.getInfo', 'runtime.shutdown'],
      sessions: false,
      turns: false,
      config: false,
    },
    dataSchemaVersion: DATA_SCHEMA_VERSION,
  };
}

export function parseRequestFrame(value: unknown): RuntimeRequestFrame {
  if (!isJsonObject(value)) {
    throw new RuntimeProtocolFault('invalid_envelope', 'Runtime frame must be a JSON object.');
  }
  if (value['protocol'] !== RUNTIME_PROTOCOL) {
    throw new RuntimeProtocolFault(
      'protocol_mismatch',
      `Expected protocol ${RUNTIME_PROTOCOL}.`,
    );
  }
  if (value['type'] !== 'request') {
    throw new RuntimeProtocolFault('invalid_envelope_type', 'Runtime input must be a request.');
  }
  const id = requiredString(value['id'], 'id');
  const method = requiredString(value['method'], 'method');
  const sessionId = optionalString(value['sessionId'], 'sessionId');
  const params = value['params'] === undefined ? {} : value['params'];
  if (!isJsonObject(params)) {
    throw new RuntimeProtocolFault('invalid_params', 'Request params must be a JSON object.');
  }
  return {
    protocol: RUNTIME_PROTOCOL,
    type: 'request',
    id,
    method,
    sessionId,
    params,
  };
}

export function parseHelloParams(params: JsonObject): RuntimeHelloParams {
  const supportedProtocols = params['supportedProtocols'];
  if (
    !Array.isArray(supportedProtocols) ||
    !supportedProtocols.every((protocol) => typeof protocol === 'string')
  ) {
    throw new RuntimeRequestError(
      'invalid_params',
      'runtime.hello requires supportedProtocols as a string array.',
    );
  }
  if (!supportedProtocols.includes(RUNTIME_PROTOCOL)) {
    throw new RuntimeRequestError(
      'protocol_mismatch',
      `Desktop does not advertise support for ${RUNTIME_PROTOCOL}.`,
    );
  }
  return {
    desktopVersion: requestString(params['desktopVersion'], 'desktopVersion'),
    supportedProtocols,
    dataRoot: requestString(params['dataRoot'], 'dataRoot'),
    platform: requestString(params['platform'], 'platform'),
    arch: requestString(params['arch'], 'arch'),
    locale: requestString(params['locale'], 'locale'),
  };
}

export function errorResponse(id: string, error: RuntimeRequestError): RuntimeResponseFrame {
  return {
    protocol: RUNTIME_PROTOCOL,
    type: 'response',
    id,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
  };
}

export function okResponse(id: string, result: JsonValue): RuntimeResponseFrame {
  return {
    protocol: RUNTIME_PROTOCOL,
    type: 'response',
    id,
    ok: true,
    result,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeProtocolFault('invalid_envelope', `Request ${field} must be non-empty.`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeProtocolFault('invalid_envelope', `Request ${field} must be non-empty.`);
  }
  return value;
}

function requestString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeRequestError('invalid_params', `runtime.hello requires ${field}.`);
  }
  return value;
}
