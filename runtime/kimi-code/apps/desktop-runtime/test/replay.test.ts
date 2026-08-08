import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAppendLogStore,
  ISessionIndex,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EngineContext } from '../src/engine';
import {
  translateApprovalInteraction,
  translateDomainEvent,
  type TranslatedSessionEvent,
} from '../src/event-bridge';
import type { RuntimeHandlerContext } from '../src/handler-context';
import {
  RUNTIME_PROTOCOL,
  type JsonObject,
  type JsonValue,
  type RuntimeRequestFrame,
} from '../src/protocol';
import { createReplayHandlers } from '../src/replay-router';
import { planSessionReplay } from '../src/replay/map';
import type { RuntimeMethodHandler } from '../src/router';
import { clearActiveTurns, hasActiveTurn, registerActiveTurn } from '../src/turn-router';

const T0 = 1_700_000_000_000;
const WS = 'ws-1';
const SESSION = 'sess-1';
const PLAN_PATH = `sessions/${WS}/${SESSION}/agents/main/plan/plan-1/v1.md`;

let homeDir: string;

function wire(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function writeJournal(
  sessionId: string,
  agentId: string,
  records: readonly unknown[],
): Promise<void> {
  const dir = join(homeDir, 'sessions', WS, sessionId, 'agents', agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'wire.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

async function writeState(sessionId: string, agents: Record<string, unknown>): Promise<void> {
  const dir = join(homeDir, 'sessions', WS, sessionId);
  await mkdir(dir, { recursive: true });
  const meta = { id: sessionId, version: 2, createdAt: T0, updatedAt: T0, archived: false, agents };
  await writeFile(join(dir, 'state.json'), JSON.stringify(meta), 'utf8');
}

/** Compact fixture builders (one line per record keeps this file in budget). */
function loopEvent(event: unknown, time: number): unknown {
  return { type: 'context.append_loop_event', event, time };
}
function appendUser(text: string, time: number, origin?: unknown): unknown {
  return {
    type: 'context.append_message',
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin },
    time,
  };
}
function taskRecord(type: string, info: unknown, time: number): unknown {
  return { type, info, time };
}

/** The v1.5 main-agent journal: two turns (completed + failed), an approval, a shell task, a plan revision, and a subagent run record. */
function mainJournalRecords(): unknown[] {
  return [
    { type: 'metadata', protocol_version: '1.5', created_at: T0 },
    { type: 'turn.prompt', origin: { kind: 'user' }, time: T0 + 1 },
    appendUser('hello', T0 + 2),
    loopEvent({ type: 'step.begin', uuid: 's1' }, T0 + 3),
    loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'think', think: 'hmm' } }, T0 + 4),
    loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'world' } }, T0 + 5),
    loopEvent(
      { type: 'tool.call', stepUuid: 's1', toolCallId: 'tc-1', name: 'bash', args: { command: 'ls' } },
      T0 + 6,
    ),
    loopEvent({ type: 'step.end', uuid: 's1' }, T0 + 7),
    loopEvent({ type: 'tool.result', toolCallId: 'tc-1', result: { output: 'done' } }, T0 + 8),
    {
      type: 'interaction.request',
      id: 'ap-1',
      kind: 'approval',
      toolCallId: 'tc-1',
      agentId: 'main',
      request: {
        toolName: 'bash',
        action: 'run command',
        toolCallId: 'tc-1',
        agentId: 'main',
        turnId: 0,
        display: { kind: 'command', command: 'ls' },
      },
      time: T0 + 9,
    },
    { type: 'interaction.resolved', id: 'ap-1', response: { decision: 'approved' }, time: T0 + 10 },
    taskRecord(
      'task.started',
      { taskId: 'task-1', kind: 'process', status: 'running', description: 'ls run', startedAt: T0 + 11 },
      T0 + 11,
    ),
    taskRecord(
      'task.terminated',
      { taskId: 'task-1', kind: 'process', status: 'completed', description: 'ls run', startedAt: T0 + 11, endedAt: T0 + 12 },
      T0 + 12,
    ),
    { type: 'plan_mode.enter', id: 'plan-1', time: T0 + 13 },
    { type: 'plan.revision', id: 'plan-1', version: 1, path: PLAN_PATH, sha256: 'x', bytes: 6, time: T0 + 14 },
    { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 42, time: T0 + 15 },
    { type: 'turn.prompt', origin: { kind: 'user' }, time: T0 + 16 },
    appendUser('second', T0 + 17),
    loopEvent({ type: 'step.begin', uuid: 's2' }, T0 + 18),
    loopEvent({ type: 'content.part', stepUuid: 's2', part: { type: 'text', text: 'answer2' } }, T0 + 19),
    loopEvent({ type: 'step.end', uuid: 's2' }, T0 + 20),
    { type: 'turn.ended', turnId: 1, reason: 'failed', error: { message: 'boom' }, time: T0 + 21 },
    taskRecord(
      'task.started',
      { taskId: 'agent-task-1', kind: 'agent', status: 'running', description: 'explore', agentId: 'sub-1', startedAt: T0 + 22 },
      T0 + 22,
    ),
    taskRecord(
      'task.terminated',
      { taskId: 'agent-task-1', kind: 'agent', status: 'completed', description: 'explore', agentId: 'sub-1', startedAt: T0 + 22, endedAt: T0 + 23 },
      T0 + 23,
    ),
  ];
}

