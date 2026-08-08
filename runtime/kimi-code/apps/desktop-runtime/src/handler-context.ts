/**
 * Shared context handed to every runtime-v1 method-family factory.
 *
 * Each M1 family (sessions / turns / config) lives in its own module and
 * exports a factory `create*Handlers(ctx)` returning handler entries. The
 * protocol server registers them in its constructor — family modules never
 * touch server.ts.
 */

import type { EngineContext } from './engine';
import { RuntimeRequestError, type JsonValue, type RuntimeV1Method } from './protocol';
import type { RuntimeMethodHandler } from './router';

/**
 * The slice of the engine-owning adapter the method families need. Structural
 * on purpose: `KimiRuntimeAdapter` satisfies it in production, and tests can
 * substitute a lighter fake without extending the concrete class.
 */
export interface RuntimeEngineAdapter {
  readonly engineContext: EngineContext | undefined;
  trackLiveSession(sessionId: string): void;
  untrackLiveSession(sessionId: string): void;
}

export interface RuntimeSessionHooks {
  /**
   * Fired by the sessions family when `session.open` succeeds (engine session
   * live, adapter tracking registered). The turns family uses this to attach
   * its event bridge; wired by server composition, not by cross-family imports.
   */
  readonly onSessionOpened?: (sessionId: string, engine: EngineContext) => void | Promise<void>;
  /** Fired when `session.close` succeeds or a live session is torn down. */
  readonly onSessionClosed?: (sessionId: string) => void | Promise<void>;
}

export interface RuntimeHandlerContext {
  readonly adapter: RuntimeEngineAdapter;
  readonly emitSessionEvent: (
    sessionId: string,
    event: string,
    payload?: JsonValue,
  ) => Promise<unknown>;
  readonly emitRuntimeEvent: (event: string, payload?: JsonValue) => Promise<unknown>;
  readonly sessionHooks?: RuntimeSessionHooks;
}

export type RuntimeHandlerEntry = readonly [RuntimeV1Method, RuntimeMethodHandler];

/**
 * Every non-runtime method requires a booted engine. After the handshake this
 * is always satisfied; the guard exists so a handler fails structurally
 * instead of dereferencing `undefined` if that invariant ever breaks.
 */
export function requireEngineContext(ctx: RuntimeHandlerContext): EngineContext {
  const engine = ctx.adapter.engineContext;
  if (engine === undefined) {
    throw new RuntimeRequestError(
      'engine_not_available',
      'Kimi engine is not started; complete runtime.hello first.',
      false,
    );
  }
  return engine;
}
