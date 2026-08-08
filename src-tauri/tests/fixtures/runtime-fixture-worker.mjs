#!/usr/bin/env node
/**
 * runtime-fixture-worker.mjs — deterministic runtime-v1 fixture child for the
 * Rust supervisor integration tests (`src-tauri/tests/runtime_supervisor.rs`).
 *
 * Pure node stdlib: no network, no filesystem, no dependencies. Speaks the
 * runtime-v1 stdio JSONL contract (protocol.ts): LF-delimited envelopes on
 * stdout, diagnostics on stderr only.
 *
 * Implemented methods: runtime.hello (params-validated, answers with a
 * fixture runtimeInfo then emits runtime.ready), runtime.getInfo,
 * runtime.shutdown (bounded drain, ok response, exit 0),
 * fixture.emitScript ({sessionId, requestId?} -> a fixed 8-event session
 * script with per-session seq from 1, for wave-2 translate golden tests),
 * fixture.emitScriptV2 ({sessionId, requestId?} -> a fixed 10-event script
 * covering every M3 parity event: step.*, compaction.*, mcp.loading.*,
 * slash_commands.update, background_task.observed, turn.steered — for the
 * event-fidelity golden tests), fixture.slowRespond ({delayMs} -> ok
 * response after the delay), and fixture.neverRespond (never answers —
 * exercises the desktop timeout path).
 *
 * M3 parity methods (session.replay, sessions.fork, auth.*, usage.get) are
 * registered and, since wave 3, advertised with the real runtime's flipped
 * capability gates (replay/auth/usage/fork: true, events: the full 25-name
 * session event set). The fixture implements no business logic, so calls
 * still answer a structured not_implemented error-response.
 *
 * Fault injection via environment (all optional):
 * - KIMI_RUNTIME_FIXTURE_RAW_STDOUT: printed verbatim (+LF) before anything
 *   else — exercises the desktop invalid-json fail-closed path.
 * - KIMI_RUNTIME_FIXTURE_HUGE_BYTES: emit one runtime.warning whose payload
 *   message is N bytes of "x" — exercises the frame_too_large path.
 * - KIMI_RUNTIME_FIXTURE_DUPLICATE_RESPONSES=1: write every response twice —
 *   exercises the duplicate_response_id path.
 * - KIMI_RUNTIME_FIXTURE_COMMIT: override the reported kimiSource.commit.
 * - KIMI_RUNTIME_FIXTURE_SELECTED_PROTOCOL: override selectedProtocol.
 */
import { createInterface } from 'node:readline';

const PINNED_TAG = '@moonshot-ai/kimi-code@0.33.0';
const PINNED_COMMIT = '53c832dfdf9566afd59a8b3d54ebd36d3cb03d72';

const env = process.env;
const COMMIT = env.KIMI_RUNTIME_FIXTURE_COMMIT ?? PINNED_COMMIT;
const SELECTED_PROTOCOL = env.KIMI_RUNTIME_FIXTURE_SELECTED_PROTOCOL ?? 'runtime-v1';
const DUPLICATE_RESPONSES = env.KIMI_RUNTIME_FIXTURE_DUPLICATE_RESPONSES === '1';

const PARITY_METHODS = [
  'session.replay',
  'sessions.fork',
  'auth.startLogin',
  'auth.getFlow',
  'auth.cancelLogin',
  'auth.logout',
  'auth.status',
  'usage.get',
];

// The 25 runtime-v1 session events (SESSION_EVENT_NAMES in protocol.ts):
// the 15 M1 base events plus the 10 M3 fidelity events.
const SESSION_EVENT_NAMES = [
  'session.status',
  'session.config',
  'content.delta',
  'thinking.delta',
  'tool.started',
  'tool.updated',
  'tool.completed',
  'plan.updated',
  'usage.updated',
  'task.updated',
  'subagent.updated',
  'approval.requested',
  'question.requested',
  'turn.completed',
  'turn.failed',
  'step.begin',
  'step.interrupted',
  'step.retry',
  'compaction.begin',
  'compaction.end',
  'mcp.loading.begin',
  'mcp.loading.end',
  'slash_commands.update',
  'background_task.observed',
  'turn.steered',
];

const FIXTURE_METHODS = [
  'runtime.hello',
  'runtime.getInfo',
  'runtime.shutdown',
  'fixture.emitScript',
  'fixture.emitScriptV2',
  'fixture.slowRespond',
  'fixture.neverRespond',
  ...PARITY_METHODS,
];

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function diag(message) {
  process.stderr.write(`[runtime-fixture] ${message}\n`);
}

function fatal(code, message) {
  diag(`${code}: ${message}`);
  process.exit(1);
}

diag('starting');

