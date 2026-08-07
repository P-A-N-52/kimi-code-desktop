import { createAuthHandlers } from './auth-router';
import { createConfigHandlers } from './config-router';
import { attachSessionEvents } from './event-bridge';
import type { RuntimeEngineAdapter, RuntimeHandlerContext } from './handler-context';
import type { RuntimeLifecycleAdapter } from './kimi-runtime-adapter';
import {
  DESKTOP_RUNTIME_VERSION,
  RUNTIME_EVENT_PREFIX,
  RUNTIME_PROTOCOL,
  RuntimeProtocolFault,
  RuntimeRequestError,
  SESSION_EVENT_NAMES,
  errorResponse,
  okResponse,
  parseHelloParams,
  parseRequestFrame,
  runtimeInfo,
  type JsonValue,
  type RuntimeOutputFrame,
  type RuntimeRequestFrame,
  type RuntimeScopedEventFrame,
  type RuntimeSessionEventFrame,
} from './protocol';
import { createReplayHandlers } from './replay-router';
import { DEFERRED_RESPONSE, MethodRouter } from './router';
import { createForkSessionHandler, createSessionHandlers } from './session-manager';
import { clearActiveTurns, createTurnHandlers } from './turn-router';

type RuntimeState = 'awaiting-hello' | 'ready' | 'shutting-down' | 'stopped';

const RECENT_REQUEST_ID_LIMIT = 4096;

/**
 * The adapter the protocol server runs on: lifecycle (start/close) plus the
 * engine surface the method families consume. `KimiRuntimeAdapter` is the
 * production implementation.
 */
export type RuntimeServerAdapter = RuntimeLifecycleAdapter & RuntimeEngineAdapter;

/**
 * Every family is wired end to end as of M3 wave 3: the M1 families
 * (sessions/turns/config) plus the parity families — replay
 * (replay-router.ts), auth + usage (auth-router.ts), and whole-session fork
 * (session-manager.ts `createForkSessionHandler`). The `fork` gate covers
 * whole-session forks only: a `turnIndex` param is permanently answered
 * `fork_turn_unsupported` until an engine with turn-granular fork lands.
 * `events` advertises the full SESSION_EVENT_NAMES set — 24 events emitted
 * by the Node bridge plus `background_task.observed`, which the Rust
 * translate layer synthesizes from `tool.completed` (same side as the ACP
 * era), so the Desktop still receives every advertised event.
 */
const WIRED_FAMILIES = {
  sessions: true,
  turns: true,
  config: true,
  replay: true,
  auth: true,
  usage: true,
  fork: true,
  events: SESSION_EVENT_NAMES,
} as const;

export interface RuntimeProtocolServerOptions {
  readonly adapter: RuntimeServerAdapter;
  readonly emitFrame: (frame: RuntimeOutputFrame) => void | Promise<void>;
}

export class RuntimeProtocolServer {
  private readonly adapter: RuntimeServerAdapter;
  private readonly emitFrame: RuntimeProtocolServerOptions['emitFrame'];
  private readonly router = new MethodRouter();
  private readonly recentRequestIds = new Set<string>();
  private readonly requestIdOrder: string[] = [];
  private readonly sessionSequences = new Map<string, number>();
  /** Live event-bridge detach functions, one per opened session. */
  private readonly sessionBridges = new Map<string, () => Promise<void>>();
  private state: RuntimeState = 'awaiting-hello';
  private shutdownRequestId: string | undefined;
  private outputTail: Promise<void> = Promise.resolve();
  private outputClosed = false;

