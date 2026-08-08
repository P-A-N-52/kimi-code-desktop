import type { DomainEvent, Interaction, TokenUsage } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import {
  engineContentToWireInput,
  mcpLoadingTransition,
  slashCommandsUpdatePayload,
  statusUpdatedEmissions,
  translateApprovalInteraction,
  translateDomainEvent,
  translatePromptSteered,
  translateQuestionInteraction,
  translateTurnEnded,
  type AgentStatusSnapshot,
  type EventTranslateContext,
} from '../src/event-bridge';
import type { JsonValue } from '../src/protocol';

const MAIN: EventTranslateContext = { agentId: 'main', isMainAgent: true, requestId: 'req-1' };
const SUBAGENT: EventTranslateContext = {
  agentId: 'agent-7',
  isMainAgent: false,
  provenance: { parentToolCallId: 'tc-parent', subagentType: 'explore' },
};

/** The exact JSON shape the wire carries (undefined fields dropped). */
function wire<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

describe('translateDomainEvent', () => {
  it('maps main-agent assistant/thinking deltas with the registered requestId', () => {
    const delta = translateDomainEvent(
      { type: 'assistant.delta', turnId: 3, delta: 'hello' },
      MAIN,
    );
    expect(delta).toMatchObject({ event: 'content.delta' });
    expect(wire(delta?.payload)).toEqual({ text: 'hello', requestId: 'req-1' });

    const thinking = translateDomainEvent(
      { type: 'thinking.delta', turnId: 3, delta: 'hmm' },
      { agentId: 'main', isMainAgent: true },
    );
    expect(thinking).toMatchObject({ event: 'thinking.delta' });
    expect(wire(thinking?.payload)).toEqual({ text: 'hmm' });
  });

  it('drops subagent assistant/thinking deltas', () => {
    expect(
      translateDomainEvent({ type: 'assistant.delta', turnId: 1, delta: 'x' }, SUBAGENT),
    ).toBeNull();
    expect(
      translateDomainEvent({ type: 'thinking.delta', turnId: 1, delta: 'x' }, SUBAGENT),
    ).toBeNull();
  });

  it('maps tool.call.started with serialized arguments and main-agent nulls', () => {
    const translated = translateDomainEvent(
      {
        type: 'tool.call.started',
        turnId: 3,
        toolCallId: 'tc-1',
        name: 'bash',
        args: { command: 'ls' },
        description: 'list files',
        display: { kind: 'command', command: 'ls' },
      },
      MAIN,
    );
    expect(translated).toMatchObject({ event: 'tool.started' });
    expect(wire(translated?.payload)).toEqual({
      toolCallId: 'tc-1',
      name: 'bash',
      arguments: '{"command":"ls"}',
      requestId: 'req-1',
      parentToolCallId: null,
      agentId: null,
      description: 'list files',
      display: { kind: 'command', command: 'ls' },
    });
  });

  it('stamps subagent tool events with stable ids and parent provenance', () => {
    const translated = translateDomainEvent(
      { type: 'tool.call.started', turnId: 1, toolCallId: 'tc-9', name: 'grep', args: 'raw' },
      SUBAGENT,
    );
    expect(wire(translated?.payload)).toEqual({
      toolCallId: 'tc-9',
      name: 'grep',
      arguments: 'raw',
      parentToolCallId: 'tc-parent',
      agentId: 'agent-7',
    });
  });

  it('maps tool.call.delta and tool.result', () => {
    const delta = translateDomainEvent(
      { type: 'tool.call.delta', turnId: 3, toolCallId: 'tc-1', argumentsPart: '{}' },
      MAIN,
    );
    expect(delta).toMatchObject({ event: 'tool.updated' });
    expect(wire(delta?.payload)).toEqual({ toolCallId: 'tc-1', argumentsPart: '{}' });

    const result = translateDomainEvent(
      { type: 'tool.result', turnId: 3, toolCallId: 'tc-1', output: 'done' },
      MAIN,
    );
    expect(result).toMatchObject({ event: 'tool.completed' });
    expect(wire(result?.payload)).toEqual({ toolCallId: 'tc-1', isError: false, output: 'done' });

    const failed = translateDomainEvent(
      { type: 'tool.result', turnId: 3, toolCallId: 'tc-2', output: 'boom', isError: true },
      MAIN,
    );
    expect(wire(failed?.payload)).toEqual({ toolCallId: 'tc-2', isError: true, output: 'boom' });
  });

  it('maps the subagent lifecycle onto subagent.updated phases', () => {
    const spawned = translateDomainEvent(
      {
        type: 'subagent.spawned',
        subagentId: 'agent-7',
        subagentName: 'explore',
        parentToolCallId: 'tc-parent',
        description: 'look around',
        runInBackground: false,
      },
      MAIN,
    );
    expect(wire(spawned?.payload)).toEqual({
      phase: 'spawned',
      agentId: 'agent-7',
      parentToolCallId: 'tc-parent',
      subagentType: 'explore',
      description: 'look around',
    });

    // The engine emits an empty parentToolCallId when there is none.
    const orphaned = translateDomainEvent(
      {
        type: 'subagent.spawned',
        subagentId: 'agent-8',
        subagentName: 'explore',
        parentToolCallId: '',
        runInBackground: true,
      },
      MAIN,
    );
    expect(wire(orphaned?.payload)).toMatchObject({ parentToolCallId: null });

    const completed = translateDomainEvent(
      { type: 'subagent.completed', subagentId: 'agent-7', resultSummary: 'done' },
      SUBAGENT,
    );
    expect(wire(completed?.payload)).toEqual({
      phase: 'completed',
      agentId: 'agent-7',
      parentToolCallId: 'tc-parent',
      subagentType: 'explore',
      resultSummary: 'done',
    });

    const failed = translateDomainEvent(
      { type: 'subagent.failed', subagentId: 'agent-7', error: 'nope' },
      SUBAGENT,
    );
    expect(wire(failed?.payload)).toMatchObject({ phase: 'failed', error: 'nope' });

    const suspended = translateDomainEvent(
      { type: 'subagent.suspended', subagentId: 'agent-7', reason: 'budget' },
      SUBAGENT,
    );
    expect(wire(suspended?.payload)).toMatchObject({ phase: 'suspended', reason: 'budget' });
  });

  it('maps task lifecycle events onto task.updated with the info fields', () => {
    const info = {
      kind: 'process' as const,
      command: 'ls',
      pid: 42,
      exitCode: null,
      taskId: 'task-1',
      description: 'list files',
      status: 'running' as const,
      startedAt: 1000,
      endedAt: null,
    };
    const started = translateDomainEvent({ type: 'task.started', info }, MAIN);
    expect(started).toMatchObject({ event: 'task.updated' });
    expect(wire(started?.payload)).toEqual({ ...info });

    const terminated = translateDomainEvent(
      { type: 'task.terminated', info: { ...info, status: 'completed' as const, endedAt: 2000 } },
      MAIN,
    );
    expect(wire(terminated?.payload)).toMatchObject({ taskId: 'task-1', status: 'completed' });
  });

  it('drops engine events with no runtime-v1 counterpart', () => {
    const dropped: readonly DomainEvent[] = [
      { type: 'turn.started', turnId: 1, origin: { kind: 'user' } },
      { type: 'turn.ended', turnId: 1, reason: 'completed' },
      { type: 'turn.step.completed', turnId: 1, step: 1 },
      {
        type: 'tool.progress',
        turnId: 1,
        toolCallId: 'tc-1',
        update: { kind: 'stdout', text: 'x' },
      },
      { type: 'prompt.completed', promptId: 'p-1', finishedAt: 'now', reason: 'completed' },
      { type: 'prompt.aborted', promptId: 'p-1', abortedAt: 'now' },
      { type: 'agent.status.updated', planMode: true },
      { type: 'agent.activity.updated', lifecycle: 'ready', background: [] },
      {
        type: 'plan.revision',
        id: 'plan-1',
        version: 1,
        path: 'plans/plan-1.md',
        sha256: 'x',
        bytes: 1,
      },
    ];
    for (const event of dropped) {
      expect(translateDomainEvent(event, MAIN)).toBeNull();
    }
  });
});

