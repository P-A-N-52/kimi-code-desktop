import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const appRoot = join(import.meta.dirname, '..');
const libraryPath = join(appRoot, 'dist/index.mjs');
const mainPath = join(appRoot, 'dist/main.mjs');
// When set, spawn the given executable instead of `node dist/main.mjs` —
// used to run the full chain against the M5 SEA sidecar artifact
// (`RUNTIME_EXEC=<path to desktop-runtime-*>`).
const runtimeExec = process.env.RUNTIME_EXEC?.trim() || undefined;

await Promise.all([access(libraryPath), access(mainPath)]).catch(() => {
  throw new Error('Desktop runtime dist is missing. Run the package build before smoke.');
});
if (runtimeExec) {
  await access(runtimeExec).catch(() => {
    throw new Error(`RUNTIME_EXEC=${runtimeExec} does not exist.`);
  });
}

const runtime = await import(pathToFileURL(libraryPath).href);
const libraryFrames = [];
const libraryServer = new runtime.RuntimeProtocolServer({
  adapter: {
    isStarted: false,
    engineContext: undefined,
    trackLiveSession() {},
    untrackLiveSession() {},
    async start() {},
    async close() {},
  },
  emitFrame: (frame) => libraryFrames.push(frame),
});
await libraryServer.accept(hello('library-hello'));
await libraryServer.emitSessionEvent('session-a', 'content.delta', {});
await libraryServer.emitSessionEvent('session-b', 'content.delta', {});
await libraryServer.emitSessionEvent('session-a', 'turn.completed', {});
assert(
  libraryFrames[0]?.result?.capabilities?.sessions === true &&
    libraryFrames[0]?.result?.capabilities?.turns === true &&
    libraryFrames[0]?.result?.capabilities?.config === true &&
    libraryFrames[0]?.result?.capabilities?.replay === true &&
    libraryFrames[0]?.result?.capabilities?.auth === true &&
    libraryFrames[0]?.result?.capabilities?.usage === true &&
    libraryFrames[0]?.result?.capabilities?.fork === true &&
    libraryFrames[0]?.result?.capabilities?.methods?.length === 31 &&
    libraryFrames[0]?.result?.capabilities?.events?.length === 25,
  'dist library did not report all families wired (31 methods, 25 events)',
);
assert(
  libraryFrames[1]?.type === 'event' &&
    libraryFrames[1]?.event === 'runtime.ready' &&
    libraryFrames[1]?.sessionId === undefined &&
    libraryFrames[1]?.seq === undefined,
  'dist library did not emit a runtime-scoped runtime.ready after hello',
);
assert(
  JSON.stringify(libraryFrames.slice(2).map(({ sessionId, seq }) => [sessionId, seq])) ===
    JSON.stringify([
      ['session-a', 1],
      ['session-b', 1],
      ['session-a', 2],
    ]),
  'dist library did not isolate per-session event sequences',
);

// The child boots the real engine on hello; confine it to a throwaway
// KIMI_CODE_HOME so smoke never touches the user's real ~/.kimi-code. The
// method chain below is offline-safe: no provider is configured and no turn
// is started (turn terminal-state timing is a vitest concern, not a
// deterministic gate). The provider-directory probe falls back to the
// engine's built-in models.dev snapshot without network, and the registry
// probe targets a loopback server.
const kimiHome = await mkdtemp(join(tmpdir(), 'desktop-runtime-smoke-'));
const workDir = await mkdtemp(join(tmpdir(), 'desktop-runtime-smoke-work-'));
let registryServer;
// The SEA artifact embeds its own main; `node dist/main.mjs` is the dev path.
const child = runtimeExec
  ? spawn(runtimeExec, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KIMI_CODE_HOME: kimiHome },
    })
  : spawn(process.execPath, [mainPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KIMI_CODE_HOME: kimiHome },
    });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