  constructor(options: RuntimeProtocolServerOptions) {
    this.adapter = options.adapter;
    this.emitFrame = options.emitFrame;
    this.router.register('runtime.hello', (request) => this.handleHello(request));
    this.router.register('runtime.getInfo', () =>
      Promise.resolve(runtimeInfo(this.router.methods, WIRED_FAMILIES)),
    );
    this.router.register('runtime.shutdown', (request) => {
      this.state = 'shutting-down';
      this.shutdownRequestId = request.id;
      return Promise.resolve(DEFERRED_RESPONSE);
    });

    // All method families share one handler context. Session hooks bridge
    // the families without cross-imports: opening a session attaches its
    // event bridge, closing one detaches the bridge (a session that was
    // never attached is a no-op) and drops its active-turn registration.
    const ctx: RuntimeHandlerContext = {
      adapter: this.adapter,
      emitSessionEvent: (sessionId, event, payload) =>
        this.emitSessionEvent(sessionId, event, payload),
      emitRuntimeEvent: (event, payload) => this.emitRuntimeEvent(event, payload),
      sessionHooks: {
        onSessionOpened: async (sessionId, engine) => {
          const detach = await attachSessionEvents(engine, sessionId, (id, event, payload) =>
            this.emitSessionEvent(id, event, payload),
          );
          this.sessionBridges.set(sessionId, detach);
        },
        onSessionClosed: async (sessionId) => {
          const detach = this.sessionBridges.get(sessionId);
          this.sessionBridges.delete(sessionId);
          if (detach !== undefined) await detach();
          const engine = this.adapter.engineContext;
          if (engine !== undefined) clearActiveTurns(engine, sessionId);
        },
      },
    };
    for (const [method, handler] of [
      ...createSessionHandlers(ctx),
      // Fork is a single handler entry exported separately from the sessions
      // family (it landed in M3 wave 2 alongside the family).
      createForkSessionHandler(ctx),
      ...createTurnHandlers(ctx),
      ...createConfigHandlers(ctx),
      // M3 parity families, wired for real in wave 3 (no placeholders left).
      ...createReplayHandlers(ctx),
      ...createAuthHandlers(ctx),
    ]) {
      this.router.register(method, handler);
    }
  }

  get shutdownRequested(): boolean {
    return this.state === 'shutting-down';
  }

  async accept(value: unknown): Promise<void> {
    const request = parseRequestFrame(value);
    if (this.recentRequestIds.has(request.id)) {
      throw new RuntimeProtocolFault(
        'duplicate_request_id',
        'Runtime request ids must not be reused.',
      );
    }
    this.rememberRequestId(request.id);

    if (this.state === 'shutting-down' || this.state === 'stopped') {
      await this.reject(
        request.id,
        new RuntimeRequestError('runtime_shutting_down', 'Runtime is shutting down.'),
      );
      return;
    }
    if (this.state === 'awaiting-hello' && request.method !== 'runtime.hello') {
      await this.reject(
        request.id,
        new RuntimeRequestError(
          'handshake_required',
          'runtime.hello must be the first accepted request.',
        ),
      );
      return;
    }

    try {
      const result = await this.router.dispatch(request);
      if (result === DEFERRED_RESPONSE) return;
      if (request.method === 'runtime.hello') {
        // The handshake response and the runtime.ready event are enqueued as
        // an adjacent pair: both chain onto outputTail in this synchronous
        // window, so concurrently accepted requests cannot interleave their
        // own writes between them. The handshake response goes first.
        const responseWrite = this.write(okResponse(request.id, result));
        const readyWrite = this.emitRuntimeEvent('runtime.ready', {
          runtimeVersion: DESKTOP_RUNTIME_VERSION,
        });
        await Promise.all([responseWrite, readyWrite]);
        return;
      }
      await this.write(okResponse(request.id, result));
    } catch (error) {
      const requestError =
        error instanceof RuntimeRequestError
          ? error
          : new RuntimeRequestError('internal_error', 'Runtime request failed.');
      await this.reject(request.id, requestError);
    }
  }

  async emitSessionEvent(
    sessionId: string,
    event: string,
    payload: JsonValue = {},
  ): Promise<RuntimeSessionEventFrame> {
    this.assertEventsFlowing();
    if (sessionId.length === 0 || event.length === 0) {
      throw new RuntimeRequestError(
        'invalid_event',
        'Session events require a non-empty sessionId and event name.',
      );
    }
    if (event.startsWith(RUNTIME_EVENT_PREFIX)) {
      throw new RuntimeRequestError(
        'invalid_event',
        `Session events must not use the "${RUNTIME_EVENT_PREFIX}" prefix; use emitRuntimeEvent.`,
      );
    }
    const seq = (this.sessionSequences.get(sessionId) ?? 0) + 1;
    this.sessionSequences.set(sessionId, seq);
    const frame: RuntimeSessionEventFrame = {
      protocol: RUNTIME_PROTOCOL,
      type: 'event',
      sessionId,
      seq,
      event,
      payload,
    };
    await this.write(frame);
    return frame;
  }

