/**
 * KimiRuntimeAdapter — owns the {@link EngineContext} lifecycle for the
 * runtime process.
 *
 * M1 semantics: `start()` boots the real engine (agent-core-v2 `bootstrap()`
 * + klient memory transport, see ./engine). The protocol server calls it
 * once during `runtime.hello`; a start failure fails the handshake with
 * `engine_start_failed` instead of leaving a half-up process.
 *
 * Close order: every live session this adapter tracks → `klient.close()` →
 * `app.dispose()` (the latter two inside `EngineContext.close()`).
 *
 * Wave-2 attachment points: session-family handlers reach the engine through
 * {@link engineContext}, register live sessions via
 * {@link trackLiveSession}/{@link untrackLiveSession}, and bridge per-session
 * engine events into `RuntimeProtocolServer.emitSessionEvent` following the
 * node-sdk `v2/session-wiring.ts` `SessionEventWiring` pattern.
 */

import { closeSessionById, IConfigService, IKosongConfigService } from '@moonshot-ai/agent-core-v2';

import { createEngineContext, type EngineContext, type EngineContextOptions } from './engine';

export type KimiRuntimeStartOptions = EngineContextOptions;

export interface RuntimeLifecycleAdapter {
  readonly isStarted: boolean;
  start(options: KimiRuntimeStartOptions): Promise<void>;
  close(): Promise<void>;
}

export class KimiRuntimeAdapter implements RuntimeLifecycleAdapter {
  private engine: EngineContext | undefined;
  private readonly liveSessions = new Set<string>();

  get isStarted(): boolean {
    return this.engine !== undefined;
  }

  /** Engine handle for method handlers; undefined before `start()`. */
  get engineContext(): EngineContext | undefined {
    return this.engine;
  }

  async start(options: KimiRuntimeStartOptions = {}): Promise<void> {
    if (this.engine !== undefined) return;
    const engine = createEngineContext(options);
    // Readiness barrier (hoisted from the config family in M1 wave 3): the
    // klient config/catalog reads are synchronous snapshots over state the
    // engine loads asynchronously (config.toml load, then kosong provider /
    // model hydration), so the handshake must not complete until both
    // services report ready. A barrier failure tears the half-up engine down
    // before the error reaches the handshake as `engine_start_failed`.
    try {
      await Promise.all([
        engine.app.accessor.get(IConfigService).ready,
        engine.app.accessor.get(IKosongConfigService).ready,
      ]).then(() => undefined);
    } catch (error) {
      await engine.close().catch(() => undefined);
      throw error;
    }
    this.engine = engine;
  }

  trackLiveSession(sessionId: string): void {
    this.liveSessions.add(sessionId);
  }

  untrackLiveSession(sessionId: string): void {
    this.liveSessions.delete(sessionId);
  }

  async close(): Promise<void> {
    const engine = this.engine;
    this.engine = undefined;
    if (engine === undefined) return;
    // Live sessions close before the klient/scope teardown. Closing a
    // session the engine already dropped is a no-op (`closeSessionById`
    // ignores unknown ids); a single broken session must not wedge teardown.
    for (const sessionId of this.liveSessions) {
      try {
        await closeSessionById(engine.app.accessor, sessionId);
      } catch {
        // best-effort — teardown proceeds regardless
      }
    }
    this.liveSessions.clear();
    await engine.close();
  }
}
