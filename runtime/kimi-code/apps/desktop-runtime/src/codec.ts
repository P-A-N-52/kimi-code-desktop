import type { Writable } from 'node:stream';

import {
  MAX_FRAME_BYTES,
  RuntimeProtocolFault,
  type RuntimeOutputFrame,
} from './protocol';

const LF = 0x0a;

export interface DecodeJsonLinesOptions {
  readonly maxFrameBytes?: number;
}

export async function* decodeJsonLines(
  input: AsyncIterable<Buffer | Uint8Array | string>,
  options: DecodeJsonLinesOptions = {},
): AsyncGenerator<unknown> {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  let pending = Buffer.alloc(0);

  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(LF, start);
      if (newline < 0) break;
      const segment = bytes.subarray(start, newline);
      assertFrameSize(pending.length + segment.length, maxFrameBytes);
      const frame = pending.length === 0 ? segment : Buffer.concat([pending, segment]);
      pending = Buffer.alloc(0);
      yield parseFrame(frame);
      start = newline + 1;
    }

    const remainder = bytes.subarray(start);
    assertFrameSize(pending.length + remainder.length, maxFrameBytes);
    if (remainder.length > 0) {
      pending = pending.length === 0 ? Buffer.from(remainder) : Buffer.concat([pending, remainder]);
    }
  }

  if (pending.length > 0) {
    throw new RuntimeProtocolFault(
      'unterminated_frame',
      'Runtime input ended before the final LF delimiter.',
    );
  }
}

export function encodeJsonLine(
  frame: RuntimeOutputFrame,
  maxFrameBytes = MAX_FRAME_BYTES,
): string {
  const json = JSON.stringify(frame);
  assertFrameSize(Buffer.byteLength(json, 'utf8'), maxFrameBytes);
  return `${json}\n`;
}

export async function writeJsonLine(
  output: Writable,
  frame: RuntimeOutputFrame,
): Promise<void> {
  const line = encodeJsonLine(frame);
  await new Promise<void>((resolve, reject) => {
    output.write(line, 'utf8', (error) => {
      if (error !== null && error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function parseFrame(frame: Buffer): unknown {
  if (frame.length === 0) {
    throw new RuntimeProtocolFault('empty_frame', 'Runtime input contains an empty frame.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
  } catch {
    throw new RuntimeProtocolFault('invalid_utf8', 'Runtime frame is not valid UTF-8.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeProtocolFault('invalid_json', 'Runtime frame is not valid JSON.');
  }
}

function assertFrameSize(size: number, maxFrameBytes: number): void {
  if (size > maxFrameBytes) {
    throw new RuntimeProtocolFault(
      'frame_too_large',
      `Runtime frame exceeds the ${maxFrameBytes}-byte limit.`,
    );
  }
}