describe('step.* fidelity events', () => {
  it('maps turn.step.started to step.begin for the main agent only', () => {
    const begun = translateDomainEvent({ type: 'turn.step.started', turnId: 3, step: 2 }, MAIN);
    expect(begun).toMatchObject({ event: 'step.begin' });
    expect(wire(begun?.payload)).toEqual({ n: 2, requestId: 'req-1' });

    // Without a registered turn there is no requestId.
    const anonymous = translateDomainEvent(
      { type: 'turn.step.started', turnId: 9, step: 1 },
      { agentId: 'main', isMainAgent: true },
    );
    expect(wire(anonymous?.payload)).toEqual({ n: 1 });

    // Subagent steps never reach the main transcript.
    expect(
      translateDomainEvent({ type: 'turn.step.started', turnId: 1, step: 1 }, SUBAGENT),
    ).toBeNull();
  });

  it('maps turn.step.interrupted to step.interrupted for the main agent only', () => {
    const interrupted = translateDomainEvent(
      { type: 'turn.step.interrupted', turnId: 3, step: 2, reason: 'user_cancelled' },
      MAIN,
    );
    expect(interrupted).toMatchObject({ event: 'step.interrupted' });
    expect(wire(interrupted?.payload)).toEqual({ requestId: 'req-1' });

    expect(
      translateDomainEvent(
        { type: 'turn.step.interrupted', turnId: 1, step: 1, reason: 'x' },
        SUBAGENT,
      ),
    ).toBeNull();
  });

  it('maps turn.step.retrying to the snake_case step.retry payload', () => {
    const retry = translateDomainEvent(
      {
        type: 'turn.step.retrying',
        turnId: 3,
        step: 1,
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 4000,
        errorName: 'APIStatusError',
        errorMessage: '429 too many requests',
        statusCode: 429,
      },
      MAIN,
    );
    expect(retry).toMatchObject({ event: 'step.retry' });
    expect(wire(retry?.payload)).toEqual({
      n: 1,
      next_attempt: 2,
      max_attempts: 3,
      wait_s: 4,
      error_type: 'APIStatusError',
      status_code: 429,
      requestId: 'req-1',
    });

    // statusCode is absent on non-HTTP failures; the wire field goes null.
    const timeout = translateDomainEvent(
      {
        type: 'turn.step.retrying',
        turnId: 3,
        step: 2,
        failedAttempt: 2,
        nextAttempt: 3,
        maxAttempts: 3,
        delayMs: 1500,
        errorName: 'APITimeoutError',
        errorMessage: 'timed out',
      },
      MAIN,
    );
    expect(wire(timeout?.payload)).toEqual({
      n: 2,
      next_attempt: 3,
      max_attempts: 3,
      wait_s: 1.5,
      error_type: 'APITimeoutError',
      status_code: null,
      requestId: 'req-1',
    });

    expect(
      translateDomainEvent(
        {
          type: 'turn.step.retrying',
          turnId: 1,
          step: 1,
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 3,
          delayMs: 1,
          errorName: 'X',
          errorMessage: 'x',
        },
        SUBAGENT,
      ),
    ).toBeNull();
  });
});

