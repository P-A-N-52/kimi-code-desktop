import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { decodeJsonLines } from '../src/codec';
import type {
  KimiRuntimeStartOptions,
  RuntimeLifecycleAdapter,
} from '../src/kimi-runtime-adapter';
import {
  KIMI_SOURCE_COMMIT,
  RUNTIME_PROTOCOL,
  type RuntimeOutputFrame,
} from '../src/protocol';
import { RuntimeProtocolServer } from '../src/server';
import { runStdioRuntime } from '../src/stdio';

class FakeAdapter implements RuntimeLifecycleAdapter {
  isStarted = false;
  closeCalls = 0;

  async start(_options: KimiRuntimeStartOptions): Promise<void> {
    this.isStarted = true;
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

  it('returns frozen source identity from hello and getInfo without starting Kimi', async () => {
    const { adapter, frames, server } = setup();
    await server.accept(hello());
    await server.accept(request('info-1', 'runtime.getInfo'));
    expect(adapter.isStarted).toBe(false);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      id: 'hello-1',
      ok: true,
      result: { selectedProtocol: RUNTIME_PROTOCOL, kimiSource: { commit: KIMI_SOURCE_COMMIT } },
    });
    expect(frames[1]).toMatchObject({ id: 'info-1', ok: true });
  });

  it('returns structured unknown-method errors and fails closed on duplicate ids', async () => {
    const { frames, server } = setup();
    await server.accept(hello());
    await server.accept(request('unknown-1', 'runtime.missing'));
    expect(frames[1]).toMatchObject({
      id: 'unknown-1',
      ok: false,
      error: { code: 'method_not_found', retryable: false },
    });
    await expect(server.accept(request('unknown-1', 'runtime.getInfo'))).rejects.toMatchObject({
      code: 'duplicate_request_id',
    });
    expect(frames).toHaveLength(2);
  });

  it('maintains isolated monotonic event sequences per session', async () => {
    const { frames, server } = setup();
    await server.accept(hello());
    await server.emitSessionEvent('session-a', 'content.delta', { text: 'a' });
    await server.emitSessionEvent('session-b', 'content.delta', { text: 'b' });
    await server.emitSessionEvent('session-a', 'turn.completed', { requestId: 'turn-1' });
    expect(frames.slice(1)).toMatchObject([
      { sessionId: 'session-a', seq: 1 },
      { sessionId: 'session-b', seq: 1 },
      { sessionId: 'session-a', seq: 2 },
    ]);
  });

  it('rejects buffered requests and acknowledges shutdown last', async () => {
    const { adapter, frames, server } = setup();
    await server.accept(hello());
    await server.accept(request('shutdown-1', 'runtime.shutdown'));
    await server.accept(request('after-shutdown', 'runtime.getInfo'));
    expect(adapter.closeCalls).toBe(0);
    expect(server.shutdownRequested).toBe(true);
    expect(frames[1]).toMatchObject({
      id: 'after-shutdown',
      ok: false,
      error: { code: 'runtime_shutting_down' },
    });
    await server.completeShutdown();
    expect(adapter.closeCalls).toBe(1);
    expect(frames[2]).toMatchObject({ id: 'shutdown-1', ok: true });
  });

  it('completes shutdown after a bounded drain when stdin stays open', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let closeCalls = 0;
    const adapter: RuntimeLifecycleAdapter = {
      isStarted: false,
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
