import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ISessionApprovalService,
  ISessionQuestionService,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EngineContext } from '../src/engine';
import { attachSessionEvents } from '../src/event-bridge';
import type { RuntimeHandlerContext } from '../src/handler-context';
import { KimiRuntimeAdapter } from '../src/kimi-runtime-adapter';
import {
  RUNTIME_PROTOCOL,
  type JsonObject,
  type JsonValue,
  type RuntimeRequestFrame,
} from '../src/protocol';
import type { RuntimeMethodHandler } from '../src/router';
import {
  clearActiveTurns,
  createTurnHandlers,
  getActiveTurn,
  registerActiveTurn,
} from '../src/turn-router';

interface CollectedEvent {
  readonly sessionId: string;
  readonly event: string;
  readonly payload: JsonValue | undefined;
}

interface RuntimeFixture {
  readonly adapter: KimiRuntimeAdapter;
  readonly engine: EngineContext;
  readonly homeDir: string;
  readonly workDir: string;
  readonly events: CollectedEvent[];
  readonly ctx: RuntimeHandlerContext;
  call(method: string, params: JsonObject): Promise<JsonValue>;
}

let fixtureCounter = 0;

async function makeRuntime(): Promise<RuntimeFixture> {
  const homeDir = await mkdtemp(join(tmpdir(), 'desktop-runtime-turns-home-'));
  const workDir = await mkdtemp(join(tmpdir(), 'desktop-runtime-turns-work-'));
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
  const events: CollectedEvent[] = [];
  const ctx: RuntimeHandlerContext = {
    adapter,
    emitSessionEvent: (sessionId, event, payload) => {
      events.push({ sessionId, event, payload });
      return Promise.resolve();
    },
    emitRuntimeEvent: () => Promise.resolve(),
  };
  const handlers = new Map<string, RuntimeMethodHandler>(createTurnHandlers(ctx));
  return {
    adapter,
    engine,
    homeDir,
    workDir,
    events,
    ctx,
    call: (method, params) => {
      const handler = handlers.get(method);
      if (handler === undefined) throw new Error(`no handler registered for ${method}`);
      const frame: RuntimeRequestFrame = {
        protocol: RUNTIME_PROTOCOL,
        type: 'request',
        id: `test-${++fixtureCounter}`,
        method,
        params,
      };
      return Promise.resolve(handler(frame)).then((result) => {
        if (typeof result === 'symbol') {
          throw new Error(`${method} unexpectedly deferred its response`);
        }
        return result;
      });
    },
  };
}

async function disposeRuntime(fixture: RuntimeFixture): Promise<void> {
  await fixture.adapter.close();
  await rm(fixture.homeDir, { recursive: true, force: true });
  await rm(fixture.workDir, { recursive: true, force: true });
}

async function createSession(fixture: RuntimeFixture): Promise<string> {
  const meta = await fixture.engine.klient.global.sessions.create({
    workDir: fixture.workDir,
  });
  return meta.id;
}