describe('compaction.* fidelity events', () => {
  it('maps compaction.started/completed for the main agent', () => {
    const begun = translateDomainEvent(
      { type: 'compaction.started', trigger: 'auto' },
      MAIN,
    );
    expect(begun).toMatchObject({ event: 'compaction.begin' });
    expect(wire(begun?.payload)).toEqual({ source: 'auto' });

    const completed = translateDomainEvent(
      {
        type: 'compaction.completed',
        result: { summary: 's', compactedCount: 4, tokensBefore: 100, tokensAfter: 40 },
      },
      MAIN,
    );
    expect(completed).toMatchObject({ event: 'compaction.end' });
    expect(wire(completed?.payload)).toEqual({});
  });

  it('drops blocked/cancelled and every subagent compaction event', () => {
    expect(
      translateDomainEvent({ type: 'compaction.blocked', turnId: 3 }, MAIN),
    ).toBeNull();
    expect(translateDomainEvent({ type: 'compaction.cancelled' }, MAIN)).toBeNull();
    expect(
      translateDomainEvent({ type: 'compaction.started', trigger: 'auto' }, SUBAGENT),
    ).toBeNull();
    expect(
      translateDomainEvent(
        {
          type: 'compaction.completed',
          result: { summary: 's', compactedCount: 1, tokensBefore: 5, tokensAfter: 2 },
        },
        SUBAGENT,
      ),
    ).toBeNull();
  });
});