// Fault injection emitted before any request processing.
if (env.KIMI_RUNTIME_FIXTURE_RAW_STDOUT !== undefined) {
  process.stdout.write(`${env.KIMI_RUNTIME_FIXTURE_RAW_STDOUT}\n`);
}
const hugeBytes = Number(env.KIMI_RUNTIME_FIXTURE_HUGE_BYTES ?? '0');
if (Number.isInteger(hugeBytes) && hugeBytes > 0) {
  writeFrame({
    protocol: 'runtime-v1',
    type: 'event',
    event: 'runtime.warning',
    payload: { code: 'fixture_huge_frame', message: 'x'.repeat(hugeBytes) },
  });
}

let awaitingHello = true;
let shutdownRequested = false;
const seenRequestIds = new Set();
const sessionSequences = new Map();

function respond(frame) {
  writeFrame(frame);
  if (DUPLICATE_RESPONSES) writeFrame(frame);
}

function ok(id, result) {
  respond({ protocol: 'runtime-v1', type: 'response', id, ok: true, result });
}

function fail(id, code, message, retryable = false) {
  respond({ protocol: 'runtime-v1', type: 'response', id, ok: false, error: { code, message, retryable } });
}

function emitSessionEvent(sessionId, event, payload) {
  const seq = (sessionSequences.get(sessionId) ?? 0) + 1;
  sessionSequences.set(sessionId, seq);
  writeFrame({ protocol: 'runtime-v1', type: 'event', sessionId, seq, event, payload });
}

function runtimeInfo() {
  return {
    selectedProtocol: SELECTED_PROTOCOL,
    runtimeVersion: '0.0.0-fixture',
    kimiSource: { tag: PINNED_TAG, commit: COMMIT },
    nodeVersion: process.versions.node,
    capabilities: {
      methods: FIXTURE_METHODS,
      // The M1 family gates stay false (the fixture implements none of those
      // methods); the parity gates mirror the real runtime's post-wave-3
      // snapshot even though parity calls still answer not_implemented.
      sessions: false,
      turns: false,
      config: false,
      replay: true,
      auth: true,
      usage: true,
      fork: true,
      events: SESSION_EVENT_NAMES,
    },
    dataSchemaVersion: 1,
  };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function handleHello(id, params) {
  if (!awaitingHello) {
    fail(id, 'handshake_already_completed', 'runtime.hello has already completed.');
    return;
  }
  const valid =
    isNonEmptyString(params.desktopVersion) &&
    Array.isArray(params.supportedProtocols) &&
    isNonEmptyString(params.dataRoot) &&
    isNonEmptyString(params.platform) &&
    isNonEmptyString(params.arch) &&
    isNonEmptyString(params.locale);
  if (!valid) {
    fail(id, 'invalid_params', 'runtime.hello params invalid.');
    return;
  }
  if (!params.supportedProtocols.includes('runtime-v1')) {
    fail(id, 'protocol_mismatch', 'Desktop does not advertise support for runtime-v1.');
    return;
  }
  awaitingHello = false;
  ok(id, runtimeInfo());
  // The handshake response and runtime.ready are an adjacent pair, response first.
  writeFrame({
    protocol: 'runtime-v1',
    type: 'event',
    event: 'runtime.ready',
    payload: { runtimeVersion: '0.0.0-fixture' },
  });
}

function handleEmitScript(id, params) {
  if (!isNonEmptyString(params.sessionId)) {
    fail(id, 'invalid_params', 'fixture.emitScript requires a non-empty sessionId.');
    return;
  }
  const sessionId = params.sessionId;
  const requestId = isNonEmptyString(params.requestId) ? params.requestId : 'fixture-request-1';
  // Fixed deterministic script; seq increments per session from 1.
  emitSessionEvent(sessionId, 'content.delta', { text: 'fixture content delta', requestId });
  emitSessionEvent(sessionId, 'thinking.delta', { text: 'fixture thinking delta', requestId });
  emitSessionEvent(sessionId, 'tool.started', {
    toolCallId: 'fixture-tool-1',
    name: 'fixture_tool',
    arguments: '{"path":"/tmp/fixture"',
    requestId,
  });
  emitSessionEvent(sessionId, 'tool.updated', {
    toolCallId: 'fixture-tool-1',
    argumentsPart: ',"recursive":true}',
  });
  emitSessionEvent(sessionId, 'tool.completed', {
    toolCallId: 'fixture-tool-1',
    isError: false,
    message: 'fixture tool completed',
    display: [{ type: 'text', text: 'fixture display block' }],
  });
  emitSessionEvent(sessionId, 'approval.requested', {
    approvalId: 'fixture-approval-1',
    action: 'run_command',
    description: 'Fixture approval request',
    toolCallId: 'fixture-tool-1',
    kind: 'command',
  });
  emitSessionEvent(sessionId, 'question.requested', {
    questionId: 'fixture-question-1',
    questions: [
      {
        question: 'Fixture question?',
        header: 'Fixture',
        options: [{ label: 'yes' }, { label: 'no' }],
        multi_select: false,
      },
    ],
  });
  emitSessionEvent(sessionId, 'turn.completed', {
    requestId,
    usage: { input_other: 10, output: 5, input_cache_read: 0, input_cache_creation: 0 },
  });
  ok(id, { emitted: 8 });
}

/**
 * Fixed script covering all ten M3 parity session events
 * (PARITY_SESSION_EVENT_NAMES in protocol.ts), for the event-fidelity
 * translate golden tests. Payloads follow protocol-parity.ts.
 */
function handleEmitScriptV2(id, params) {
  if (!isNonEmptyString(params.sessionId)) {
    fail(id, 'invalid_params', 'fixture.emitScriptV2 requires a non-empty sessionId.');
    return;
  }
  const sessionId = params.sessionId;
  const requestId = isNonEmptyString(params.requestId) ? params.requestId : 'fixture-request-1';
  emitSessionEvent(sessionId, 'step.begin', { n: 1, requestId });
  emitSessionEvent(sessionId, 'step.retry', {
    n: 1,
    next_attempt: 2,
    max_attempts: 3,
    wait_s: 4,
    error_type: 'rate_limit',
    status_code: 429,
    requestId,
  });
  emitSessionEvent(sessionId, 'step.interrupted', { requestId });
  emitSessionEvent(sessionId, 'compaction.begin', {});
  emitSessionEvent(sessionId, 'compaction.end', {});
  emitSessionEvent(sessionId, 'mcp.loading.begin', {});
  emitSessionEvent(sessionId, 'mcp.loading.end', {});
  emitSessionEvent(sessionId, 'slash_commands.update', {
    slash_commands: [
      {
        name: 'fixture',
        description: 'Fixture slash command',
        aliases: ['fx'],
        input_hint: '<arg>',
        source: 'runtime',
      },
    ],
  });
  emitSessionEvent(sessionId, 'background_task.observed', {
    tool_call_id: 'fixture-tool-1',
    tool_name: 'TaskOutput',
    task_id: 'fixture-task-1',
    snapshot: 'fixture task snapshot',
    terminal_state: 'running',
  });
  emitSessionEvent(sessionId, 'turn.steered', { requestId, input: 'fixture steer input' });
  ok(id, { emitted: 10 });
}

function handleSlowRespond(id, params) {
  const delayMs = Number(params.delayMs);
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    fail(id, 'invalid_params', 'fixture.slowRespond requires a non-negative numeric delayMs.');
    return;
  }
  setTimeout(() => ok(id, { delayedMs: delayMs }), delayMs);
}

