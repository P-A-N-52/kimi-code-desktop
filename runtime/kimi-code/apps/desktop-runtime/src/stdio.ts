import type { Readable, Writable } from 'node:stream';

import { decodeJsonLines, writeJsonLine } from './codec';
import { RuntimeProtocolFault } from './protocol';
import { RuntimeProtocolServer, type RuntimeServerAdapter } from './server';

export interface RunStdioRuntimeOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostics: Writable;
  readonly adapter: RuntimeServerAdapter;
  readonly shutdownDrainMs?: number;
}

export async function runStdioRuntime(options: RunStdioRuntimeOptions): Promise<number> {
  const server = new RuntimeProtocolServer({
    adapter: options.adapter,
    emitFrame: (frame) => writeJsonLine(options.output, frame),
  });
  const inFlight = new Set<Promise<void>>();
  const frames = decodeJsonLines(options.input)[Symbol.asyncIterator]();
  const shutdownDrainMs = options.shutdownDrainMs ?? 100;
  let shutdownDeadline: number | undefined;
  let fatalError: unknown;
  const track = (pending: Promise<void>): void => {
    inFlight.add(pending);
    void pending.then(
      () => {
        inFlight.delete(pending);
      },
      (error: unknown) => {
        inFlight.delete(pending);
        fatalError =
          error instanceof Error
            ? error
            : new RuntimeProtocolFault('internal_error', 'Runtime request failed.');
        options.input.destroy();
      },
    );
  };

  try {
    for (;;) {
      if (fatalError !== undefined) throw fatalError;
      const nextFrame = frames.next();
      const step =
        shutdownDeadline === undefined
          ? await nextFrame
          : await resultBeforeDeadline(nextFrame, shutdownDeadline);
      if (step === undefined) {
        options.input.destroy();
        break;
      }
      if (step.done) break;

      track(server.accept(step.value));
      if (server.shutdownRequested && shutdownDeadline === undefined) {
        shutdownDeadline = Date.now() + shutdownDrainMs;
      }
    }

    if (shutdownDeadline === undefined) {
      await Promise.allSettled(inFlight);
    } else {
      await resultBeforeDeadline(Promise.allSettled(inFlight), shutdownDeadline);
    }
    if (fatalError !== undefined) throw fatalError;
    if (server.shutdownRequested) {
      await server.completeShutdown(
        Math.max(0, (shutdownDeadline ?? Date.now()) - Date.now()),
      );
    } else {
      await options.adapter.close();
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof RuntimeProtocolFault
        ? `${error.code}: ${error.message}`
        : 'internal_error: Runtime process failed.';
    options.diagnostics.write(`[desktop-runtime] ${message}\n`);
    try {
      await options.adapter.close();
    } catch {
      options.diagnostics.write('[desktop-runtime] shutdown_error: Runtime cleanup failed.\n');
    }
    return 1;
  }
}

async function resultBeforeDeadline<T>(
  pending: Promise<T>,
  deadline: number,
): Promise<T | undefined> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    void pending.catch(() => undefined);
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), remainingMs);
  });
  const result = await Promise.race([pending, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (result === undefined) void pending.catch(() => undefined);
  return result;
}