// Responses are matched by id; event frames are collected on the side.
const events = [];
const eventWaiters = [];
const pending = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (line.length === 0) continue;
    const frame = JSON.parse(line);
    assert(frame.protocol === 'runtime-v1', 'stdout contains non-protocol output');
    if (frame.type === 'response') {
      const entry = pending.get(frame.id);
      if (entry !== undefined) {
        pending.delete(frame.id);
        entry(frame);
      }
    } else {
      events.push(frame);
      for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
        if (eventWaiters[i].predicate(frame)) {
          eventWaiters.splice(i, 1)[0].resolve(frame);
        }
      }
    }
  }
});

function call(id, method, params = {}) {
  const response = new Promise((resolve) => {
    pending.set(id, resolve);
  });
  child.stdin.write(
    `${JSON.stringify({ protocol: 'runtime-v1', type: 'request', id, method, params })}\n`,
  );
  return response;
}

// Events can land in a later stdout chunk than the triggering response, so
// awaiting a response is not proof its companion event was already parsed.
function waitForEvent(predicate) {
  const found = events.find(predicate);
  if (found !== undefined) return Promise.resolve(found);
  return new Promise((resolve) => {
    eventWaiters.push({ predicate, resolve });
  });
}

function assertOk(frame, id) {
  assert(frame?.id === id && frame?.ok === true, `${frame?.error?.code ?? 'missing'}: ${id} failed`);
  return frame.result;
}

