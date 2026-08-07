/**
 * Cold-rebuild journal pipeline for `session.replay` — the kap-server
 * `TranscriptService.readColdSnapshot` path, engine-free:
 *
 *   readWireRecords (torn tail dropped) → wire migration negotiation →
 *   `reduceContextTranscript` (agent-core-v2) → `groupMessagesIntoSnapshot`
 *   → `foldWireRecordFacts` (`@moonshot-ai/transcript`).
 *
 * Journal layout: `<home>/sessions/{workspaceId}/{sessionId}/agents/<agentId>/wire.jsonl`,
 * the subagent roster in `<sessionDir>/state.json` (`SessionMeta.agents`).
 *
 * `@moonshot-ai/transcript` is a declared `workspace:^` dependency of this
 * app (promoted in wave 3); the folds come in through the package specifier.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MAIN_AGENT_ID,
  isNewerWireVersion,
  isWireMetadataRecord,
  migrateV1_4ToV1_5,
  migrateWireRecord,
  reduceContextTranscript,
  resolveWireMigrations,
  type SessionMeta,
  type WireMigration,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';

import {
  foldWireRecordFacts,
  groupMessagesIntoSnapshot,
  type AgentTranscriptSnapshot,
} from '@moonshot-ai/transcript';

import { RuntimeRequestError } from '../protocol';

const SESSIONS_ROOT = 'sessions';
const AGENTS_DIR = 'agents';
const WIRE_FILE = 'wire.jsonl';
const STATE_FILE = 'state.json';

/** Filename-safe agent id (mirrors transcript `isPlainAgentId`). */
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** The on-disk directory of one session under the runtime home. */
export function sessionDirectory(homeDir: string, workspaceId: string, sessionId: string): string {
  return join(homeDir, SESSIONS_ROOT, workspaceId, sessionId);
}

/**
 * Read and migrate one agent's `wire.jsonl`. Returns `undefined` when the
 * journal does not exist. A torn final line (crash mid-flush) is dropped;
 * corruption anywhere else throws `internal_error`, and a `metadata`-typed
 * but malformed first record does the same (the engine's STORAGE_CORRUPTED
 * counterpart).
 */
export async function readAgentWireJournal(
  sessionDir: string,
  agentId: string,
): Promise<WireRecord[] | undefined> {
  const wirePath = join(sessionDir, AGENTS_DIR, agentId, WIRE_FILE);
  let raw: string;
  try {
    raw = await readFile(wirePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const lines = raw.split('\n');
  const records: WireRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as WireRecord);
    } catch (parseError) {
      if (i === lines.length - 1) break; // torn tail
      throw new RuntimeRequestError(
        'internal_error',
        `wire.jsonl: corrupted line ${i + 1} in ${wirePath}: ${String(parseError)}`,
        false,
      );
    }
  }
  return migrateJournalRecords(records, wirePath);
}

/**
 * Version negotiation mirroring `WireService.restore`: a versioned journal
 * older than the runtime migrates up its chain, a newer one reads as-is
 * (best effort), and a pre-metadata (v1) journal migrates with
 * `migrateV1_4ToV1_5` only. The metadata record stays in the stream — both
 * folds ignore unknown record types.
 */
function migrateJournalRecords(records: WireRecord[], wirePath: string): WireRecord[] {
  const first = records[0];
  if (first === undefined) return records;
  let migrations: readonly WireMigration[] = [];
  if (first.type !== 'metadata') {
    migrations = [migrateV1_4ToV1_5];
  } else if (!isWireMetadataRecord(first)) {
    throw new RuntimeRequestError(
      'internal_error',
      `wire.jsonl: malformed metadata record in ${wirePath}.`,
      false,
    );
  } else if (!isNewerWireVersion(first.protocol_version)) {
    migrations = resolveWireMigrations(first.protocol_version);
  }
  return records.map((record) => migrateWireRecord(record, migrations));
}

/** Fold one agent's journal records into its transcript snapshot. */
export function rebuildAgentSnapshot(records: readonly WireRecord[]): AgentTranscriptSnapshot {
  const messages = [...reduceContextTranscript(records).entries];
  const base = groupMessagesIntoSnapshot(messages);
  return foldWireRecordFacts(records, base);
}

/**
 * The session's agent roster: `state.json` registration order (main first),
 * extended with journal directories the metadata does not know. Ids failing
 * the plain-id check never reach the filesystem path join.
 */
export async function listAgentIds(sessionDir: string): Promise<string[]> {
  const ids: string[] = [];
  const push = (id: unknown): void => {
    if (typeof id !== 'string' || !AGENT_ID_PATTERN.test(id)) return;
    if (id === '.' || id === '..' || ids.includes(id)) return;
    ids.push(id);
  };
  try {
    const meta = JSON.parse(await readFile(join(sessionDir, STATE_FILE), 'utf8')) as SessionMeta;
    push(MAIN_AGENT_ID);
    for (const id of Object.keys(meta.agents ?? {})) push(id);
  } catch {
    // Missing/corrupt state.json: the directory scan below still finds journals.
  }
  try {
    for (const entry of await readdir(join(sessionDir, AGENTS_DIR))) push(entry);
  } catch {
    // No agents directory: the roster stays as-is (possibly just `main`).
  }
  if (!ids.includes(MAIN_AGENT_ID)) ids.unshift(MAIN_AGENT_ID);
  return ids;
}