function handleShutdown(id) {
  // Bounded drain, final response, then exit 0 — mirrors stdio.ts. The exit
  // runs in the write callback so the response is flushed before teardown.
  shutdownRequested = true;
  setTimeout(() => {
    const frame = {
      protocol: 'runtime-v1',
      type: 'response',
      id,
      ok: true,
      result: { shuttingDown: true },
    };
    process.stdout.write(`${JSON.stringify(frame)}\n`, () => process.exit(0));
  }, 25);
}

function handleRequest(frame) {
  const { id, method } = frame;
  const params = frame.params ?? {};
  if (seenRequestIds.has(id)) {
    fatal('duplicate_request_id', `request id reused: ${id}`);
  }
  seenRequestIds.add(id);
  if (awaitingHello && method !== 'runtime.hello') {
    fail(id, 'handshake_required', 'runtime.hello must be the first accepted request.');
    return;
  }
  switch (method) {
    case 'runtime.hello':
      handleHello(id, params);
      return;
    case 'runtime.getInfo':
      ok(id, runtimeInfo());
      return;
    case 'runtime.shutdown':
      handleShutdown(id);
      return;
    case 'fixture.emitScript':
      handleEmitScript(id, params);
      return;
    case 'fixture.emitScriptV2':
      handleEmitScriptV2(id, params);
      return;
    case 'fixture.slowRespond':
      handleSlowRespond(id, params);
      return;
    case 'fixture.neverRespond':
      // Intentionally no response: the desktop side must time out, classify
      // the request as TimedOut (not a protocol fault), and keep the runtime
      // alive for later calls.
      return;
    default:
      if (PARITY_METHODS.includes(method)) {
        // The fixture implements no parity business logic: calls answer
        // not_implemented even though the snapshot gates are on (the
        // fixture pins the advertised surface, not the behavior, and params
        // are not validated here).
        fail(id, 'not_implemented', `${method} is not implemented by the fixture worker.`);
        return;
      }
      fail(id, 'method_not_found', `unknown method: ${method}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    fatal('invalid_json', 'fixture received a non-JSON line');
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    fatal('invalid_envelope', 'fixture received a non-object frame');
  }
  if (frame.protocol !== 'runtime-v1') {
    fatal('protocol_mismatch', 'fixture received a frame for another protocol');
  }
  if (frame.type !== 'request') {
    fatal('invalid_envelope_type', 'fixture received a non-request frame');
  }
  handleRequest(frame);
});
// Stdin EOF ends the runtime with exit 0, mirroring the real stdio loop — but
// a requested shutdown still completes its drain response first.
input.on('close', () => {
  if (!shutdownRequested) process.exit(0);
});
