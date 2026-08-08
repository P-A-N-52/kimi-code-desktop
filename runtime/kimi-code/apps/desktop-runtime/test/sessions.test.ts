import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EngineContext } from '../src/engine';
import type { RuntimeHandlerContext } from '../src/handler-context';
import { KimiRuntimeAdapter } from '../src/kimi-runtime-adapter';
import {
  RUNTIME_PROTOCOL,
  RuntimeRequestError,
  type JsonObject,
} from '../src/protocol';
import { MethodRouter } from '../src/router';
import { createForkSessionHandler, createSessionHandlers } from '../src/session-manager';

/**
 * Offline config: two static models on a stub provider so model binding
 * resolves locally (no network, no credentials).
 */
const CONFIG_TOML = `default_model = "test-model-a"

[providers.testprov]
type = "kimi"
api_key = "sk-test"
base_url = "https://api.example.test/v1"

[models.test-model-a]
provider = "testprov"
model = "test-model-a-v1"
max_context_size = 1000000

[models.test-model-b]
provider = "testprov"
model = "test-model-b-v1"
max_context_size = 1000000
`;

interface DescriptorLike {
  sessionId: string;
  workspaceId?: string;
  cwd?: string;
  title?: string | null;
  model?: string | null;
  archived?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

function asDescriptor(value: unknown): DescriptorLike {
  return value as DescriptorLike;
}

describe('sessions method family', () => {
  let adapter: KimiRuntimeAdapter;
  let router: MethodRouter;
  let homeDir: string;
  let openedCalls: { sessionId: string; engine: EngineContext }[];
  let closedCalls: string[];
  const workDirs: string[] = [];
  let requestSeq = 0;

  async function makeWorkDir(): Promise<string> {
    // realpath: macOS tmpdir is a /var → /private/var symlink; the workspace
    // catalog canonicalizes roots, so assertions compare canonical paths.
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'kimi-runtime-sessions-work-')));
    workDirs.push(dir);
    return dir;
  }

  function frame(method: string, params: JsonObject) {
    requestSeq += 1;
    return {
      protocol: RUNTIME_PROTOCOL,
      type: 'request' as const,
      id: `req-${requestSeq}`,
      method,
      params,
    };
  }

  function call(method: string, params: JsonObject = {}): Promise<unknown> {
    return router.dispatch(frame(method, params));
  }

  async function expectRequestError(promise: Promise<unknown>, code: string): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeRequestError);
      expect((error as RuntimeRequestError).code).toBe(code);
      expect((error as RuntimeRequestError).retryable).toBe(false);
      return error as Error;
    }
    throw new Error(`expected a ${code} rejection`);
  }

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-runtime-sessions-home-'));
    await writeFile(join(homeDir, 'config.toml'), CONFIG_TOML, 'utf8');
    adapter = new KimiRuntimeAdapter();
    await adapter.start({ homeDir });
    openedCalls = [];
    closedCalls = [];
    const ctx: RuntimeHandlerContext = {
      adapter,
      emitSessionEvent: () => Promise.resolve(),
      emitRuntimeEvent: () => Promise.resolve(),
      sessionHooks: {
        onSessionOpened: (sessionId, engine) => {
          openedCalls.push({ sessionId, engine });
        },
        onSessionClosed: (sessionId) => {
          closedCalls.push(sessionId);
        },
      },
    };
    router = new MethodRouter();
    for (const [method, handler] of createSessionHandlers(ctx)) {
      router.register(method, handler);
    }
    // sessions.fork is a separate single-handler export (see
    // createForkSessionHandler); the test router registers it like the
    // protocol server does.
    const forkEntry = createForkSessionHandler(ctx);
    router.register(forkEntry[0], forkEntry[1]);
  }, 120_000);

  afterAll(async () => {
    await adapter.close();
    // The engine's query-store cache writer can still be flushing when
    // teardown runs; rm retries absorb the ENOTEMPTY/EBUSY race.
    const rmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;
    await rm(homeDir, rmOptions);
    for (const dir of workDirs) {
      await rm(dir, rmOptions);
    }
  }, 60_000);

  it('runs the create → get → list → update → open → close → delete chain', async () => {
    const workDir = await makeWorkDir();

    const created = asDescriptor(
      await call('sessions.create', {
        sessionId: 'session_chain',
        cwd: workDir,
        title: 'Chain session',
      }),
    );
    expect(created).toMatchObject({
      sessionId: 'session_chain',
      cwd: workDir,
      title: 'Chain session',
      archived: false,
      // No model param → no main-agent binding → reported as unknown.
      model: null,
    });
    expect(created.workspaceId).toEqual(expect.any(String));
    expect(created.createdAt).toEqual(expect.any(Number));
    expect(created.updatedAt).toEqual(expect.any(Number));
    const workspaceId = created.workspaceId as string;

    const fetched = asDescriptor(await call('sessions.get', { sessionId: 'session_chain' }));
    expect(fetched).toMatchObject({
      sessionId: 'session_chain',
      workspaceId,
      cwd: workDir,
      title: 'Chain session',
      archived: false,
      // The session index carries no model binding.
      model: null,
    });

    const listed = (await call('sessions.list', {})) as { sessions: unknown[] };
    expect(listed.sessions.map((item) => asDescriptor(item).sessionId)).toContain('session_chain');
    const listedByWorkspace = (await call('sessions.list', { workspaceId })) as {
      sessions: unknown[];
    };
    expect(
      listedByWorkspace.sessions.map((item) => asDescriptor(item).sessionId),
    ).toContain('session_chain');
    const listedMissing = (await call('sessions.list', {
      workspaceId: 'workspace_missing',
    })) as { sessions: unknown[] };
    expect(listedMissing.sessions).toEqual([]);

    const modelUpdated = asDescriptor(
      await call('sessions.update', { sessionId: 'session_chain', model: 'test-model-b' }),
    );
    expect(modelUpdated.model).toBe('test-model-b');

    const movedWorkDir = await makeWorkDir();
    const cwdUpdated = asDescriptor(
      await call('sessions.update', { sessionId: 'session_chain', cwd: movedWorkDir }),
    );
    expect(cwdUpdated.cwd).toBe(movedWorkDir);
    expect(asDescriptor(await call('sessions.get', { sessionId: 'session_chain' })).cwd).toBe(
      movedWorkDir,
    );

    const opened = asDescriptor(await call('session.open', { sessionId: 'session_chain' }));
    expect(opened).toMatchObject({ sessionId: 'session_chain', model: 'test-model-b' });
    expect(openedCalls.map((entry) => entry.sessionId)).toEqual(['session_chain']);
    expect(openedCalls[0]?.engine).toBe(adapter.engineContext);

    // Repeat open is idempotent: same descriptor, no second hook.
    const reopened = asDescriptor(await call('session.open', { sessionId: 'session_chain' }));
    expect(reopened.sessionId).toBe('session_chain');
    expect(openedCalls).toHaveLength(1);

    await expect(call('session.close', { sessionId: 'session_chain' })).resolves.toEqual({
      closed: true,
    });
    expect(closedCalls).toEqual(['session_chain']);

    // Closing an existing but not-live session is idempotent and fires no hook.
    await expect(call('session.close', { sessionId: 'session_chain' })).resolves.toEqual({
      closed: true,
    });
    expect(closedCalls).toHaveLength(1);

    await expect(call('sessions.delete', { sessionId: 'session_chain' })).resolves.toEqual({
      deleted: true,
    });
    await expectRequestError(call('sessions.get', { sessionId: 'session_chain' }), 'session_not_found');
    const listedAfter = (await call('sessions.list', {})) as { sessions: unknown[] };
    expect(listedAfter.sessions.map((item) => asDescriptor(item).sessionId)).not.toContain(
      'session_chain',
    );
  }, 60_000);

  it('mints a session id when params carry none', async () => {
    const created = asDescriptor(await call('sessions.create', { cwd: await makeWorkDir() }));
    expect(created.sessionId).toMatch(/^session_/);
    const fetched = asDescriptor(await call('sessions.get', { sessionId: created.sessionId }));
    expect(fetched.sessionId).toBe(created.sessionId);
  }, 60_000);

  it('rejects a duplicate explicit session id with session_already_exists', async () => {
    const workDir = await makeWorkDir();
    await call('sessions.create', { sessionId: 'session_dupe', cwd: workDir });
    const error = await expectRequestError(
      call('sessions.create', { sessionId: 'session_dupe', cwd: workDir }),
      'session_already_exists',
    );
    expect(error.message).toContain('session_dupe');
  }, 60_000);

  it('creates with a bound model when the alias is configured', async () => {
    const created = asDescriptor(
      await call('sessions.create', {
        sessionId: 'session_with_model',
        cwd: await makeWorkDir(),
        model: 'test-model-a',
      }),
    );
    expect(created.model).toBe('test-model-a');
  }, 60_000);

  it('rolls create failures with an unknown model alias into internal_error', async () => {
    const error = await expectRequestError(
      call('sessions.create', {
        sessionId: 'session_bad_model',
        cwd: await makeWorkDir(),
        model: 'no-such-model',
      }),
      'internal_error',
    );
    expect(error.message).toContain('not configured');
    // The engine rolled the session back: no half-created record remains.
    await expectRequestError(
      call('sessions.get', { sessionId: 'session_bad_model' }),
      'session_not_found',
    );
  }, 60_000);

  it('maps unknown session ids to session_not_found across methods', async () => {
    const missing = 'session_missing';
    await expectRequestError(call('sessions.get', { sessionId: missing }), 'session_not_found');
    await expectRequestError(
      call('sessions.update', { sessionId: missing, model: 'test-model-a' }),
      'session_not_found',
    );
    await expectRequestError(call('sessions.delete', { sessionId: missing }), 'session_not_found');
    await expectRequestError(call('session.open', { sessionId: missing }), 'session_not_found');
    await expectRequestError(call('session.close', { sessionId: missing }), 'session_not_found');
  }, 60_000);

  it('resumes a closed session for update, then persists the model binding', async () => {
    await call('sessions.create', { sessionId: 'session_cold', cwd: await makeWorkDir() });
    await expect(call('session.close', { sessionId: 'session_cold' })).resolves.toEqual({
      closed: true,
    });

    const updated = asDescriptor(
      await call('sessions.update', { sessionId: 'session_cold', model: 'test-model-b' }),
    );
    expect(updated.model).toBe('test-model-b');

    // The binding survived the resume → mutate → close round trip.
    const reopened = asDescriptor(await call('session.open', { sessionId: 'session_cold' }));
    expect(reopened.model).toBe('test-model-b');
    await expect(call('session.close', { sessionId: 'session_cold' })).resolves.toEqual({
      closed: true,
    });
  }, 60_000);

  it('fires onSessionClosed when deleting an opened session', async () => {
    await call('sessions.create', { sessionId: 'session_open_delete', cwd: await makeWorkDir() });
    await call('session.open', { sessionId: 'session_open_delete' });
    expect(openedCalls.map((entry) => entry.sessionId)).toContain('session_open_delete');

    await expect(
      call('sessions.delete', { sessionId: 'session_open_delete' }),
    ).resolves.toEqual({ deleted: true });
    expect(closedCalls).toContain('session_open_delete');
    await expectRequestError(
      call('sessions.get', { sessionId: 'session_open_delete' }),
      'session_not_found',
    );
  }, 60_000);

  it('rejects invalid params with invalid_params', async () => {
    await expectRequestError(call('sessions.create', {}), 'invalid_params');
    await expectRequestError(call('sessions.create', { cwd: '' }), 'invalid_params');
    await expectRequestError(call('sessions.get', {}), 'invalid_params');
    await expectRequestError(call('sessions.get', { sessionId: '' }), 'invalid_params');
    await expectRequestError(call('sessions.list', { limit: 0 }), 'invalid_params');
    await expectRequestError(call('sessions.list', { limit: 1.5 }), 'invalid_params');
    await expectRequestError(call('session.open', { sessionId: '' }), 'invalid_params');
    await expectRequestError(call('session.close', {}), 'invalid_params');
    await expectRequestError(call('sessions.delete', {}), 'invalid_params');
    await expectRequestError(call('sessions.update', { sessionId: 'x', model: 1 }), 'invalid_params');
  }, 60_000);

  it('forks a session with an explicit id and title, leaving the fork unopened', async () => {
    const workDir = await makeWorkDir();
    await call('sessions.create', {
      sessionId: 'session_fork_src',
      cwd: workDir,
      title: 'Fork source',
      model: 'test-model-a',
    });

    const forked = asDescriptor(
      await call('sessions.fork', {
        sessionId: 'session_fork_src',
        newSessionId: 'session_fork_dst',
        title: 'Forked copy',
      }),
    );
    expect(forked).toMatchObject({
      sessionId: 'session_fork_dst',
      title: 'Forked copy',
      archived: false,
    });
    expect(forked.cwd).toBe(workDir);

    // The fork is a real persisted session (the index read model can serve a
    // stale create-time title — engine-internal timing — so the title is
    // asserted on the live descriptor at open below, not here).
    const fetched = asDescriptor(await call('sessions.get', { sessionId: 'session_fork_dst' }));
    expect(fetched).toMatchObject({ sessionId: 'session_fork_dst', archived: false });
    // …but fork did not open it: no hook fired, so the first session.open
    // still attaches (and a repeat open stays idempotent).
    const openedBefore = openedCalls.length;
    expect(openedCalls.map((entry) => entry.sessionId)).not.toContain('session_fork_dst');
    const openedFork = asDescriptor(await call('session.open', { sessionId: 'session_fork_dst' }));
    expect(openedFork).toMatchObject({ sessionId: 'session_fork_dst', title: 'Forked copy' });
    expect(openedCalls.length).toBe(openedBefore + 1);
    expect(openedCalls[openedCalls.length - 1]?.sessionId).toBe('session_fork_dst');
    await call('session.close', { sessionId: 'session_fork_dst' });

    // The source session is untouched: its own scope metadata still reports
    // the title (the session-index read model may serve a stale create-time
    // summary — engine-internal timing — so this reads the live descriptor).
    const sourceOpened = asDescriptor(await call('session.open', { sessionId: 'session_fork_src' }));
    expect(sourceOpened).toMatchObject({ sessionId: 'session_fork_src', title: 'Fork source' });
    await call('session.close', { sessionId: 'session_fork_src' });
  }, 60_000);

  it('forks without an explicit id and derives the default title', async () => {
    await call('sessions.create', {
      sessionId: 'session_fork_mint',
      cwd: await makeWorkDir(),
      title: 'Mint source',
    });
    const forked = asDescriptor(await call('sessions.fork', { sessionId: 'session_fork_mint' }));
    expect(forked.sessionId).toEqual(expect.any(String));
    expect(forked.sessionId).not.toBe('session_fork_mint');
    expect(forked.title).toBe('Fork: Mint source');
    const fetched = asDescriptor(
      await call('sessions.get', { sessionId: forked.sessionId as string }),
    );
    expect(fetched.sessionId).toBe(forked.sessionId);
  }, 60_000);

  it('rejects fork-at-turn with fork_turn_unsupported and forks nothing', async () => {
    await call('sessions.create', {
      sessionId: 'session_fork_turn',
      cwd: await makeWorkDir(),
    });
    const error = await expectRequestError(
      call('sessions.fork', { sessionId: 'session_fork_turn', turnIndex: 0 }),
      'fork_turn_unsupported',
    );
    expect(error.message).toContain('whole sessions only');
    // The rejection happened before any engine fork: a follow-up whole-session
    // fork with an explicit id succeeds (no half-created record in the way).
    const forked = asDescriptor(
      await call('sessions.fork', {
        sessionId: 'session_fork_turn',
        newSessionId: 'session_fork_turn_dst',
      }),
    );
    expect(forked.sessionId).toBe('session_fork_turn_dst');
  }, 60_000);

  it('maps fork failures: unknown source and duplicate target id', async () => {
    await expectRequestError(
      call('sessions.fork', { sessionId: 'session_missing' }),
      'session_not_found',
    );
    await call('sessions.create', {
      sessionId: 'session_fork_dupe_src',
      cwd: await makeWorkDir(),
    });
    await call('sessions.create', {
      sessionId: 'session_fork_dupe_taken',
      cwd: await makeWorkDir(),
    });
    await expectRequestError(
      call('sessions.fork', {
        sessionId: 'session_fork_dupe_src',
        newSessionId: 'session_fork_dupe_taken',
      }),
      'session_already_exists',
    );
  }, 60_000);

  it('rejects invalid fork params with invalid_params', async () => {
    await expectRequestError(call('sessions.fork', {}), 'invalid_params');
    await expectRequestError(call('sessions.fork', { sessionId: '' }), 'invalid_params');
    await expectRequestError(
      call('sessions.fork', { sessionId: 'x', turnIndex: -1 }),
      'invalid_params',
    );
    await expectRequestError(
      call('sessions.fork', { sessionId: 'x', turnIndex: 1.5 }),
      'invalid_params',
    );
  }, 60_000);

  it('fails structurally when the engine is not started', async () => {
    const unstarted = new KimiRuntimeAdapter();
    const ctx: RuntimeHandlerContext = {
      adapter: unstarted,
      emitSessionEvent: () => Promise.resolve(),
      emitRuntimeEvent: () => Promise.resolve(),
    };
    const unstartedRouter = new MethodRouter();
    for (const [method, handler] of createSessionHandlers(ctx)) {
      unstartedRouter.register(method, handler);
    }
    await expectRequestError(
      unstartedRouter.dispatch(frame('sessions.list', {})),
      'engine_not_available',
    );
  });
});