describe('translatePromptSteered', () => {
  it('collapses all-text content to one joined string', () => {
    const translated = translatePromptSteered(
      {
        type: 'prompt.steered',
        activePromptId: 'p-1',
        promptIds: ['p-2'],
        content: [
          { type: 'text', text: 'also ' },
          { type: 'text', text: 'check tests' },
        ],
        steeredAt: 'now',
      },
      'req-9',
    );
    expect(translated).toMatchObject({ event: 'turn.steered' });
    expect(wire(translated.payload)).toEqual({ requestId: 'req-9', input: 'also check tests' });
  });

  it('crosses mixed content as wire content parts with snake_case media keys', () => {
    const translated = translatePromptSteered(
      {
        type: 'prompt.steered',
        activePromptId: 'p-1',
        promptIds: ['p-2'],
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', imageUrl: { url: 'https://example.com/a.png', id: 'm1' } },
          { type: 'video_url', videoUrl: { url: 'https://example.com/b.mp4' } },
        ],
        steeredAt: 'now',
      },
      'req-9',
    );
    expect(wire(translated.payload)).toEqual({
      requestId: 'req-9',
      input: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png', id: 'm1' } },
        { type: 'video_url', video_url: { url: 'https://example.com/b.mp4' } },
      ],
    });
  });

  it('engineContentToWireInput keeps think and audio parts', () => {
    expect(
      wire(
        engineContentToWireInput([
          { type: 'think', think: 'hmm', encrypted: 'enc' },
          { type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3' } },
        ]),
      ),
    ).toEqual([
      { type: 'think', think: 'hmm', encrypted: 'enc' },
      { type: 'audio_url', audio_url: { url: 'https://example.com/a.mp3' } },
    ]);
    expect(wire(engineContentToWireInput([]))).toEqual('');
  });
});

describe('mcpLoadingTransition', () => {
  it('begins on 0 -> >0 pending and ends on >0 -> 0', () => {
    expect(mcpLoadingTransition(false, 0)).toBeNull();
    expect(mcpLoadingTransition(false, 2)).toBe('mcp.loading.begin');
    expect(mcpLoadingTransition(true, 1)).toBeNull();
    expect(mcpLoadingTransition(true, 0)).toBe('mcp.loading.end');
  });
});

describe('slashCommandsUpdatePayload', () => {
  it('maps the skill catalog with the ACP-era naming and ordering rules', () => {
    const payload = slashCommandsUpdatePayload([
      { name: 'zeta', description: 'user skill', path: '/u/zeta', source: 'user' },
      { name: 'alpha', description: 'project skill', path: '/p/alpha', source: 'project' },
      { name: 'docs', description: 'builtin skill', path: '/b/docs', source: 'builtin' },
      { name: 'sub', description: 'sub skill', path: '/u/sub', source: 'user', isSubSkill: true },
      { name: 'ref', description: 'reference', path: '/u/ref', source: 'user', type: 'reference' },
      { name: 'flowy', description: 'flow', path: '/u/flowy', source: 'extra', type: 'flow' },
    ]);
    expect(wire(payload)).toEqual({
      slash_commands: [
        {
          name: 'docs',
          description: 'builtin skill',
          aliases: [],
          input_hint: null,
          source: 'runtime',
        },
        {
          name: 'skill:alpha',
          description: 'project skill',
          aliases: [],
          input_hint: null,
          source: 'runtime:skill',
        },
        {
          name: 'skill:flowy',
          description: 'flow',
          aliases: [],
          input_hint: null,
          source: 'runtime:skill',
        },
        {
          name: 'sub',
          description: 'sub skill',
          aliases: [],
          input_hint: null,
          source: 'runtime',
        },
        {
          name: 'skill:zeta',
          description: 'user skill',
          aliases: [],
          input_hint: null,
          source: 'runtime:skill',
        },
      ],
    });
  });
});

describe('translateTurnEnded', () => {
  const usage: TokenUsage = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 };

  it('synthesizes turn.completed with snake_case usage when present', () => {
    const translated = translateTurnEnded(
      { type: 'turn.ended', turnId: 3, reason: 'completed' },
      'req-1',
      usage,
    );
    expect(translated).toMatchObject({ event: 'turn.completed' });
    expect(wire(translated.payload)).toEqual({
      requestId: 'req-1',
      usage: { input_other: 1, output: 2, input_cache_read: 3, input_cache_creation: 4 },
    });

    const bare = translateTurnEnded({ type: 'turn.ended', turnId: 3, reason: 'completed' }, 'req-1');
    expect(wire(bare.payload)).toEqual({ requestId: 'req-1' });
  });

  it('synthesizes turn.failed from the engine error payload', () => {
    const translated = translateTurnEnded(
      {
        type: 'turn.ended',
        turnId: 3,
        reason: 'failed',
        error: { code: 'model.not_found', message: 'no model', retryable: false },
      },
      'req-1',
    );
    expect(translated).toMatchObject({ event: 'turn.failed' });
    expect(wire(translated.payload)).toEqual({
      requestId: 'req-1',
      error: { code: 'model.not_found', message: 'no model', retryable: false },
    });
  });

  it('maps cancelled and blocked turns onto turn.failed with distinguishing codes', () => {
    const cancelled = translateTurnEnded(
      { type: 'turn.ended', turnId: 3, reason: 'cancelled' },
      'req-1',
    );
    expect(wire(cancelled.payload)).toEqual({
      requestId: 'req-1',
      error: { code: 'cancelled', message: 'Turn cancelled.', retryable: false },
    });

    const blocked = translateTurnEnded({ type: 'turn.ended', turnId: 3, reason: 'blocked' }, 'req-1');
    expect(wire(blocked.payload)).toMatchObject({ error: { code: 'turn_blocked' } });

    const bare = translateTurnEnded({ type: 'turn.ended', turnId: 3, reason: 'failed' }, 'req-1');
    expect(wire(bare.payload)).toMatchObject({ error: { code: 'turn_failed' } });
  });
});

