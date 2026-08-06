import type { RuntimeLifecycleAdapter } from './kimi-runtime-adapter';
import {
  RUNTIME_PROTOCOL,
  RuntimeProtocolFault,
  RuntimeRequestError,
  errorResponse,
  okResponse,
  parseHelloParams,
  parseRequestFrame,
  runtimeInfo,
  type JsonValue,
  type RuntimeEventFrame,
  type RuntimeOutputFrame,
} from './protocol';

type RuntimeState = 'awaiting-hello' | 'ready' | 'shutting-down' | 'stopped';

const RECENT_REQUEST_ID_LIMIT = 4096;

export interface RuntimeProtocolServerOptions {
  readonly adapter: RuntimeLifecycleAdapter;
  readonly emitFrame: (frame: RuntimeOutputFrame) => void | Promise<void>;
}

export class RuntimeProtocolServer {
  private readonly adapter: RuntimeLifecycleAdapter;
  private readonly emitFrame: RuntimeProtocolServerOptions['emitFrame'];
  private readonly recentRequestIds = new Set<string>();
  private readonly requestIdOrder: string[] = [];
  private readonly sessionSequences = new Map<string, number>();
  private state: RuntimeState = 'awaiting-hello';
  private shutdownRequestId: string | undefined;
  private outputTail: Promise<void> = Promise.resolve();
  private outputClosed = false;

  constructor(options: RuntimeProtocolServerOptions) {
    this.adapter = options.adapter;
    this.emitFrame = options.emitFrame;
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
      switch (request.method) {
        case 'runtime.hello': {
          if (this.state !== 'awaiting-hello') {
            throw new RuntimeRequestError(
              'handshake_already_completed',
              'runtime.hello has already completed.',
            );
          }
          parseHelloParams(request.params);
          this.state = 'ready';
          await this.write(okResponse(request.id, runtimeInfo()));
          return;
        }
        case 'runtime.getInfo': {
          await this.write(okResponse(request.id, runtimeInfo()));
          return;
        }
        case 'runtime.shutdown': {
          this.state = 'shutting-down';
          this.shutdownRequestId = request.id;
          return;
        }
        default: {
          throw new RuntimeRequestError(
            'method_not_found',
            `Unknown runtime method: ${request.method}`,
          );
        }
      }
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
  ): Promise<RuntimeEventFrame> {
    if (this.state !== 'ready') {
      throw new RuntimeRequestError('runtime_not_ready', 'Runtime handshake is not ready.');
    }
    if (sessionId.length === 0 || event.length === 0) {
      throw new RuntimeRequestError(
        'invalid_event',
        'Session events require a non-empty sessionId and event name.',
      );
    }
    const seq = (this.sessionSequences.get(sessionId) ?? 0) + 1;
    this.sessionSequences.set(sessionId, seq);
    const frame: RuntimeEventFrame = {
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

  async completeShutdown(closeTimeoutMs = 0): Promise<void> {
    if (this.state !== 'shutting-down' || this.shutdownRequestId === undefined) {
      throw new RuntimeProtocolFault(
        'shutdown_not_requested',
        'Runtime shutdown cannot complete before runtime.shutdown.',
      );
    }
    const requestId = this.shutdownRequestId;
    await waitAtMost(this.adapter.close(), closeTimeoutMs);
    this.outputClosed = true;
    this.state = 'stopped';
    await this.enqueue(okResponse(requestId, { shuttingDown: true }));
  }

  private reject(id: string, error: RuntimeRequestError): Promise<void> {
    return this.write(errorResponse(id, error));
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
