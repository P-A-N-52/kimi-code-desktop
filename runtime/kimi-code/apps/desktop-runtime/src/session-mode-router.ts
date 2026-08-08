/**
 * runtime-v1 `session.setMode` — mid-session plan/permission mode control
 * (M4). One method replacing the ACP-era wire commands `set_plan_mode
 * {enabled}` and `set_permission_mode {mode}` (acp.rs `handle_set_plan_mode`
 * / `handle_set_permission_mode`), discriminated on `mode`:
 *
 * - plan arm — `agentPlanService` via the klient facade: `enterPlan()` when
 *   `enabled`, `cancelPlan()` when not (the facade's leave-plan-mode call;
 *   `clearPlan` only empties the plan file). Idle-gated like the ACP-era
 *   `ensure_mode_change_idle`: a live turn answers `session_busy`. Idempotent
 *   like the ACP-era handler: the engine's `enter` throws
 *   `session.plan_mode_invalid` when plan mode is already active, so the
 *   handler reads `getPlan()` first and skips the mutation when the desired
 *   state already holds.
 * - permission arm — `agentRPCService.setPermission` (klient facade
 *   `setPermission`): applies immediately to subsequent permission checks,
 *   so a mid-turn switch works (existing Desktop behavior, issue #13 — it
 *   must not regress to next-turn application). No busy gate.
 *
 * The result echoes the arm's outcome: the plan arm reports the engine
 * readback (`planMode` from a post-mutation `getPlan()`), the permission arm
 * the applied `permissionMode` (the engine setter is synchronous — a resolved
 * call means applied). The Desktop merges the echo into the same StatusUpdate
 * fields the ACP-era mode response carried. Engine-initiated mode changes do
 * NOT cross runtime-v1 as events today (the event bridge drops planMode-only
 * `agent.status.updated` slices), so this result is the only echo channel —
 * a deliberate M4 contract decision.
 *
 * Error mapping: unknown session → `session_not_found` (klient RPC 40404);
 * a live turn on the plan arm → `session_busy`; a racing engine plan-mode
 * conflict → `plan_mode_invalid`; param validation → `invalid_params`; any
 * other engine failure → `internal_error` with the message preserved.
 */

import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core-v2';
import { KlientValidationError, RPCError } from '@moonshot-ai/klient';

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
import {
  sessionSetModeParamsSchema,
  type SessionSetModeParams,
} from './protocol-schemas';
import { hasActiveTurn } from './turn-router';

export function createSessionModeHandlers(ctx: RuntimeHandlerContext): RuntimeHandlerEntry[] {
  const sessionSetMode = async (request: RuntimeRequestFrame): Promise<JsonValue> => {
    const params = parseParams(request);
    const engine = requireEngineContext(ctx);
    if (params.mode === 'plan' && hasActiveTurn(engine, params.sessionId)) {
      throw new RuntimeRequestError(
        'session_busy',
        `Session ${params.sessionId} has an active turn; wait for completion before changing plan mode.`,
        false,
      );
    }
    const agent = engine.klient.session(params.sessionId).agent(MAIN_AGENT_ID);
    try {
      if (params.mode === 'plan') {
        const active = (await agent.getPlan()) !== null;
        if (params.enabled !== active) {
          if (params.enabled) {
            await agent.enterPlan();
          } else {
            await agent.cancelPlan();
          }
        }
        // Readback, not an echo of the request: the engine state is the truth
        // the Desktop merges into its mode status.
        return {
          sessionId: params.sessionId,
          mode: 'plan',
          planMode: (await agent.getPlan()) !== null,
        };
      }
      await agent.setPermission(params.permissionMode);
      return {
        sessionId: params.sessionId,
        mode: 'permission',
        permissionMode: params.permissionMode,
      };
    } catch (error) {
      throw mapSessionModeError(error);
    }
  };

  return [['session.setMode', sessionSetMode]];
}

function parseParams(request: RuntimeRequestFrame): SessionSetModeParams {
  const parsed = sessionSetModeParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new RuntimeRequestError(
      'invalid_params',
      `${request.method} params invalid (${where}${issue?.message ?? 'invalid'}).`,
      false,
    );
  }
  return parsed.data;
}

/** Klient RPC code the dispatcher raises for a session that is not live. */
const SESSION_NOT_FOUND_RPC_CODE = 40404;

/** Engine typed error codes mapped onto structured runtime-v1 codes. */
const ENGINE_ERROR_CODES: Readonly<Record<string, string>> = {
  'session.plan_mode_invalid': 'plan_mode_invalid',
};

function mapSessionModeError(error: unknown): RuntimeRequestError {
  if (error instanceof RuntimeRequestError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof KlientValidationError && error.phase === 'input') {
    return new RuntimeRequestError('invalid_params', message, false);
  }
  if (error instanceof RPCError && error.code === SESSION_NOT_FOUND_RPC_CODE) {
    return new RuntimeRequestError('session_not_found', message, false);
  }
  const engineCode = readEngineErrorCode(error);
  const mapped = engineCode === undefined ? undefined : ENGINE_ERROR_CODES[engineCode];
  if (mapped !== undefined) {
    return new RuntimeRequestError(mapped, message, false);
  }
  return new RuntimeRequestError(
    'internal_error',
    `Kimi engine request failed: ${message}`,
    false,
  );
}

/** Engine errors cross the in-process transport as-is; read their typed code. */
function readEngineErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