/** The subagent journal: a hidden-origin run with one text part (dropped on replay) and one tool call. */
function subJournalRecords(): unknown[] {
  return [
    { type: 'metadata', protocol_version: '1.5', created_at: T0 },
    appendUser('explore the repo', T0 + 1, { kind: 'system_trigger', name: 'subagent' }),
    loopEvent({ type: 'step.begin', uuid: 'ss1' }, T0 + 2),
    loopEvent({ type: 'content.part', stepUuid: 'ss1', part: { type: 'text', text: 'sub text' } }, T0 + 3),
    loopEvent(
      { type: 'tool.call', stepUuid: 'ss1', toolCallId: 'tc-sub', name: 'grep', args: 'pattern' },
      T0 + 4,
    ),
    loopEvent({ type: 'step.end', uuid: 'ss1' }, T0 + 5),
    loopEvent({ type: 'tool.result', toolCallId: 'tc-sub', result: { output: 'found' } }, T0 + 6),
  ];
}

// One shared temp home for the whole file: describe-level teardown would
// delete it before the handler suite runs (vitest orders describe blocks
// sequentially, hooks included).
beforeAll(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'desktop-runtime-replay-home-'));
  await writeJournal(SESSION, 'main', mainJournalRecords());
  await writeJournal(SESSION, 'sub-1', subJournalRecords());
  await writeState(SESSION, {
    main: { type: 'main' },
    'sub-1': { type: 'sub', parentAgentId: 'main' },
  });
  const planDir = join(homeDir, 'sessions', WS, SESSION, 'agents', 'main', 'plan', 'plan-1');
  await mkdir(planDir, { recursive: true });
  await writeFile(join(planDir, 'v1.md'), '# Plan', 'utf8');
});