async function waitForEvent(
  fixture: RuntimeFixture,
  predicate: (event: CollectedEvent) => boolean,
  timeoutMs = 20_000,
): Promise<CollectedEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = fixture.events.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for runtime event; saw ${JSON.stringify(
          fixture.events.map((event) => [event.sessionId, event.event]),
        )}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function wire(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

describe('turn family handlers (real engine, temp home)', () => {
  let fixture: RuntimeFixture;

  beforeAll(async () => {
    fixture = await makeRuntime();
  }, 60_000);

  afterAll(async () => {
    await disposeRuntime(fixture);
  });

  it('rejects invalid params before touching the engine', async () => {
    // Missing requestId.
    await expect(
      fixture.call('turn.start', { sessionId: 's-1', input: 'hi' }),
    ).rejects.toMatchObject({ code: 'invalid_params', retryable: false });
    // Unsupported prompt part type.
    await expect(
      fixture.call('turn.start', {
        sessionId: 's-1',
        requestId: 'r-1',
        input: [{ type: 'audio_url', audio_url: { url: 'https://example.com/a.mp3' } }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    // Decision outside the ApprovalResponse enum.
    await expect(
      fixture.call('approval.respond', {
        sessionId: 's-1',
        approvalId: 'a-1',
        decision: 'maybe',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      fixture.call('question.respond', { sessionId: 's-1', questionId: 'q-1' }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('maps a cold session to session_not_found', async () => {
    await expect(
      fixture.call('turn.start', { sessionId: 'no-such-session', requestId: 'r-1', input: 'hi' }),
    ).rejects.toMatchObject({ code: 'session_not_found', retryable: false });
    await expect(
      fixture.call('approval.respond', {
        sessionId: 'no-such-session',
        approvalId: 'a-1',
        decision: 'approved',
      }),
    ).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(
      fixture.call('question.respond', {
        sessionId: 'no-such-session',
        questionId: 'q-1',
        result: null,
      }),
    ).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(
      attachSessionEvents(fixture.engine, 'no-such-session', fixture.ctx.emitSessionEvent),
    ).rejects.toMatchObject({ code: 'session_not_found' });
  });

  it('enforces the one-active-turn invariant with session_busy', async () => {
    const sessionId = await createSession(fixture);
    const detach = await attachSessionEvents(
      fixture.engine,
      sessionId,
      fixture.ctx.emitSessionEvent,
    );
    try {
      registerActiveTurn(fixture.engine, sessionId, 'req-busy');
      await expect(
        fixture.call('turn.start', { sessionId, requestId: 'req-2', input: 'hi' }),
      ).rejects.toMatchObject({ code: 'session_busy', retryable: false });

      // Releasing the slot lets the next turn.start through the gate; the
      // no-provider turn then fails asynchronously as a turn.failed event.
      clearActiveTurns(fixture.engine, sessionId);
      const started = await fixture.call('turn.start', {
        sessionId,
        requestId: 'req-2',
        input: 'hi',
      });
      expect(started).toMatchObject({ requestId: 'req-2' });
      const terminal = await waitForEvent(
        fixture,
        (event) =>
          event.sessionId === sessionId &&
          (event.event === 'turn.completed' || event.event === 'turn.failed'),
      );
      expect(wire(terminal.payload)).toMatchObject({ requestId: 'req-2' });
      expect(getActiveTurn(fixture.engine, sessionId)).toBeUndefined();
    } finally {
      await detach();
    }
  }, 60_000);

  it('answers turn.start at prompt acceptance and fails the provider-less turn structurally', async () => {
    const sessionId = await createSession(fixture);
    const detach = await attachSessionEvents(
      fixture.engine,
      sessionId,
      fixture.ctx.emitSessionEvent,
    );
    try {
      const started = await fixture.call('turn.start', {
        sessionId,
        requestId: 'turn-e2e-1',
        input: 'hi',
      });
      // Accepted: the Desktop requestId echoes and the engine turn id is numeric.
      expect(started).toMatchObject({ requestId: 'turn-e2e-1' });
      expect(typeof (started as { readonly turnId?: unknown }).turnId).toBe('number');

      // A temp home has no provider: the turn must fail with a structured
      // terminal event — never crash, never hang.
      const terminal = await waitForEvent(
        fixture,
        (event) => event.sessionId === sessionId && event.event === 'turn.failed',
      );
      const payload = wire(terminal.payload);
      expect(payload).toMatchObject({
        requestId: 'turn-e2e-1',
        error: { code: expect.any(String), message: expect.any(String) },
      });
      const code = (payload as { readonly error: { readonly code: string } }).error.code;
      expect(code.length).toBeGreaterThan(0);

      // The terminal synthesis settled the registry entry.
      expect(getActiveTurn(fixture.engine, sessionId)).toBeUndefined();
    } finally {
      await detach();
    }
  }, 60_000);

  it('rolls the busy reservation back when the model is unknown', async () => {
    const sessionId = await createSession(fixture);
    await expect(
      fixture.call('turn.start', {
        sessionId,
        requestId: 'req-model',
        input: 'hi',
        model: 'nope/nope',
      }),
    ).rejects.toMatchObject({ code: 'model_not_found' });
    expect(getActiveTurn(fixture.engine, sessionId)).toBeUndefined();
  }, 60_000);

  it('accepts a planMode turn.start through the engine plan service', async () => {
    const sessionId = await createSession(fixture);
    const detach = await attachSessionEvents(
      fixture.engine,
      sessionId,
      fixture.ctx.emitSessionEvent,
    );
    try {
      const started = await fixture.call('turn.start', {
        sessionId,
        requestId: 'req-plan',
        input: 'plan this',
        planMode: true,
      });
      expect(started).toMatchObject({ requestId: 'req-plan' });
      // Provider-less home: drain the terminal event so the registry settles.
      await waitForEvent(
        fixture,
        (event) =>
          event.sessionId === sessionId &&
          (event.event === 'turn.completed' || event.event === 'turn.failed'),
      );
      expect(getActiveTurn(fixture.engine, sessionId)).toBeUndefined();
    } finally {
      await detach();
    }
  }, 60_000);

  it('answers turn.cancel idempotently and rejects steer without an active turn', async () => {
    const sessionId = await createSession(fixture);
    await expect(
      fixture.call('turn.cancel', { sessionId, requestId: 'req-none' }),
    ).resolves.toEqual({ requestId: 'req-none', cancelled: false });
    await expect(
      fixture.call('turn.steer', { sessionId, requestId: 'req-none', input: 'x' }),
    ).rejects.toMatchObject({ code: 'no_active_turn', retryable: false });
  });

  it('bridges a pending approval and resolves it through approval.respond', async () => {
    const sessionId = await createSession(fixture);
    const detach = await attachSessionEvents(
      fixture.engine,
      sessionId,
      fixture.ctx.emitSessionEvent,
    );
    try {
      const session = getLiveSessionById(fixture.engine.app.accessor, sessionId);
      if (session === undefined) throw new Error('session is not live');
      const pending = session.accessor.get(ISessionApprovalService).request({
        id: 'ap-e2e-1',
        toolName: 'bash',
        action: 'run command',
        toolCallId: 'tc-1',
        display: { kind: 'command', command: 'ls -la' },
      });

      const requested = await waitForEvent(
        fixture,
        (event) => event.sessionId === sessionId && event.event === 'approval.requested',
      );
      expect(wire(requested.payload)).toMatchObject({
        approvalId: 'ap-e2e-1',
        action: 'run command',
        toolCallId: 'tc-1',
        display: [{ type: 'command', data: { kind: 'command', command: 'ls -la' } }],
      });

      await expect(
        fixture.call('approval.respond', {
          sessionId,
          approvalId: 'ap-e2e-1',
          decision: 'approved',
        }),
      ).resolves.toEqual({});
      await expect(pending).resolves.toMatchObject({ decision: 'approved' });
      await expect(
        fixture.engine.klient.session(sessionId).approvals.list(),
      ).resolves.toEqual([]);

      // A late/unknown respond is an idempotent success, not an error.
      await expect(
        fixture.call('approval.respond', {
          sessionId,
          approvalId: 'no-such-approval',
          decision: 'rejected',
        }),
      ).resolves.toEqual({});
    } finally {
      await detach();
    }
  }, 60_000);

  it('bridges a pending question and resolves answer and dismiss paths', async () => {
    const sessionId = await createSession(fixture);
    const detach = await attachSessionEvents(
      fixture.engine,
      sessionId,
      fixture.ctx.emitSessionEvent,
    );
    try {
      const session = getLiveSessionById(fixture.engine.app.accessor, sessionId);
      if (session === undefined) throw new Error('session is not live');
      const questions = session.accessor.get(ISessionQuestionService);

      const pendingAnswer = questions.request({
        id: 'q-e2e-1',
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            options: [{ label: 'a', description: 'first' }],
            multiSelect: false,
            otherLabel: 'Other',
          },
        ],
      });
      const requested = await waitForEvent(
        fixture,
        (event) => event.sessionId === sessionId && event.event === 'question.requested',
      );
      expect(wire(requested.payload)).toMatchObject({
        questionId: 'q-e2e-1',
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            options: [{ label: 'a', description: 'first' }],
            multi_select: false,
            other_label: 'Other',
          },
        ],
      });

      await expect(
        fixture.call('question.respond', {
          sessionId,
          questionId: 'q-e2e-1',
          result: { Choice: 'a' },
        }),
      ).resolves.toEqual({});
      await expect(pendingAnswer).resolves.toEqual({ Choice: 'a' });

      // Null result is the dismiss path.
      const pendingDismiss = questions.request({
        id: 'q-e2e-2',
        questions: [{ question: 'Dismiss?', options: [{ label: 'ok' }] }],
      });
      await waitForEvent(
        fixture,
        (event) =>
          event.sessionId === sessionId &&
          event.event === 'question.requested' &&
          JSON.stringify(event.payload).includes('q-e2e-2'),
      );
      await expect(
        fixture.call('question.respond', { sessionId, questionId: 'q-e2e-2', result: null }),
      ).resolves.toEqual({});
      await expect(pendingDismiss).resolves.toBeNull();

      await expect(
        fixture.call('question.respond', { sessionId, questionId: 'no-such', result: null }),
      ).resolves.toEqual({});
    } finally {
      await detach();
    }
  }, 60_000);

  it('emits an initial session.status on attach and stops after detach', async () => {
    const sessionId = await createSession(fixture);
    const detach = await attachSessionEvents(
      fixture.engine,
      sessionId,
      fixture.ctx.emitSessionEvent,
    );
    const first = fixture.events.find((event) => event.sessionId === sessionId);
    expect(first).toMatchObject({ event: 'session.status', payload: { state: 'idle' } });

    await detach();
    const count = fixture.events.length;
    const session = getLiveSessionById(fixture.engine.app.accessor, sessionId);
    if (session === undefined) throw new Error('session is not live');
    session.accessor.get(ISessionApprovalService).enqueue({
      id: 'ap-after-detach',
      toolName: 'bash',
      action: 'run command',
      display: { kind: 'command', command: 'ls' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.events.length).toBe(count);
  }, 60_000);
});