  /**
   * Emit a runtime-scoped event (`runtime.ready` / `runtime.warning`). These
   * belong to no session: no sessionId, no seq, and the event name must carry
   * the `runtime.` prefix.
   */
  async emitRuntimeEvent(
    event: string,
    payload: JsonValue = {},
  ): Promise<RuntimeScopedEventFrame> {
    this.assertEventsFlowing();
    if (!event.startsWith(RUNTIME_EVENT_PREFIX) || event.length === RUNTIME_EVENT_PREFIX.length) {
      throw new RuntimeRequestError(
        'invalid_event',
        `Runtime events must use the "${RUNTIME_EVENT_PREFIX}" prefix.`,
      );
    }
    const frame: RuntimeScopedEventFrame = {
      protocol: RUNTIME_PROTOCOL,
      type: 'event',
      event,
      payload,
    };
    await this.write(frame);
    return frame;
  }

  async completeShutdown(closeTimeoutMs = 0): Promise<void> {
    if (this.state !== 'shutting-down' || this.shutdownRequestId === undefined) {
      throw new RuntimeProtocolFault(
        'shutdown_not_requested',
        'Runtime shutdown cannot complete before runtime.shutdown.',
      );
    }
    const requestId = this.shutdownRequestId;
    // Session hooks only fire on the explicit session.close/delete paths, so
    // sessions the adapter tears down directly would leak their event bridge.
    // Detach any survivors here — server-side, because the bridge registry
    // lives here — before the adapter disposes the engine scope the bridges
    // subscribed to. Detach is idempotent and best-effort.
    for (const detach of this.sessionBridges.values()) {
      await detach().catch(() => undefined);
    }
    this.sessionBridges.clear();
    await waitAtMost(this.adapter.close(), closeTimeoutMs);
    this.outputClosed = true;
    this.state = 'stopped';
    await this.enqueue(okResponse(requestId, { shuttingDown: true }));
  }

  private async handleHello(request: RuntimeRequestFrame): Promise<JsonValue> {
    if (this.state !== 'awaiting-hello') {
      throw new RuntimeRequestError(
        'handshake_already_completed',
        'runtime.hello has already completed.',
      );
    }
    parseHelloParams(request.params);
    // M1: the handshake boots the real engine. `dataRoot` is the Desktop data
    // root, not the Kimi home — the engine resolves its home itself
    // (explicit option → KIMI_CODE_HOME → ~/.kimi-code).
    try {
      await this.adapter.start({});
    } catch (error) {
      throw new RuntimeRequestError(
        'engine_start_failed',
        `Kimi engine failed to start: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    this.state = 'ready';
    return runtimeInfo(this.router.methods, WIRED_FAMILIES);
  }

  private reject(id: string, error: RuntimeRequestError): Promise<void> {
    return this.write(errorResponse(id, error));
  }

  /**
   * Events flow once the handshake completed and keep flowing during the
   * shutdown drain — in-flight turns still deliver terminal events there,
   * and hello's own runtime.ready emission can interleave with a
   * concurrently accepted runtime.shutdown.
   */
  private assertEventsFlowing(): void {
    if (this.state !== 'ready' && this.state !== 'shutting-down') {
      throw new RuntimeRequestError('runtime_not_ready', 'Runtime handshake is not ready.');
    }
  }

  private write(frame: RuntimeOutputFrame): Promise<void> {
    if (this.outputClosed) {
      return Promise.reject(
        new RuntimeProtocolFault('runtime_stopped', 'Runtime output is already closed.'),
      );
    }
    return this.enqueue(frame);
  }

  private enqueue(frame: RuntimeOutputFrame): Promise<void> {
    const pending = this.outputTail.then(() => this.emitFrame(frame));
    this.outputTail = pending.catch(() => undefined);
    return pending;
  }

  private rememberRequestId(id: string): void {
    this.recentRequestIds.add(id);
    this.requestIdOrder.push(id);
    if (this.requestIdOrder.length <= RECENT_REQUEST_ID_LIMIT) return;
    const oldest = this.requestIdOrder.shift();
    if (oldest !== undefined) this.recentRequestIds.delete(oldest);
  }
}

async function waitAtMost(pending: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    void pending.catch(() => undefined);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  let result: 'completed' | 'timeout';
  try {
    result = await Promise.race([pending.then(() => 'completed' as const), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (result === 'timeout') void pending.catch(() => undefined);
}
