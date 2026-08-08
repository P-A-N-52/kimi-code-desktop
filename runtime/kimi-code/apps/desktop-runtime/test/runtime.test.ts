import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { decodeJsonLines } from '../src/codec';
import type { EngineContext } from '../src/engine';
import type { RuntimeEngineAdapter } from '../src/handler-context';
import type {
  KimiRuntimeStartOptions,
  RuntimeLifecycleAdapter,
} from '../src/kimi-runtime-adapter';
import {
  KIMI_SOURCE_COMMIT,
  RUNTIME_PROTOCOL,
  RUNTIME_SCOPED_EVENTS,
  RUNTIME_V1_METHODS,
  SESSION_EVENT_NAMES,
  runtimeEventPayloadSchemas,
  runtimeMethodSchemas,
  sessionEventPayloadSchemas,
  turnStartParamsSchema,
  type RuntimeOutputFrame,
} from '../src/protocol';
import { RuntimeProtocolServer } from '../src/server';
import { runStdioRuntime } from '../src/stdio';

class FakeAdapter implements RuntimeLifecycleAdapter, RuntimeEngineAdapter {
  isStarted = false;
  closeCalls = 0;
  startCalls = 0;

  get engineContext(): EngineContext | undefined {
    return undefined;
  }

  trackLiveSession(_sessionId: string): void {}

  untrackLiveSession(_sessionId: string): void {}

  async start(_options: KimiRuntimeStartOptions): Promise<void> {
    this.isStarted = true;
    this.startCalls += 1;
  }

  async close(): Promise<void> {
    this.isStarted = false;
    this.closeCalls += 1;
  }
}

function hello(id = 'hello-1'): object {
  return {
    protocol: RUNTIME_PROTOCOL,
    type: 'request',
    id,
    method: 'runtime.hello',
    params: {
      desktopVersion: '1.0.0-test',
      supportedProtocols: [RUNTIME_PROTOCOL],
      dataRoot: 'test-data-root',
      platform: 'test',
      arch: 'test',
      locale: 'en-US',
    },
  };
}

function request(id: string, method: string): object {
  return { protocol: RUNTIME_PROTOCOL, type: 'request', id, method, params: {} };
}

function setup(): {
  readonly adapter: FakeAdapter;
  readonly frames: RuntimeOutputFrame[];
  readonly server: RuntimeProtocolServer;
} {
  const adapter = new FakeAdapter();
  const frames: RuntimeOutputFrame[] = [];
  return {
    adapter,
    frames,
    server: new RuntimeProtocolServer({
      adapter,
      emitFrame: (frame) => {
        frames.push(frame);
      },
    }),
  };
}

