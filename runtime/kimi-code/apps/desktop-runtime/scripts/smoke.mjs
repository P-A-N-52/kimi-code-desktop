import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const appRoot = join(import.meta.dirname, '..');
const libraryPath = join(appRoot, 'dist/index.mjs');
const mainPath = join(appRoot, 'dist/main.mjs');

await Promise.all([access(libraryPath), access(mainPath)]).catch(() => {
  throw new Error('Desktop runtime dist is missing. Run the package build before smoke.');
});

const runtime = await import(libraryPath);
const libraryFrames = [];
const libraryServer = new runtime.RuntimeProtocolServer({
  adapter: { isStarted: false, async start() {}, async close() {} },
  emitFrame: (frame) => libraryFrames.push(frame),
});
await libraryServer.accept(hello('library-hello'));
await libraryServer.emitSessionEvent('session-a', 'content.delta', {});
await libraryServer.emitSessionEvent('session-b', 'content.delta', {});
await libraryServer.emitSessionEvent('session-a', 'turn.completed', {});
assert(
  JSON.stringify(libraryFrames.slice(1).map(({ sessionId, seq }) => [sessionId, seq])) ===
    JSON.stringify([
      ['session-a', 1],
      ['session-b', 1],
      ['session-a', 2],
    ]),
  'dist library did not isolate per-session event sequences',
);

const child = spawn(process.execPath, [mainPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const requests = [
  hello('hello-1'),
  request('info-1', 'runtime.getInfo'),
  request('unknown-1', 'runtime.unknown'),
  request('shutdown-1', 'runtime.shutdown'),
  request('after-shutdown', 'runtime.getInfo'),
];
child.stdin.end(`${requests.map((frame) => JSON.stringify(frame)).join('\n')}\n`);

const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error('Desktop runtime smoke timed out.'));
  }, 10_000);
  child.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
});

assert(exitCode === 0, `runtime exited with ${exitCode}; stderr=${stderr}`);
const lines = stdout.split('\n').filter((line) => line.length > 0);
assert(lines.length === 5, `expected five protocol frames, received ${lines.length}`);
const frames = lines.map((line) => JSON.parse(line));
assert(frames.every((frame) => frame.protocol === 'runtime-v1'), 'stdout contains non-protocol output');
assert(frames[0]?.id === 'hello-1' && frames[0]?.ok === true, 'hello failed');
assert(frames[1]?.id === 'info-1' && frames[1]?.ok === true, 'getInfo failed');
assert(frames[2]?.error?.code === 'method_not_found', 'unknown method was not rejected');
assert(
  frames[3]?.id === 'after-shutdown' &&
    frames[3]?.error?.code === 'runtime_shutting_down',
  'request buffered after shutdown was not rejected',
);
assert(frames[4]?.id === 'shutdown-1' && frames[4]?.ok === true, 'shutdown was not final');

process.stdout.write('Desktop runtime smoke passed.\n');

function hello(id) {
  return {
    protocol: 'runtime-v1',
    type: 'request',
    id,
    method: 'runtime.hello',
    params: {
      desktopVersion: '1.0.0-smoke',
      supportedProtocols: ['runtime-v1'],
      dataRoot: process.cwd(),
      platform: process.platform,
      arch: process.arch,
      locale: 'en-US',
    },
  };
}

function request(id, method) {
  return { protocol: 'runtime-v1', type: 'request', id, method, params: {} };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
