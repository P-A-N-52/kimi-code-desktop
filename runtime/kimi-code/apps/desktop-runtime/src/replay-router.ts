/**
 * runtime-v1 `session.replay` — streaming history replay (M3 wave 2).
 *
 * Design (frozen in protocol-parity.ts): the request triggers a burst of
 * ordinary session event frames — same event names and payload shapes as the
 * live stream (event-bridge.ts), per-session seq continuing via the server's
 * emit counter — and the response closes the burst with counters. A burst
 * never interleaves with a live turn of the same session: an open registered
 * turn rejects the request with `session_busy` (a read-only probe of the
 * turn-router registry, `hasActiveTurn`).
 *
 * The cold rebuild and the snapshot→burst mapping live in the `replay/`
 * submodule (the 600-line module budget): `replay/journal.ts` reads and
 * migrates `wire.jsonl` journals and folds them into transcript snapshots
 * (the kap-server pipeline, engine-free); `replay/map.ts` projects snapshots
 * into the M1 session-event burst.
 *
 * Known degradations (the ten wave-1 gap items; cold data simply lacks these):
 * 1. live-only fields are never backfilled — step usage/finishReason/timing,
 *    tool inputText/progress/display/description, task resultSummary/error/
 *    output preview are omitted (the fold does not rebuild them).
 * 2. v1 journals (no metadata line) carry no interaction/task/turn.ended
 *    records — turn terminal states fold to `completed` (the grouping
 *    default) and no approval/question/task events exist to emit.
 * 3. interactions left pending at shutdown fold to `cancelled` by
 *    `foldWireRecordFacts`; they still replay as `*.requested` artifacts.
 * 4. attachments carry metadata only (url/file source + placeholder), never
 *    bytes; they ride the leading busy event for the Rust `TurnBegin`
 *    synthesis, and mid-turn media stays unanchored.
 * 5. turn-ordinal drift (hidden retry/cancelled-queued turns) is compensated
 *    by the fold's `turn.prompt`/`turn.cancel` clock replay, not here.
 * 6. marker/taskref/interaction/subagent positions are approximate: the
 *    snapshot cannot interleave them with turn items, so they append after
 *    the owning agent's turns (plan updates, interactions, tasks) or as
 *    trailing per-agent blocks (subagents).
 * 7. a torn final journal line is dropped (crash mid-flush); corruption
 *    anywhere else fails the request with `internal_error`.
 * 8. the subagent roster depends on `state.json` (the `agents/` directory
 *    scan is the fallback); provenance (`parentToolCallId`, `subagentType`)
 *    is not persisted and replays as null — the Rust provenance fallback
 *    renders such calls top-level.
 * 9. turn ordinals are per-agent (0-based grouping, engine-aligned).
 * 10. the journal is re-read from disk on every replay call, so an engine
 *    migration rewrite (or any later append) is picked up; a live session's
 *    write-behind is flushed (`IAppendLogStore.flush`, best-effort) first.
 *
 * Pagination: the assembled burst is deterministic for a given journal
 * state. `fromSeq` skips that many leading events of the burst (a cursor —
 * under the documented fresh-process alignment the first burst starts at
 * seq 1, so "events after seq N" == "burst events after position N");
 * `limit` caps the window and sets `truncated` when history remains. The
 * response's `fromSeq`/`toSeq` are the actual emitted frame seqs read back
 * from the server's emit (0/0 when nothing was emitted).
 *
 * Wired by the protocol server in wave 3 (server.ts registers
 * `createReplayHandlers(ctx)` and reports `capabilities.replay: true`). The
 * handler depends on the turn family only through the read-only
 * `hasActiveTurn` probe, so no turn-router behavior changes.
 */

import {
  IAppendLogStore,
  ISessionIndex,
} from '@moonshot-ai/agent-core-v2';

import {
  requireEngineContext,
  type RuntimeHandlerContext,
  type RuntimeHandlerEntry,
} from './handler-context';
import {
  RuntimeRequestError,
  type JsonValue,
  type RuntimeRequestFrame,
} from './protocol';
import { sessionReplayParamsSchema } from './protocol-parity';
import { planSessionReplay } from './replay/map';
import { hasActiveTurn } from './turn-router';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPayload(value: { readonly [key: string]: unknown }): JsonValue {
  return value as JsonValue;
}

export function createReplayHandlers(ctx: RuntimeHandlerContext): RuntimeHandlerEntry[] {
  const sessionReplay = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const parsed = sessionReplayParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      throw new RuntimeRequestError(
        'invalid_params',
        `${request.method} params invalid (${where}${issue?.message ?? 'invalid'}).`,
        false,
      );
    }
    const params = parsed.data;
    const engine = requireEngineContext(ctx);
    // The burst must never interleave with a live turn of the same session
    // (the ordering rule in protocol-parity.ts); the probe is read-only.
    if (hasActiveTurn(engine, params.sessionId)) {
      throw new RuntimeRequestError(
        'session_busy',
        `Session ${params.sessionId} has an active turn; replay is rejected until it settles.`,
        false,
      );
    }
    const summary = await engine.app.accessor
      .get(ISessionIndex)
      .get(params.sessionId)
      .catch((error: unknown) => {
        throw new RuntimeRequestError(
          'internal_error',
          error instanceof Error ? error.message : String(error),
          false,
        );
      });
    if (summary === undefined) {
      throw new RuntimeRequestError(
        'session_not_found',
        `Session "${params.sessionId}" does not exist.`,
        false,
      );
    }
    // Land a live session's write-behind before the disk read (degradation
    // 10); a flush failure must not block the replay.
    await engine.app.accessor
      .get(IAppendLogStore)
      .flush()
      .catch(() => undefined);

    const burst = await planSessionReplay(engine.homeDir, summary.workspaceId, params.sessionId);
    const skip = params.fromSeq ?? 0;
    const window =
      params.limit === undefined ? burst.slice(skip) : burst.slice(skip, skip + params.limit);
    const truncated = skip + window.length < burst.length;

    let firstSeq = 0;
    let lastSeq = 0;
    for (const emission of window) {
      const written: unknown = await ctx.emitSessionEvent(
        params.sessionId,
        emission.event,
        emission.payload,
      );
      // The server resolves emit with the sequenced frame; read the seq back
      // so the result reports the burst's true span.
      const seq = isPlainObject(written) ? written['seq'] : undefined;
      if (typeof seq === 'number') {
        if (firstSeq === 0) firstSeq = seq;
        lastSeq = seq;
      }
    }
    return asPayload({
      sessionId: params.sessionId,
      events: window.length,
      fromSeq: window.length === 0 ? 0 : firstSeq,
      toSeq: window.length === 0 ? 0 : lastSeq,
      truncated,
    });
  };

  return [['session.replay', sessionReplay]];
}