describe('statusUpdatedEmissions', () => {
  it('emits usage.updated from a usage slice against the accumulated snapshot', () => {
    const snapshot: AgentStatusSnapshot = {
      contextTokens: 50,
      maxContextTokens: 200,
      totalUsage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
    };
    const emissions = statusUpdatedEmissions(
      { type: 'agent.status.updated', usage: { total: snapshot.totalUsage } },
      snapshot,
    );
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({ event: 'usage.updated' });
    expect(wire(emissions[0]?.payload)).toEqual({
      contextUsage: 0.25,
      contextTokens: 50,
      maxContextTokens: 200,
      tokenUsage: { input_other: 10, output: 5, input_cache_read: 2, input_cache_creation: 1 },
    });
  });

  it('emits session.config from a model slice and nothing from a planMode slice', () => {
    const model = statusUpdatedEmissions({ type: 'agent.status.updated', model: 'k2' }, {});
    expect(model.map((entry) => entry.event)).toEqual(['session.config']);
    expect(wire(model[0]?.payload)).toEqual({ model: 'k2' });

    expect(statusUpdatedEmissions({ type: 'agent.status.updated', planMode: true }, {})).toEqual(
      [],
    );
  });

  it('reports nulls when the snapshot has no usage facts yet', () => {
    const emissions = statusUpdatedEmissions({ type: 'agent.status.updated', contextTokens: 5 }, {
      contextTokens: 5,
    });
    expect(wire(emissions[0]?.payload)).toEqual({
      contextUsage: null,
      contextTokens: 5,
      maxContextTokens: null,
      tokenUsage: null,
    });
  });
});

describe('interaction translators', () => {
  it('translates a parked approval into approval.requested with display blocks', () => {
    const interaction: Interaction = {
      id: 'ap-1',
      kind: 'approval',
      payload: {
        toolName: 'bash',
        action: 'run command',
        toolCallId: 'tc-1',
        agentId: 'main',
        turnId: 2,
        display: { kind: 'command', command: 'ls -la', description: 'list files' },
      },
      origin: { agentId: 'main', turnId: 2 },
      createdAt: 0,
    };
    const translated = translateApprovalInteraction(interaction);
    expect(translated).toMatchObject({ event: 'approval.requested' });
    expect(wire(translated.payload)).toEqual({
      approvalId: 'ap-1',
      action: 'run command',
      toolCallId: 'tc-1',
      kind: null,
      display: [
        { type: 'command', data: { kind: 'command', command: 'ls -la', description: 'list files' } },
      ],
      toolName: 'bash',
      agentId: 'main',
      turnId: 2,
    });
  });

  it('translates a parked question into question.requested with snake_case items', () => {
    const interaction: Interaction = {
      id: 'q-1',
      kind: 'question',
      payload: {
        toolCallId: 'tc-9',
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            body: 'details',
            options: [{ label: 'a', description: 'first' }, { label: 'b' }],
            multiSelect: true,
            otherLabel: 'Other',
            otherDescription: 'free text',
          },
        ],
      },
      origin: {},
      createdAt: 0,
    };
    const translated = translateQuestionInteraction(interaction);
    expect(translated).toMatchObject({ event: 'question.requested' });
    expect(wire(translated.payload)).toEqual({
      questionId: 'q-1',
      toolCallId: 'tc-9',
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          body: 'details',
          options: [{ label: 'a', description: 'first' }, { label: 'b' }],
          multi_select: true,
          other_label: 'Other',
          other_description: 'free text',
        },
      ],
    });
  });
});
