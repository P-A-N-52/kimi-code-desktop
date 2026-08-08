/**
 * Snapshot → replay burst mapping for `session.replay`: project one agent's
 * cold-rebuilt transcript snapshot into M1 session events whose names and
 * payload shapes match the live stream (event-bridge.ts) exactly.
 *
 * Per-agent block layout (main agent):
 * - turn → leading `session.status` busy carrying the minted replay
 *   `requestId` (`replay-<agentId>-t<ordinal>`, deterministic across
 *   re-replays) plus the replay-only extras `prompt` / `attachments` — the
 *   live bridge never sets them; the Rust replay adapter uses the prompt to
 *   synthesize the wire `TurnBegin` (runtime-v1 deliberately has no
 *   turn-begin event), every other consumer ignores the extras. Then the
 *   step frames (`content.delta` / `thinking.delta` / `tool.started` /
 *   `tool.completed`), then the terminal `turn.completed` / `turn.failed`
 *   (cancelled folds into `turn.failed` with code `cancelled`, mirroring
 *   `translateTurnEnded`).
 * - `plan.revision` markers → `plan.updated` with the content read back from
 *   the record's homeDir-relative plan file (unreadable → skipped; the live
 *   bridge likewise drops plans it cannot read).
 * - resolved interactions → `approval.requested` / `question.requested` via
 *   the event bridge's own pure translators (identical payloads by
 *   construction), emitted after the turns so the referenced tool call is
 *   already replayed. runtime-v1 has no resolution event, so replayed
 *   interactions render as resolved historical artifacts.
 * - non-subagent tasks → one `task.updated` each, in the live `AgentTaskInfo`
 *   field vocabulary (epoch-ms `startedAt` / `endedAt`, `status`, `kind`
 *   spelled back to the engine's `process` / `agent`).
 *
 * Subagent blocks (assembled by `planSessionReplay`): `subagent.updated`
 * spawned → the subagent's own tool events → its task's `task.updated` →
 * terminal `subagent.updated`. Subagent assistant text/thinking and turn
 * terminals are NOT replayed, matching the live bridge, which drops them for
 * non-main agents. Positions are approximate (degradation 6 in
 * replay-router.ts): blocks trail the main agent's, and lifecycle timing
 * inside the parent turn is unrecoverable from cold data.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MAIN_AGENT_ID, type Interaction } from '@moonshot-ai/agent-core-v2';

import type {
  AgentTranscriptSnapshot,
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptItem,
  TranscriptTask,
  TranscriptTurn,
} from '@moonshot-ai/transcript';

import {
  translateApprovalInteraction,
  translateQuestionInteraction,
  type TranslatedSessionEvent,
} from '../event-bridge';
import type { JsonValue } from '../protocol';

import { listAgentIds, readAgentWireJournal, rebuildAgentSnapshot, sessionDirectory } from './journal';

function asPayload(value: { readonly [key: string]: unknown }): JsonValue {
  return value as JsonValue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deterministic per-turn requestId: identical across re-replays. */
function replayRequestId(agentId: string, turn: TranscriptTurn): string {
  return `replay-${agentId}-t${turn.ordinal}`;
}

