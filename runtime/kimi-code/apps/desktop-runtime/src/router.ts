/**
 * runtime-v1 method router — a plain registry behind `dispatch()`.
 *
 * Unregistered methods answer a structured `method_not_found`. The capability
 * snapshot mirrors `methods`, so what is registered here is exactly what the
 * handshake advertises.
 */

import {
  RuntimeRequestError,
  type JsonValue,
  type RuntimeRequestFrame,
} from './protocol';

/**
 * Handler result marker telling the server not to write a response frame.
 * `runtime.shutdown` uses it: its response is deferred until the drain
 * completes (`completeShutdown`).
 */
export const DEFERRED_RESPONSE: unique symbol = Symbol('runtime.deferred-response');
export type DeferredResponse = typeof DEFERRED_RESPONSE;

export type RuntimeMethodHandler = (
  request: RuntimeRequestFrame,
) => Promise<JsonValue | DeferredResponse>;

export class MethodRouter {
  private readonly handlers = new Map<string, RuntimeMethodHandler>();

  register(method: string, handler: RuntimeMethodHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`runtime-v1 method ${method} is already registered.`);
    }
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  /** Registered method names in registration order. */
  get methods(): readonly string[] {
    return [...this.handlers.keys()];
  }

  async dispatch(request: RuntimeRequestFrame): Promise<JsonValue | DeferredResponse> {
    const handler = this.handlers.get(request.method);
    if (handler === undefined) {
      throw new RuntimeRequestError(
        'method_not_found',
        `Unknown runtime method: ${request.method}`,
      );
    }
    return handler(request);
  }
}