afterAll(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe('planSessionReplay (synthetic journals, temp home)', () => {
  it('replays the main-agent golden burst in live order', async () => {
    const events = await planSessionReplay(homeDir, WS, SESSION);
    const names = events.map((entry) => entry.event);
    expect(names).toEqual([
      // Main block: two turns, plan, approval, shell task.
      'session.status', 'thinking.delta', 'content.delta', 'tool.started', 'tool.completed',
      'turn.completed', 'session.status', 'content.delta', 'turn.failed', 'plan.updated',
      'approval.requested', 'task.updated',
      // sub-1 block: lifecycle, tools, task, terminal.
      'subagent.updated', 'tool.started', 'tool.completed', 'task.updated', 'subagent.updated',
    ]);

    // Turn 0: busy bookend carries the minted requestId and the prompt extra.
    expect(wire(events[0]?.payload)).toEqual({
      state: 'busy',
      requestId: 'replay-main-t0',
      prompt: 'hello',
    });
    expect(wire(events[1]?.payload)).toEqual({ text: 'hmm', requestId: 'replay-main-t0' });
    expect(wire(events[2]?.payload)).toEqual({ text: 'world', requestId: 'replay-main-t0' });
    expect(wire(events[3]?.payload)).toEqual({
      toolCallId: 'tc-1',
      name: 'bash',
      arguments: '{"command":"ls"}',
      requestId: 'replay-main-t0',
      parentToolCallId: null,
      agentId: null,
    });
    expect(wire(events[4]?.payload)).toEqual({ toolCallId: 'tc-1', isError: false, output: 'done' });
    expect(wire(events[5]?.payload)).toEqual({ requestId: 'replay-main-t0' });

    // Turn 1: the persisted failed end state replays as turn.failed.
    expect(wire(events[6]?.payload)).toEqual({
      state: 'busy',
      requestId: 'replay-main-t1',
      prompt: 'second',
    });
    expect(wire(events[8]?.payload)).toEqual({
      requestId: 'replay-main-t1',
      error: { code: 'turn_failed', message: 'boom', retryable: false },
    });

    // Plan content is read back from the homeDir-relative revision path.
    expect(wire(events[9]?.payload)).toEqual({ content: '# Plan', filePath: PLAN_PATH });

    // The resolved approval replays through the bridge's own translator.
    expect(wire(events[10]?.payload)).toEqual({
      approvalId: 'ap-1',
      action: 'run command',
      toolCallId: 'tc-1',
      kind: null,
      display: [{ type: 'command', data: { kind: 'command', command: 'ls' } }],
      toolName: 'bash',
      agentId: 'main',
      turnId: 0,
    });

    // The shell task replays in the live AgentTaskInfo vocabulary.
    expect(wire(events[11]?.payload)).toEqual({
      taskId: 'task-1',
      kind: 'process',
      status: 'completed',
      detached: true,
      description: 'ls run',
      startedAt: T0 + 11,
      endedAt: T0 + 12,
    });
  });

  it('replays the subagent block with lifecycle events and no assistant text', async () => {
    const events = await planSessionReplay(homeDir, WS, SESSION);
    const block = events.slice(12);
    expect(wire(block[0]?.payload)).toEqual({
      phase: 'spawned',
      agentId: 'sub-1',
      parentToolCallId: null,
      subagentType: null,
      description: 'explore',
    });
    expect(wire(block[1]?.payload)).toEqual({
      toolCallId: 'tc-sub',
      name: 'grep',
      arguments: 'pattern',
      parentToolCallId: null,
      agentId: 'sub-1',
    });
    expect(wire(block[2]?.payload)).toEqual({ toolCallId: 'tc-sub', isError: false, output: 'found' });
    expect(wire(block[3]?.payload)).toEqual({
      taskId: 'agent-task-1',
      kind: 'agent',
      status: 'completed',
      detached: true,
      description: 'explore',
      agentId: 'sub-1',
      startedAt: T0 + 22,
      endedAt: T0 + 23,
    });
    expect(wire(block[4]?.payload)).toEqual({
      phase: 'completed',
      agentId: 'sub-1',
      parentToolCallId: null,
      subagentType: null,
    });
    // The subagent's assistant text never becomes content.delta (live parity).
    expect(block.some((entry) => entry.event === 'content.delta')).toBe(false);
  });

  it('matches the live bridge payload shape for content/tool/approval', async () => {
    const events = await planSessionReplay(homeDir, WS, SESSION);
    const ctx = { agentId: MAIN_AGENT_ID, isMainAgent: true, requestId: 'replay-main-t0' };

    const liveContent = translateDomainEvent({ type: 'assistant.delta', turnId: 0, delta: 'world' }, ctx);
    expect(wire(events[2]?.payload)).toEqual(wire(liveContent?.payload));

    const liveTool = translateDomainEvent(
      { type: 'tool.call.started', turnId: 0, toolCallId: 'tc-1', name: 'bash', args: { command: 'ls' } },
      ctx,
    );
    expect(wire(events[3]?.payload)).toEqual(wire(liveTool?.payload));

    // The replayed approval is byte-identical to the live translator's output
    // for the same parked payload (origin facts ride the request payload).
    const liveApproval = translateApprovalInteraction({
      id: 'ap-1',
      kind: 'approval',
      payload: {
        toolName: 'bash',
        action: 'run command',
        toolCallId: 'tc-1',
        agentId: 'main',
        turnId: 0,
        display: { kind: 'command', command: 'ls' },
      },
      origin: { agentId: 'main', turnId: 0 },
      createdAt: 0,
    });
    expect(wire(events[10]?.payload)).toEqual(wire(liveApproval.payload));
  });

  it('replays a resolved question and a pending approval folded to cancelled', async () => {
    const question = {
      question: 'Pick one',
      header: 'Choice',
      options: [{ label: 'A', description: 'a' }],
      multiSelect: true,
      otherLabel: 'Other',
      otherDescription: 'custom',
    };
    await writeJournal('sess-q', 'main', [
      { type: 'metadata', protocol_version: '1.5', created_at: T0 },
      {
        type: 'interaction.request',
        id: 'q-1',
        kind: 'question',
        toolCallId: 'tc-q',
        request: { toolCallId: 'tc-q', questions: [question] },
        time: T0 + 1,
      },
      { type: 'interaction.resolved', id: 'q-1', response: { answers: { '0': 'A' } }, time: T0 + 2 },
      {
        type: 'interaction.request',
        id: 'ap-pending',
        kind: 'approval',
        request: { toolName: 'bash', action: 'run', toolCallId: 'tc-p' },
        time: T0 + 3,
      },
    ]);
    await writeState('sess-q', { main: { type: 'main' } });
    const events = await planSessionReplay(homeDir, WS, 'sess-q');
    expect(events.map((entry) => entry.event)).toEqual(['question.requested', 'approval.requested']);
    expect(wire(events[0]?.payload)).toEqual({
      questionId: 'q-1',
      toolCallId: 'tc-q',
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          options: [{ label: 'A', description: 'a' }],
          multi_select: true,
          other_label: 'Other',
          other_description: 'custom',
        },
      ],
    });
    // Pending at shutdown folds to cancelled, but still replays as a resolved
    // historical artifact (never a ghost-pending request).
    expect(wire(events[1]?.payload)).toMatchObject({ approvalId: 'ap-pending', action: 'run' });
  });

  it('replays a v1 (pre-metadata) journal with folded terminal states', async () => {
    // No metadata line, no interaction/task/turn.ended records: the v1 shape.
    await writeJournal('sess-v1', 'main', [
      appendUser('old', T0 + 1),
      loopEvent({ type: 'step.begin', uuid: 'v1s' }, T0 + 2),
      loopEvent({ type: 'content.part', stepUuid: 'v1s', part: { type: 'text', text: 'old answer' } }, T0 + 3),
      loopEvent({ type: 'step.end', uuid: 'v1s' }, T0 + 4),
    ]);
    await writeState('sess-v1', { main: { type: 'main' } });
    const events = await planSessionReplay(homeDir, WS, 'sess-v1');
    expect(events.map((entry) => entry.event)).toEqual([
      'session.status',
      'content.delta',
      'turn.completed',
    ]);
    // Without turn.ended records the terminal folds to completed.
    expect(wire(events[2]?.payload)).toEqual({ requestId: 'replay-main-t0' });
  });

  it('drops a torn final journal line', async () => {
    const dir = join(homeDir, 'sessions', WS, 'sess-torn', 'agents', 'main');
    await mkdir(dir, { recursive: true });
    const good = [
      JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: T0 }),
      JSON.stringify(appendUser('x', T0)),
    ];
    await writeFile(join(dir, 'wire.jsonl'), `${good.join('\n')}\n{"type":"context.append_mess`, 'utf8');
    await writeState('sess-torn', { main: { type: 'main' } });
    const events = await planSessionReplay(homeDir, WS, 'sess-torn');
    expect(events.map((entry) => entry.event)).toEqual(['session.status', 'turn.completed']);
  });

  it('rejects a journal corrupted mid-file', async () => {
    const dir = join(homeDir, 'sessions', WS, 'sess-corrupt', 'agents', 'main');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'wire.jsonl'),
      `${JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: T0 })}\nnot-json\n${JSON.stringify({ type: 'turn.prompt', time: T0 })}\n`,
      'utf8',
    );
    await writeState('sess-corrupt', { main: { type: 'main' } });
    await expect(planSessionReplay(homeDir, WS, 'sess-corrupt')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('skips plan.updated when the plan file is unreadable', async () => {
    await writeJournal('sess-noplan', 'main', [
      { type: 'metadata', protocol_version: '1.5', created_at: T0 },
      { type: 'plan_mode.enter', id: 'plan-9', time: T0 + 1 },
      {
        type: 'plan.revision',
        id: 'plan-9',
        version: 1,
        path: `sessions/${WS}/sess-noplan/agents/main/plan/plan-9/v1.md`,
        time: T0 + 2,
      },
    ]);
    await writeState('sess-noplan', { main: { type: 'main' } });
    const events = await planSessionReplay(homeDir, WS, 'sess-noplan');
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Handler-level tests: structural engine fake (index + flush only), disk fixtures.
// ---------------------------------------------------------------------------

interface CollectedEvent {
  readonly sessionId: string;
  readonly event: string;
  readonly payload: JsonValue | undefined;
  readonly seq: number;
}

function makeHandlerFixture() {
  const events: CollectedEvent[] = [];
  const sequences = new Map<string, number>();
  const knownSessions = new Map<string, string>([[SESSION, WS], ['sess-empty', WS]]);
  const fakeIndex = {
    get: (sessionId: string) => {
      const workspaceId = knownSessions.get(sessionId);
      return Promise.resolve(
        workspaceId === undefined
          ? undefined
          : { id: sessionId, workspaceId, createdAt: T0, updatedAt: T0, archived: false },
      );
    },
  };
  const engine = {
    homeDir,
    app: {
      accessor: {
        get: (id: unknown) => {
          if (id === ISessionIndex) return fakeIndex;
          if (id === IAppendLogStore) return { flush: () => Promise.resolve() };
          throw new Error('unexpected service access');
        },
      },
    },
  } as unknown as EngineContext;
  const ctx: RuntimeHandlerContext = {
    adapter: {
      engineContext: engine,
      trackLiveSession: () => undefined,
      untrackLiveSession: () => undefined,
    },
    emitSessionEvent: (sessionId, event, payload) => {
      const seq = (sequences.get(sessionId) ?? 0) + 1;
      sequences.set(sessionId, seq);
      events.push({ sessionId, event, payload, seq });
      return Promise.resolve({ seq });
    },
    emitRuntimeEvent: () => Promise.resolve(),
  };
  const handlers = new Map<string, RuntimeMethodHandler>(createReplayHandlers(ctx));
  let counter = 0;
  const call = (method: string, params: JsonObject): Promise<JsonValue> => {
    const handler = handlers.get(method);
    if (handler === undefined) throw new Error(`no handler registered for ${method}`);
    const frame: RuntimeRequestFrame = {
      protocol: RUNTIME_PROTOCOL,
      type: 'request',
      id: `replay-test-${++counter}`,
      method,
      params,
    };
    return Promise.resolve(handler(frame)).then((result) => {
      if (typeof result === 'symbol') throw new Error(`${method} unexpectedly deferred`);
      return result;
    });
  };
  return { engine, events, call };
}

describe('session.replay handler', () => {
  it('rejects invalid params before touching the engine', async () => {
    const fixture = makeHandlerFixture();
    await expect(fixture.call('session.replay', { sessionId: '' })).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(
      fixture.call('session.replay', { sessionId: SESSION, fromSeq: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('answers session_not_found for an unknown session', async () => {
    const fixture = makeHandlerFixture();
    await expect(fixture.call('session.replay', { sessionId: 'nope' })).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });

  it('answers session_busy while a turn is active, then replays once settled', async () => {
    const fixture = makeHandlerFixture();
    clearActiveTurns(fixture.engine, SESSION);
    expect(hasActiveTurn(fixture.engine, SESSION)).toBe(false);
    registerActiveTurn(fixture.engine, SESSION, 'req-live');
    expect(hasActiveTurn(fixture.engine, SESSION)).toBe(true);
    await expect(fixture.call('session.replay', { sessionId: SESSION })).rejects.toMatchObject({
      code: 'session_busy',
    });
    expect(fixture.events).toEqual([]);
    clearActiveTurns(fixture.engine, SESSION);
    const result = await fixture.call('session.replay', { sessionId: SESSION });
    expect(result).toMatchObject({ sessionId: SESSION, truncated: false });
  });

  it('emits the burst with continuing seqs and closes with counters', async () => {
    const fixture = makeHandlerFixture();
    const result = await fixture.call('session.replay', { sessionId: SESSION });
    expect(fixture.events).toHaveLength(17);
    expect(fixture.events[0]?.event).toBe('session.status');
    expect(fixture.events.at(-1)?.event).toBe('subagent.updated');
    // Seqs are the server's natural continuation: consecutive from 1 here.
    expect(fixture.events.map((entry) => entry.seq)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
    expect(wire(result)).toEqual({
      sessionId: SESSION,
      events: 17,
      fromSeq: 1,
      toSeq: 17,
      truncated: false,
    });
  });

  it('paginates with fromSeq/limit and reports truncated', async () => {
    const fixture = makeHandlerFixture();
    // First burst: seqs 1..17 (fresh counter), toSeq is the client's cursor.
    await fixture.call('session.replay', { sessionId: SESSION });
    // Incremental re-replay at the watermark: nothing newer, zero counters.
    const caughtUp = await fixture.call('session.replay', { sessionId: SESSION, fromSeq: 17 });
    expect(wire(caughtUp)).toEqual({
      sessionId: SESSION,
      events: 0,
      fromSeq: 0,
      toSeq: 0,
      truncated: false,
    });
    // A window into the burst: positions 3..5 (0-based skip 2), emitted with
    // fresh seqs continuing the session counter (18..20).
    fixture.events.length = 0;
    const page = await fixture.call('session.replay', { sessionId: SESSION, fromSeq: 2, limit: 3 });
    expect(fixture.events.map((entry) => entry.event)).toEqual([
      'content.delta',
      'tool.started',
      'tool.completed',
    ]);
    expect(wire(page)).toEqual({
      sessionId: SESSION,
      events: 3,
      fromSeq: 18,
      toSeq: 20,
      truncated: true,
    });
  });

  it('answers zero counters for empty history', async () => {
    await writeJournal('sess-empty', 'main', [
      { type: 'metadata', protocol_version: '1.5', created_at: T0 },
    ]);
    await writeState('sess-empty', { main: { type: 'main' } });
    const fixture = makeHandlerFixture();
    const result = await fixture.call('session.replay', { sessionId: 'sess-empty' });
    expect(fixture.events).toEqual([]);
    expect(wire(result)).toEqual({
      sessionId: 'sess-empty',
      events: 0,
      fromSeq: 0,
      toSeq: 0,
      truncated: false,
    });
  });
});
