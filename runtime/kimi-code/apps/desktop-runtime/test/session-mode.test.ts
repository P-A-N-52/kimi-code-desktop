import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EngineContext } from '../src/engine';
import type { RuntimeHandlerContext } from '../src/handler-context';
import { KimiRuntimeAdapter } from '../src/kimi-runtime-adapter';
import {
  RUNTIME_PROTOCOL,
  type JsonObject,
  type JsonValue,
  type RuntimeRequestFrame,
} from '../src/protocol';
import type { RuntimeMethodHandler } from '../src/router';
import { createSessionModeHandlers } from '../src/session-mode-router';
import { registerActiveTurn, releaseActiveTurn } from '../src/turn-router';

/**
 * Offline `session.setMode` coverage against the real engine (throwaway
 * home, no provider configured): plan enter/cancel with engine readback,
 * permission hot-switch with raw service readback, the plan arm's idle gate,
 * and the params/unknown-session error matrix.
 */

interface ModeFixture {
  readonly adapter: KimiRuntimeAdapter;
  readonly engine: EngineContext;
  readonly homeDir: string;
  readonly workDir: string;
  call(method: string, params: JsonObject): Promise<JsonValue>;
}

let requestSeq = 0;

async function makeRuntime(): Promise<ModeFixture> {
  const homeDir = await mkdtemp(join(tmpdir(), 'desktop-runtime-mode-home-'));
  const workDir = await mkdtemp(join(tmpdir(), 'desktop-runtime-mode-work-'));
  const adapter = new KimiRuntimeAdapter();
  try {
    await adapter.start({ homeDir });
  } catch (error) {
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
  const engine = adapter.engineContext;
  if (engine === undefined) throw new Error('engine did not start');
  const ctx: RuntimeHandlerContext = {
    adapter,
    emitSessionEvent: () => Promise.resolve(),
    emitRuntimeEvent: () => Promise.resolve(),
  };
  const handlers = new Map<string, RuntimeMethodHandler>(createSessionModeHandlers(ctx));
  return {
    adapter,
    engine,
    homeDir,
    workDir,
    call: (method, params) => {
      const handler = handlers.get(method);
      if (handler === undefined) throw new Error(`no handler registered for ${method}`);
      const frame: RuntimeRequestFrame = {
        protocol: RUNTIME_PROTOCOL,
        type: 'request',
        id: `mode-${++requestSeq}`,
        method,
        params,
      };
      return Promise.resolve(handler(frame)) as Promise<JsonValue>;
    },
  };
}

async function disposeRuntime(fixture: ModeFixture): Promise<void> {
  await fixture.adapter.close();
  await rm(fixture.homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(fixture.workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function createSession(fixture: ModeFixture): Promise<string> {
  const meta = await fixture.engine.klient.global.sessions.create({
    workDir: fixture.workDir,
  });
  return meta.id;
}

/** Engine-side plan state, read through the same facade the handler uses. */
async function enginePlanActive(fixture: ModeFixture, sessionId: string): Promise<boolean> {
  return (
    (await fixture.engine.klient.session(sessionId).agent(MAIN_AGENT_ID).getPlan()) !== null
  );
}

/** Engine-side permission mode, read from the raw service (no facade getter). */
function enginePermissionMode(fixture: ModeFixture, sessionId: string): string {
  const session = getLiveSessionById(fixture.engine.app.accessor, sessionId);
  const agent = session?.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID);
  const mode = agent?.accessor.get(IAgentPermissionModeService).mode;
  if (mode === undefined) throw new Error('main agent is not live');
  return mode;
}

describe('session.setMode', () => {
  let fixture: ModeFixture;

  beforeAll(async () => {
    fixture = await makeRuntime();
  }, 120_000);

  afterAll(async () => {
    await disposeRuntime(fixture);
  }, 60_000);

  it('enters and leaves plan mode with an engine readback, idempotently', async () => {
    const sessionId = await createSession(fixture);
    expect(await enginePlanActive(fixture, sessionId)).toBe(false);

    await expect(
      fixture.call('session.setMode', { sessionId, mode: 'plan', enabled: true }),
    ).resolves.toEqual({ sessionId, mode: 'plan', planMode: true });
    expect(await enginePlanActive(fixture, sessionId)).toBe(true);

    // Idempotent: re-entering an active plan mode does not trip the engine's
    // session.plan_mode_invalid.
    await expect(
      fixture.call('session.setMode', { sessionId, mode: 'plan', enabled: true }),
    ).resolves.toEqual({ sessionId, mode: 'plan', planMode: true });

    await expect(
      fixture.call('session.setMode', { sessionId, mode: 'plan', enabled: false }),
    ).resolves.toEqual({ sessionId, mode: 'plan', planMode: false });
    expect(await enginePlanActive(fixture, sessionId)).toBe(false);

    // Leaving an inactive plan mode is a no-op success.
    await expect(
      fixture.call('session.setMode', { sessionId, mode: 'plan', enabled: false }),
    ).resolves.toEqual({ sessionId, mode: 'plan', planMode: false });
  }, 60_000);

  it('hot-switches the permission mode and reports the applied value', async () => {
    const sessionId = await createSession(fixture);
    for (const mode of ['yolo', 'auto', 'manual'] as const) {
      await expect(
        fixture.call('session.setMode', { sessionId, mode: 'permission', permissionMode: mode }),
      ).resolves.toEqual({ sessionId, mode: 'permission', permissionMode: mode });
      expect(enginePermissionMode(fixture, sessionId)).toBe(mode);
    }
  }, 60_000);

  it('gates the plan arm on a live turn but lets permission hot-switch', async () => {
    const sessionId = await createSession(fixture);
    const otherSessionId = await createSession(fixture);
    registerActiveTurn(fixture.engine, sessionId, 'req-busy');
    try {
      await expect(
        fixture.call('session.setMode', { sessionId, mode: 'plan', enabled: true }),
      ).rejects.toMatchObject({ code: 'session_busy', retryable: false });
      expect(await enginePlanActive(fixture, sessionId)).toBe(false);

      // The gate is per-session: another session's plan arm is unaffected.
      await expect(
        fixture.call('session.setMode', { sessionId: otherSessionId, mode: 'plan', enabled: true }),
      ).resolves.toMatchObject({ mode: 'plan', planMode: true });

      // Permission hot-switches mid-turn (existing Desktop behavior).
      await expect(
        fixture.call('session.setMode', {
          sessionId,
          mode: 'permission',
          permissionMode: 'auto',
        }),
      ).resolves.toEqual({ sessionId, mode: 'permission', permissionMode: 'auto' });
      expect(enginePermissionMode(fixture, sessionId)).toBe('auto');
    } finally {
      releaseActiveTurn(fixture.engine, sessionId, 'req-busy');
    }

    // Once the turn settled, the plan arm applies again.
    await expect(
      fixture.call('session.setMode', { sessionId, mode: 'plan', enabled: true }),
    ).resolves.toMatchObject({ mode: 'plan', planMode: true });
  }, 60_000);

  it('rejects malformed params with invalid_params', async () => {
    const sessionId = await createSession(fixture);
    const bad: JsonObject[] = [
      {},
      { sessionId },
      { sessionId: '', mode: 'plan', enabled: true },
      { sessionId, mode: 'plan' },
      { sessionId, mode: 'plan', enabled: 'yes' },
      { sessionId, mode: 'permission' },
      { sessionId, mode: 'permission', permissionMode: 'ask' },
      { sessionId, mode: 'swarm', enabled: true },
    ];
    for (const params of bad) {
      await expect(fixture.call('session.setMode', params)).rejects.toMatchObject({
        code: 'invalid_params',
        retryable: false,
      });
    }
  }, 60_000);

  it('maps an unknown session to session_not_found', async () => {
    await expect(
      fixture.call('session.setMode', {
        sessionId: 'session_missing',
        mode: 'permission',
        permissionMode: 'auto',
      }),
    ).rejects.toMatchObject({ code: 'session_not_found', retryable: false });
    await expect(
      fixture.call('session.setMode', { sessionId: 'session_missing', mode: 'plan', enabled: true }),
    ).rejects.toMatchObject({ code: 'session_not_found', retryable: false });
  }, 60_000);
});