try {
  // Watchdog: kill the child on timeout; the exit handler below then settles
  // every pending call so the chain fails instead of hanging.
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 60_000);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      for (const resolvePending of pending.values()) resolvePending(undefined);
      pending.clear();
      for (const waiter of eventWaiters.splice(0)) waiter.resolve(undefined);
      resolve(code);
    });
  });

  const helloResult = assertOk(await call('hello-1', 'runtime.hello', helloParams()), 'hello-1');
  assert(
    helloResult.capabilities?.sessions === true &&
      helloResult.capabilities?.turns === true &&
      helloResult.capabilities?.config === true &&
      helloResult.capabilities?.replay === true &&
      helloResult.capabilities?.auth === true &&
      helloResult.capabilities?.usage === true &&
      helloResult.capabilities?.fork === true &&
      helloResult.capabilities?.methods?.length === 31 &&
      helloResult.capabilities?.events?.length === 25,
    'hello did not advertise all families wired (31 methods, 25 events)',
  );
  const ready = await waitForEvent(
    (frame) =>
      frame.event === 'runtime.ready' && frame.sessionId === undefined && frame.seq === undefined,
  );
  assert(ready !== undefined, 'runtime.ready was not emitted as a runtime-scoped event');

  const infoResult = assertOk(await call('info-1', 'runtime.getInfo'), 'info-1');
  assert(
    infoResult.capabilities?.sessions === true &&
      infoResult.capabilities?.turns === true &&
      infoResult.capabilities?.config === true,
    'getInfo did not report the wired families',
  );
  // Release gate: the process must self-identify as the pinned kimi source
  // (KIMI_SOURCE_COMMIT in src/protocol.ts), whatever executable hosts it.
  assert(
    infoResult.kimiSource?.commit === '53c832dfdf9566afd59a8b3d54ebd36d3cb03d72',
    `getInfo did not report the pinned kimi source commit (${String(infoResult.kimiSource?.commit)})`,
  );

  const created = assertOk(
    await call('create-1', 'sessions.create', {
      sessionId: 'smoke-session-1',
      cwd: workDir,
      title: 'Smoke Session',
    }),
    'create-1',
  );
  assert(created.sessionId === 'smoke-session-1', 'sessions.create returned the wrong session');

  const fetched = assertOk(
    await call('get-1', 'sessions.get', { sessionId: 'smoke-session-1' }),
    'get-1',
  );
  assert(fetched.sessionId === 'smoke-session-1', 'sessions.get returned the wrong session');

  const listed = assertOk(await call('list-1', 'sessions.list'), 'list-1');
  assert(
    listed.sessions?.some((session) => session.sessionId === 'smoke-session-1'),
    'sessions.list does not contain the created session',
  );

  const updated = assertOk(
    await call('update-1', 'sessions.update', { sessionId: 'smoke-session-1', cwd: workDir }),
    'update-1',
  );
  assert(updated.sessionId === 'smoke-session-1', 'sessions.update returned the wrong session');

  assertOk(await call('config-get-1', 'config.get'), 'config-get-1');
  const configUpdated = assertOk(
    await call('config-update-1', 'config.update', {
      domain: 'desktopSmokeProbe',
      patch: { enabled: true },
      target: 'memory',
    }),
    'config-update-1',
  );
  assert(
    configUpdated.value?.enabled === true,
    'config.update did not return the refreshed value',
  );
  const configReadBack = assertOk(
    await call('config-get-2', 'config.get', { domain: 'desktopSmokeProbe' }),
    'config-get-2',
  );
  assert(configReadBack?.enabled === true, 'config.get did not read the update back');

  const models = assertOk(await call('models-1', 'models.list'), 'models-1');
  assert(Array.isArray(models.models), 'models.list did not return a models array');
  const providers = assertOk(await call('providers-1', 'providers.list'), 'providers-1');
  assert(Array.isArray(providers.providers), 'providers.list did not return a providers array');

  // M4 provider directory probes. The directory data comes from the live
  // models.dev fetch or, offline, the engine's built-in snapshot — either
  // way the DTO shape is the contract under test.
  const catalog = assertOk(await call('catalog-1', 'providers.catalog.list'), 'catalog-1');
  assert(
    Array.isArray(catalog.providers),
    'providers.catalog.list did not return a providers array',
  );
  const firstCatalogId = catalog.providers[0]?.id;
  if (typeof firstCatalogId === 'string') {
    const entry = assertOk(
      await call('catalog-2', 'providers.catalog.get', { entryId: firstCatalogId }),
      'catalog-2',
    );
    assert(
      entry.providerId === firstCatalogId && Array.isArray(entry.models),
      'providers.catalog.get did not round-trip the first directory entry',
    );
  }

  // M4 registry channel against a loopback api.json server (offline-safe).
  let registryAuth;
  registryServer = createServer((req, res) => {
    registryAuth = req.headers['authorization'];
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        smokereg: {
          id: 'smokereg',
          name: 'Smoke Registry',
          api: 'https://api.smokereg.test/v1',
          type: 'openai',
          models: { 'smoke-model': { id: 'smoke-model', limit: { context: 8192 } } },
        },
      }),
    );
  });
  await new Promise((resolve) => registryServer.listen(0, '127.0.0.1', resolve));
  const registryUrl = `http://127.0.0.1:${String(registryServer.address().port)}/api.json`;
  const registryImport = assertOk(
    await call('registry-1', 'providers.import', {
      source: 'registry',
      registryUrl,
      config: { apiKey: 'smoke-registry-key' },
    }),
    'registry-1',
  );
  assert(
    registryImport.providerId === 'smokereg' && registryImport.modelsImported === 1,
    'providers.import registry channel did not import the smoke registry',
  );
  assert(
    registryAuth === 'Bearer smoke-registry-key',
    'registry import did not send the bearer key',
  );

  assertOk(await call('open-1', 'session.open', { sessionId: 'smoke-session-1' }), 'open-1');
  // Attaching the event bridge emits the initial session.status snapshot.
  const status = await waitForEvent(
    (frame) => frame.sessionId === 'smoke-session-1' && frame.event === 'session.status',
  );
  assert(status !== undefined, 'session.open did not bridge the initial session.status event');

  // M4 session.setMode probes on the open session (no turn is live, so the
  // plan arm's idle gate is satisfied; the permission arm hot-switches).
  const planOn = assertOk(
    await call('mode-1', 'session.setMode', {
      sessionId: 'smoke-session-1',
      mode: 'plan',
      enabled: true,
    }),
    'mode-1',
  );
  assert(planOn.planMode === true, 'session.setMode plan arm did not report planMode:true');
  const planOff = assertOk(
    await call('mode-2', 'session.setMode', {
      sessionId: 'smoke-session-1',
      mode: 'plan',
      enabled: false,
    }),
    'mode-2',
  );
  assert(planOff.planMode === false, 'session.setMode plan arm did not report planMode:false');
  const permission = assertOk(
    await call('mode-3', 'session.setMode', {
      sessionId: 'smoke-session-1',
      mode: 'permission',
      permissionMode: 'auto',
    }),
    'mode-3',
  );
  assert(
    permission.permissionMode === 'auto',
    'session.setMode permission arm did not apply auto',
  );

  const closed = assertOk(
    await call('close-1', 'session.close', { sessionId: 'smoke-session-1' }),
    'close-1',
  );
  assert(closed.closed === true, 'session.close did not close the session');

  // M3 parity families are wired for real; the probes below stay
  // deterministic and offline-safe (no turn, no real login).
  const forked = assertOk(
    await call('fork-1', 'sessions.fork', {
      sessionId: 'smoke-session-1',
      newSessionId: 'smoke-session-fork-1',
      title: 'Smoke Fork',
    }),
    'fork-1',
  );
  assert(forked.sessionId === 'smoke-session-fork-1', 'sessions.fork returned the wrong session');
  const listedAfterFork = assertOk(await call('list-2', 'sessions.list'), 'list-2');
  assert(
    listedAfterFork.sessions?.some((session) => session.sessionId === 'smoke-session-fork-1'),
    'sessions.list does not contain the forked session',
  );

  // A session that never ran a turn replays as an empty burst (0/0 counters).
  const replayed = assertOk(
    await call('replay-1', 'session.replay', { sessionId: 'smoke-session-fork-1' }),
    'replay-1',
  );
  assert(
    replayed.events === 0 &&
      replayed.fromSeq === 0 &&
      replayed.toSeq === 0 &&
      replayed.truncated === false,
    'session.replay on empty history did not answer zero counters',
  );
  const replayBadParams = await call('replay-bad', 'session.replay');
  assert(
    replayBadParams?.error?.code === 'invalid_params',
    'session.replay did not validate params first',
  );

  // The throwaway KIMI_CODE_HOME has no credentials: auth.status is a
  // structured loggedIn:false, fully offline.
  const authStatus = assertOk(await call('auth-1', 'auth.status'), 'auth-1');
  assert(
    authStatus?.loggedIn === false,
    'auth.status did not answer loggedIn:false in an empty home',
  );

  const deleted = assertOk(
    await call('delete-1', 'sessions.delete', { sessionId: 'smoke-session-1' }),
    'delete-1',
  );
  assert(deleted.deleted === true, 'sessions.delete did not delete the session');
  assertOk(
    await call('delete-fork', 'sessions.delete', { sessionId: 'smoke-session-fork-1' }),
    'delete-fork',
  );

  const unknown = await call('unknown-1', 'runtime.unknown');
  assert(unknown?.error?.code === 'method_not_found', 'unknown method was not rejected');

  const shutdownResponse = call('shutdown-1', 'runtime.shutdown');
  const afterShutdown = await call('after-shutdown', 'runtime.getInfo');
  assert(
    afterShutdown?.error?.code === 'runtime_shutting_down',
    'request accepted after shutdown was not rejected',
  );
  child.stdin.end();
  const shutdown = await shutdownResponse;
  assert(shutdown?.id === 'shutdown-1' && shutdown?.ok === true, 'shutdown was not final');

  const exitCode = await exited;
  clearTimeout(timeout);
  assert(!timedOut, 'Desktop runtime smoke timed out.');
  assert(exitCode === 0, `runtime exited with ${exitCode}; stderr=${stderr}`);

  process.stdout.write('Desktop runtime smoke passed.\n');
} finally {
  if (registryServer !== undefined) {
    await new Promise((resolve) => registryServer.close(() => resolve()));
  }
  await rm(kimiHome, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
}

function hello(id) {
  return {
    protocol: 'runtime-v1',
    type: 'request',
    id,
    method: 'runtime.hello',
    params: helloParams(),
  };
}

function helloParams() {
  return {
    desktopVersion: '1.0.0-smoke',
    supportedProtocols: ['runtime-v1'],
    dataRoot: process.cwd(),
    platform: process.platform,
    arch: process.arch,
    locale: 'en-US',
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