/** Live `tool.started` carries the arguments as a string; cold frames hold the parsed input. */
function replayArguments(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function frameReplayEvents(
  frame: TranscriptFrame,
  agentId: string,
  isMainAgent: boolean,
  requestId: string | undefined,
): TranslatedSessionEvent[] {
  switch (frame.kind) {
    case 'text':
      // User text is the turn prompt (carried by the leading busy event);
      // step text frames are assistant content by construction. Subagent
      // assistant streams have no M1 representation (same as live).
      if (frame.role !== 'assistant' || !isMainAgent) return [];
      return [{ event: 'content.delta', payload: asPayload({ text: frame.text, requestId }) }];
    case 'thinking':
      if (!isMainAgent) return [];
      return [{ event: 'thinking.delta', payload: asPayload({ text: frame.text, requestId }) }];
    case 'tool': {
      const started: TranslatedSessionEvent = {
        event: 'tool.started',
        payload: asPayload({
          toolCallId: frame.toolCallId,
          name: frame.name,
          arguments: replayArguments(frame.input),
          requestId,
          // Subagent provenance is not persisted (degradation 8): the parent
          // link replays as null and the Rust fallback renders top-level.
          parentToolCallId: null,
          agentId: isMainAgent ? null : agentId,
        }),
      };
      if (frame.state === 'running') {
        // The result was never persisted (crash mid-call) — replay the call
        // without a completion, exactly what the journal proves.
        return [started];
      }
      const isError = frame.state === 'error';
      return [
        started,
        {
          event: 'tool.completed',
          payload: asPayload({
            toolCallId: frame.toolCallId,
            isError,
            output: (isError ? (frame.error ?? frame.output) : frame.output) as JsonValue,
          }),
        },
      ];
    }
    case 'notice':
      // Notice frames never come out of the cold rebuild.
      return [];
    default:
      return [];
  }
}

/** Attachment entities referenced by a turn, as plain replay metadata (degradation 4). */
function turnAttachments(
  turn: TranscriptTurn,
  attachments: readonly TranscriptAttachment[],
): JsonValue | undefined {
  if (turn.attachmentIds === undefined || turn.attachmentIds.length === 0) return undefined;
  const entities = attachments.filter((entity) => turn.attachmentIds?.includes(entity.attachmentId));
  if (entities.length === 0) return undefined;
  return entities.map((entity) => ({ ...entity })) as unknown as JsonValue;
}

function terminalReplayEvent(turn: TranscriptTurn, requestId: string): TranslatedSessionEvent {
  if (turn.state === 'failed') {
    return {
      event: 'turn.failed',
      payload: asPayload({
        requestId,
        error: {
          code: 'turn_failed',
          message: turn.error ?? 'Turn failed.',
          retryable: false,
        },
      }),
    };
  }
  if (turn.state === 'cancelled') {
    return {
      event: 'turn.failed',
      payload: asPayload({
        requestId,
        error: { code: 'cancelled', message: 'Turn cancelled.', retryable: false },
      }),
    };
  }
  // `queued`/`running` cannot come out of the cold rebuild (the grouping
  // defaults to completed); they fold into the completed form here anyway.
  return { event: 'turn.completed', payload: asPayload({ requestId }) };
}

/** `plan.revision` marker → `plan.updated`; null when the content is unreadable. */
async function planRevisionReplayEvent(
  homeDir: string,
  item: Extract<TranscriptItem, { kind: 'marker' }>,
): Promise<TranslatedSessionEvent | null> {
  const path = isPlainObject(item.payload) ? item.payload['path'] : undefined;
  if (typeof path !== 'string' || path.length === 0) return null;
  try {
    const content = await readFile(join(homeDir, path), 'utf8');
    return { event: 'plan.updated', payload: asPayload({ content, filePath: path }) };
  } catch {
    return null;
  }
}

/** Resolved interaction → the bridge's own request translators (same payload as live). */
function interactionReplayEvent(
  interaction: TranscriptInteraction,
): TranslatedSessionEvent | null {
  if (!isPlainObject(interaction.request)) return null;
  const fabricated: Interaction = {
    id: interaction.interactionId,
    kind: interaction.interactionKind,
    payload: interaction.request,
    origin: {},
    createdAt: 0,
  };
  return interaction.interactionKind === 'approval'
    ? translateApprovalInteraction(fabricated)
    : translateQuestionInteraction(fabricated);
}

/** The transcript task kind spells the engine's `process`/`agent` kinds back. */
function engineTaskKind(kind: TranscriptTask['kind']): string {
  switch (kind) {
    case 'shell':
      return 'process';
    case 'subagent':
      return 'agent';
    case 'tool':
    case 'other':
      return 'other';
    default:
      return 'other';
  }
}

function taskReplayEvent(task: TranscriptTask): TranslatedSessionEvent {
  // Live `task.updated` payloads are the engine's AgentTaskInfo spread
  // (epoch-ms timestamps, `status`, `endedAt` null while running).
  const startedAt = task.startedAt === undefined ? undefined : Date.parse(task.startedAt);
  const endedAt = task.endedAt === undefined ? null : Date.parse(task.endedAt);
  return {
    event: 'task.updated',
    payload: asPayload({
      taskId: task.taskId,
      kind: engineTaskKind(task.kind),
      status: task.state,
      detached: task.detached,
      description: task.description,
      agentId: task.agentId,
      startedAt,
      endedAt,
    }),
  };
}

/** Live `subagent.updated` terminal phase for a rebuilt subagent task state. */
function subagentTerminalPhase(state: TranscriptTask['state']): string {
  return state === 'completed' ? 'completed' : 'failed';
}

function subagentLifecycleEvent(
  phase: string,
  agentId: string,
  description?: string,
): TranslatedSessionEvent {
  return {
    event: 'subagent.updated',
    payload: asPayload({
      phase,
      agentId,
      parentToolCallId: null,
      subagentType: null,
      description,
    }),
  };
}

/**
 * One agent's replay block (see the module header for the layout). Reads
 * plan files for `plan.revision` markers, so it is async unlike the pure
 * live translators.
 */
async function agentReplayEvents(
  homeDir: string,
  agentId: string,
  isMainAgent: boolean,
  snapshot: AgentTranscriptSnapshot,
): Promise<TranslatedSessionEvent[]> {
  const events: TranslatedSessionEvent[] = [];
  for (const item of snapshot.items) {
    if (item.kind === 'turn') {
      if (!isMainAgent) {
        for (const step of item.steps) {
          for (const frame of step.frames) {
            events.push(...frameReplayEvents(frame, agentId, false, undefined));
          }
        }
        continue;
      }
      const requestId = replayRequestId(agentId, item);
      events.push({
        event: 'session.status',
        payload: asPayload({
          state: 'busy',
          requestId,
          prompt: item.prompt,
          attachments: turnAttachments(item, snapshot.attachments),
        }),
      });
      for (const step of item.steps) {
        for (const frame of step.frames) {
          events.push(...frameReplayEvents(frame, agentId, true, requestId));
        }
      }
      events.push(terminalReplayEvent(item, requestId));
      continue;
    }
    if (item.kind === 'marker' && item.marker === 'plan.revision') {
      const plan = await planRevisionReplayEvent(homeDir, item);
      if (plan !== null) events.push(plan);
    }
    // Other markers and taskrefs have no M1 session-event counterpart.
  }
  if (isMainAgent) {
    for (const interaction of snapshot.interactions) {
      const translated = interactionReplayEvent(interaction);
      if (translated !== null) events.push(translated);
    }
    for (const task of snapshot.tasks) {
      if (task.kind === 'subagent') continue; // emitted inside the subagent block
      events.push(taskReplayEvent(task));
    }
  }
  return events;
}

/**
 * Assemble the session's full replay burst: the main agent's block, then one
 * block per known subagent (lifecycle events from its task facts when a
 * journal recorded the run). Agents without any persisted trace contribute
 * nothing; a session with no journals yields an empty burst.
 */
export async function planSessionReplay(
  homeDir: string,
  workspaceId: string,
  sessionId: string,
): Promise<TranslatedSessionEvent[]> {
  const sessionDir = sessionDirectory(homeDir, workspaceId, sessionId);
  const agentIds = await listAgentIds(sessionDir);
  const snapshots = new Map<string, AgentTranscriptSnapshot>();
  for (const agentId of agentIds) {
    const records = await readAgentWireJournal(sessionDir, agentId);
    if (records === undefined) continue;
    snapshots.set(agentId, rebuildAgentSnapshot(records));
  }

  const events: TranslatedSessionEvent[] = [];
  /** Subagent task facts recorded on any journal, keyed by agent id. */
  const subagentTasks = new Map<string, TranscriptTask>();
  for (const snapshot of snapshots.values()) {
    for (const task of snapshot.tasks) {
      if (task.kind === 'subagent' && task.agentId !== undefined) {
        subagentTasks.set(task.agentId, task);
      }
    }
  }
  const mainSnapshot = snapshots.get(MAIN_AGENT_ID);
  if (mainSnapshot !== undefined) {
    events.push(...(await agentReplayEvents(homeDir, MAIN_AGENT_ID, true, mainSnapshot)));
  }
  for (const agentId of agentIds) {
    if (agentId === MAIN_AGENT_ID) continue;
    const snapshot = snapshots.get(agentId);
    const task = subagentTasks.get(agentId);
    if (snapshot === undefined && task === undefined) continue;
    const block: TranslatedSessionEvent[] = [];
    if (task !== undefined) {
      block.push(subagentLifecycleEvent('spawned', agentId, task.description));
    }
    if (snapshot !== undefined) {
      block.push(...(await agentReplayEvents(homeDir, agentId, false, snapshot)));
    }
    if (task !== undefined) {
      block.push(taskReplayEvent(task));
      block.push(
        subagentLifecycleEvent(
          task.state === 'running' ? 'started' : subagentTerminalPhase(task.state),
          agentId,
        ),
      );
    }
    events.push(...block);
  }
  return events;
}