describe('runtime-v1 server', () => {
  it('requires hello before other methods', async () => {
    const { frames, server } = setup();
    await server.accept(request('info-early', 'runtime.getInfo'));
    expect(frames).toMatchObject([
      { id: 'info-early', ok: false, error: { code: 'handshake_required' } },
    ]);
  });

  it('starts the engine adapter on hello and announces runtime.ready', async () => {
    const { adapter, frames, server } = setup();
    await server.accept(hello());
    await server.accept(request('info-1', 'runtime.getInfo'));
    expect(adapter.isStarted).toBe(true);
    expect(adapter.startCalls).toBe(1);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      id: 'hello-1',
      ok: true,
      result: { selectedProtocol: RUNTIME_PROTOCOL, kimiSource: { commit: KIMI_SOURCE_COMMIT } },
    });
    // Runtime-scoped events carry no sessionId/seq.
    expect(frames[1]).toMatchObject({ type: 'event', event: 'runtime.ready' });
    expect(frames[1]).not.toHaveProperty('sessionId');
    expect(frames[1]).not.toHaveProperty('seq');
    expect(frames[2]).toMatchObject({ id: 'info-1', ok: true });
  });

  it('fails hello with engine_start_failed when the adapter cannot start', async () => {
    const adapter = new FakeAdapter();
    adapter.start = () => Promise.reject(new Error('boom'));
    const frames: RuntimeOutputFrame[] = [];
    const server = new RuntimeProtocolServer({
      adapter,
      emitFrame: (frame) => {
        frames.push(frame);
      },
    });
    await server.accept(hello());
    expect(frames).toMatchObject([
      { id: 'hello-1', ok: false, error: { code: 'engine_start_failed', retryable: false } },
    ]);
    // A failed handshake leaves the server in awaiting-hello: the next
    // non-hello request is still rejected as before.
    await server.accept(request('info-after-fail', 'runtime.getInfo'));
    expect(frames[1]).toMatchObject({
      id: 'info-after-fail',
      ok: false,
      error: { code: 'handshake_required' },
    });
  });

  it('wires every runtime-v1 method to a real handler and rejects unknown methods', async () => {
    const { frames, server } = setup();
    await server.accept(hello());
    // No skeleton remains: with the fake adapter the sessions probe reaches
    // the real family handler and fails structurally on the missing engine —
    // never with not_implemented.
    await server.accept(request('list-1', 'sessions.list'));
    await server.accept(request('unknown-1', 'runtime.missing'));
    expect(frames[2]).toMatchObject({
      id: 'list-1',
      ok: false,
      error: { code: 'engine_not_available', retryable: false },
    });
    expect(frames[3]).toMatchObject({
      id: 'unknown-1',
      ok: false,
      error: { code: 'method_not_found', retryable: false },
    });
    await expect(server.accept(request('unknown-1', 'runtime.getInfo'))).rejects.toMatchObject({
      code: 'duplicate_request_id',
    });
    expect(frames).toHaveLength(4);
  });

  it('advertises every registered method and all wired families in the capability snapshot', async () => {
    const { frames, server } = setup();
    await server.accept(hello());
    expect(frames[0]).toMatchObject({
      result: {
        capabilities: {
          methods: [...RUNTIME_V1_METHODS],
          sessions: true,
          turns: true,
          config: true,
        },
      },
    });
  });

  it('maintains isolated monotonic event sequences per session', async () => {
    const { frames, server } = setup();
    await server.accept(hello());
    await server.emitSessionEvent('session-a', 'content.delta', { text: 'a' });
    await server.emitSessionEvent('session-b', 'content.delta', { text: 'b' });
    await server.emitSessionEvent('session-a', 'turn.completed', { requestId: 'turn-1' });
    expect(frames.slice(2)).toMatchObject([
      { sessionId: 'session-a', seq: 1 },
      { sessionId: 'session-b', seq: 1 },
      { sessionId: 'session-a', seq: 2 },
    ]);
  });

  it('keeps runtime and session event namespaces disjoint', async () => {
    const { frames, server } = setup();
    await server.accept(hello());
    await server.emitRuntimeEvent('runtime.warning', { code: 'w', message: 'm' });
    expect(frames[2]).toMatchObject({ type: 'event', event: 'runtime.warning' });
    expect(frames[2]).not.toHaveProperty('sessionId');
    await expect(server.emitRuntimeEvent('content.delta')).rejects.toMatchObject({
      code: 'invalid_event',
    });
    await expect(server.emitSessionEvent('session-a', 'runtime.ready')).rejects.toMatchObject({
      code: 'invalid_event',
    });
  });

  it('rejects buffered requests and acknowledges shutdown last', async () => {
    const { adapter, frames, server } = setup();
    await server.accept(hello());
    await server.accept(request('shutdown-1', 'runtime.shutdown'));
    await server.accept(request('after-shutdown', 'runtime.getInfo'));
    expect(adapter.closeCalls).toBe(0);
    expect(server.shutdownRequested).toBe(true);
    expect(frames[2]).toMatchObject({
      id: 'after-shutdown',
      ok: false,
      error: { code: 'runtime_shutting_down' },
    });
    await server.completeShutdown();
    expect(adapter.closeCalls).toBe(1);
    expect(frames[3]).toMatchObject({ id: 'shutdown-1', ok: true });
  });

  it('completes shutdown after a bounded drain when stdin stays open', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let closeCalls = 0;
    const adapter: RuntimeLifecycleAdapter & RuntimeEngineAdapter = {
      isStarted: false,
      engineContext: undefined,
      trackLiveSession(): void {},
      untrackLiveSession(): void {},
      async start(): Promise<void> {},
      close(): Promise<void> {
        closeCalls += 1;
        return new Promise<void>(() => undefined);
      },
    };
    let stdout = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const exitCode = runStdioRuntime({
      input,
      output,
      diagnostics,
      adapter,
      shutdownDrainMs: 5,
    });
    input.write(`${JSON.stringify(hello())}\n`);
    input.write(`${JSON.stringify(request('shutdown-1', 'runtime.shutdown'))}\n`);

    await expect(exitCode).resolves.toBe(0);
    expect(closeCalls).toBe(1);
    expect(stdout.trim().split('\n').map((line) => JSON.parse(line))).toMatchObject([
      { id: 'hello-1', ok: true },
      { type: 'event', event: 'runtime.ready' },
      { id: 'shutdown-1', ok: true },
    ]);
  });

  it('rejects JSONL frames over the configured byte limit', async () => {
    async function* input(): AsyncGenerator<Buffer> {
      yield Buffer.from('{"too":"large"}\n');
    }
    const collect = async (): Promise<void> => {
      for await (const _frame of decodeJsonLines(input(), { maxFrameBytes: 8 })) {
        // Exhaust the decoder so its size error is observed.
      }
    };
    await expect(collect()).rejects.toMatchObject({ code: 'frame_too_large' });
  });
});

describe('runtime-v1 contract registry', () => {
  it('declares param/result schemas for exactly the registered methods', () => {
    expect(Object.keys(runtimeMethodSchemas).sort()).toEqual([...RUNTIME_V1_METHODS].sort());
  });

  it('declares payload schemas for exactly the registered events', () => {
    expect(Object.keys(sessionEventPayloadSchemas).sort()).toEqual(
      [...SESSION_EVENT_NAMES].sort(),
    );
    expect(Object.keys(runtimeEventPayloadSchemas).sort()).toEqual(
      [...RUNTIME_SCOPED_EVENTS].sort(),
    );
  });

  it('pins the turn.start requestId contract', () => {
    expect(
      turnStartParamsSchema.safeParse({ sessionId: 's-1', input: 'hi' }).success,
    ).toBe(false);
    expect(
      turnStartParamsSchema.safeParse({ sessionId: 's-1', requestId: 't-1', input: 'hi' }).success,
    ).toBe(true);
  });
});
