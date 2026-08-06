#!/usr/bin/env node
/**
 * Generate a replayable long-session fixture without touching user runtime data.
 *
 * The fixture mirrors ~/.kimi-code/sessions/<work-dir-key>/<session-id>/ and can
 * be copied into a test Kimi Code home for desktop replay validation.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const BENCH_DIR = join(ROOT_DIR, "tmp", "bench-long-session");
const FIXTURE_ROOT = join(BENCH_DIR, "long-session");
const SESSION_ID = "long-session-50000";
const WORK_DIR = ROOT_DIR;
const WORK_DIR_KEY = createHash("md5").update(WORK_DIR).digest("hex");
const SESSION_DIR = join(FIXTURE_ROOT, "sessions", WORK_DIR_KEY, SESSION_ID);
const WIRE_DIR = join(SESSION_DIR, "agents", "main");
const WIRE_PATH = join(WIRE_DIR, "wire.jsonl");
const STATE_PATH = join(SESSION_DIR, "state.json");
const KIMI_JSON_PATH = join(FIXTURE_ROOT, "kimi.json");
const FIXTURE_REPORT_PATH = join(BENCH_DIR, "fixture-report.json");

const TARGET_RECORD_COUNT = 50_000;
const TURN_COUNT = 4_999;
const TOOL_INTERVAL = 500;
const TERMINAL_LINE_COUNT = 10_000;
const EXTRA_STREAM_RECORDS = TARGET_RECORD_COUNT - 1 - TURN_COUNT * 10;

if (EXTRA_STREAM_RECORDS < 0) {
  throw new Error("Fixture constants would generate too many records");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildTerminalOutput(lineCount) {
  return Array.from({ length: lineCount }, (_, index) => {
    const line = String(index + 1).padStart(5, "0");
    const status = index % 19 === 0 ? "success" : index % 37 === 0 ? "warning" : "running";
    return `${line} | ${status} | fixture terminal output line ${index + 1}`;
  }).join("\n");
}

function buildShortTerminalOutput() {
  return Array.from({ length: 32 }, (_, index) => {
    const line = String(index + 1).padStart(2, "0");
    return `${line} | tool fixture output`;
  }).join("\n");
}

function collectTree(root, current = root) {
  const entries = [];
  const children = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const child of children) {
    const fullPath = join(current, child.name);
    const relativePath = relative(root, fullPath).split(sep).join("/");
    if (child.isDirectory()) {
      entries.push({ path: `${relativePath}/`, kind: "directory" });
      entries.push(...collectTree(root, fullPath));
    } else {
      entries.push({
        path: relativePath,
        kind: "file",
        bytes: statSync(fullPath).size,
      });
    }
  }

  return entries;
}

function createFixture() {
  mkdirSync(BENCH_DIR, { recursive: true });
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  mkdirSync(WIRE_DIR, { recursive: true });

  const baseTime = Date.now();
  const terminalOutput = buildTerminalOutput(TERMINAL_LINE_COUNT);
  const shortTerminalOutput = buildShortTerminalOutput();
  const wireLines = [];
  const recordCounts = {};
  const loopEventCounts = {};

  function addRecord(record) {
    wireLines.push(JSON.stringify(record));
    const recordType = record.type ?? "unknown";
    recordCounts[recordType] = (recordCounts[recordType] ?? 0) + 1;
    const loopType = record.event?.type;
    if (recordType === "context.append_loop_event" && loopType) {
      loopEventCounts[loopType] = (loopEventCounts[loopType] ?? 0) + 1;
    }
  }

  function addLoopEvent(event, time) {
    addRecord({
      type: "context.append_loop_event",
      event,
      time,
    });
  }

  function streamPart(turnId, sequence, text, time) {
    addLoopEvent(
      {
        type: "content.part",
        turnId,
        sequence,
        part: { type: "text", text },
      },
      time,
    );
  }

  function toolResult(toolIndex, turnId) {
    const toolCallId = `tool-${String(toolIndex + 1).padStart(3, "0")}`;
    const command =
      toolIndex === 0 ? "npm run long-session-fixture" : `printf tool-${toolIndex + 1}`;
    const output = toolIndex === 0 ? terminalOutput : shortTerminalOutput;
    return {
      type: "tool.result",
      turnId,
      toolCallId,
      result: {
        output: [
          {
            type: "text",
            text:
              toolIndex === 0 ? "Terminal output is available in the shell display block." : output,
          },
        ],
        message: `shell command completed for fixture tool ${toolIndex + 1}`,
        display: [
          {
            type: "shell",
            data: {
              command,
              output,
            },
          },
        ],
      },
    };
  }

  addRecord({
    type: "metadata",
    sessionId: SESSION_ID,
    agentId: "main",
    format: "kimi-code-session-wire-v1",
    time: baseTime,
  });

  for (let index = 0; index < TURN_COUNT; index += 1) {
    const turnNumber = index + 1;
    const turnId = `turn-${String(turnNumber).padStart(5, "0")}`;
    const time = baseTime + index * 1000;
    const isToolTurn = index % TOOL_INTERVAL === 0;
    const toolIndex = Math.floor(index / TOOL_INTERVAL);
    const userText = `Long-session history prompt ${turnNumber}: continue the streamed fixture conversation.`;
    const assistantText = `Historical assistant response ${turnNumber} keeps the long-session message list populated.`;
    const toolCallId = `tool-${String(toolIndex + 1).padStart(3, "0")}`;
    const command =
      toolIndex === 0 ? "npm run long-session-fixture" : `printf tool-${toolIndex + 1}`;

    addRecord({
      type: "turn.prompt",
      turnId,
      input: [{ type: "text", text: userText }],
      origin: { kind: "user" },
      time,
    });

    if (index % 1000 === 999) {
      addRecord({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: `Steer note for streamed turn ${turnNumber}.` }],
        origin: { kind: "user" },
        time: time + 1,
      });
    } else {
      addRecord({
        type: "context.append_message",
        message: {
          role: "user",
          content: [{ type: "text", text: userText }],
          origin: { kind: "user" },
        },
        time: time + 1,
      });
    }

    addLoopEvent({ type: "step.begin", turnId, step: 1 }, time + 2);
    streamPart(
      turnId,
      1,
      `Stream chunk ${turnNumber}.1: the response is arriving incrementally.`,
      time + 3,
    );
    streamPart(
      turnId,
      2,
      `Stream chunk ${turnNumber}.2: retained history remains visible.`,
      time + 4,
    );

    addRecord({
      type: "context.append_message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
        ...(isToolTurn
          ? {
              toolCalls: [
                {
                  type: "function",
                  id: toolCallId,
                  function: { name: "shell", arguments: JSON.stringify({ command }) },
                },
              ],
            }
          : {}),
      },
      time: time + 5,
    });

    streamPart(turnId, 3, `${assistantText} (stream chunk ${turnNumber}.3)`, time + 6);
    if (isToolTurn) {
      addLoopEvent(
        {
          type: "tool.call",
          turnId,
          toolCallId,
          name: "shell",
          args: { command },
        },
        time + 7,
      );
      addLoopEvent(toolResult(toolIndex, turnId), time + 8);
    } else {
      streamPart(turnId, 4, `Stream chunk ${turnNumber}.4: a stable text continuation.`, time + 7);
      streamPart(
        turnId,
        5,
        `Stream chunk ${turnNumber}.5: the session stays intentionally long.`,
        time + 8,
      );
    }

    addRecord({
      type: "usage.record",
      model: "kimi-code/k3",
      usage: {
        inputOther: 1400 + turnNumber,
        output: 120 + (turnNumber % 40),
        inputCacheRead: 300 + turnNumber * 2,
        inputCacheCreation: turnNumber % 7,
      },
      usageScope: "turn",
      time: time + 9,
    });
  }

  for (let index = 0; index < EXTRA_STREAM_RECORDS; index += 1) {
    const time = baseTime + TURN_COUNT * 1000 + index;
    streamPart(
      `turn-${String(TURN_COUNT).padStart(5, "0")}`,
      6 + index,
      `Final continuous stream tail chunk ${index + 1} of ${EXTRA_STREAM_RECORDS}.`,
      time,
    );
  }

  if (wireLines.length !== TARGET_RECORD_COUNT) {
    throw new Error(`Expected ${TARGET_RECORD_COUNT} wire records, got ${wireLines.length}`);
  }

  writeFileSync(WIRE_PATH, `${wireLines.join("\n")}\n`, "utf8");
  writeJson(STATE_PATH, {
    version: 1,
    title: "Long session performance fixture",
    custom_title: "Long session performance fixture",
    title_generated: true,
    workDir: WORK_DIR,
    createdAt: new Date(baseTime).toISOString(),
    updatedAt: new Date(baseTime + TURN_COUNT * 1000).toISOString(),
    archived: false,
    custom: {
      kimi_code_desktop: {
        swarm_mode: false,
        goal_mode: false,
      },
    },
  });
  writeJson(KIMI_JSON_PATH, {
    work_dirs: [{ path: WORK_DIR }],
  });

  const wireBytes = statSync(WIRE_PATH).size;
  const fixtureTree = collectTree(FIXTURE_ROOT);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixtureRoot: relative(ROOT_DIR, FIXTURE_ROOT).split(sep).join("/"),
    session: {
      sessionId: SESSION_ID,
      workDir: WORK_DIR,
      workDirKey: WORK_DIR_KEY,
      sessionRelativePath: relative(FIXTURE_ROOT, SESSION_DIR).split(sep).join("/"),
      wireRelativePath: relative(FIXTURE_ROOT, WIRE_PATH).split(sep).join("/"),
      stateRelativePath: relative(FIXTURE_ROOT, STATE_PATH).split(sep).join("/"),
    },
    format: {
      sessionRoot: "sessions/<workDirKey>/<sessionId>/",
      wirePath: "agents/main/wire.jsonl",
      statePath: "state.json",
      replayRecordTypes: [
        "metadata",
        "turn.prompt",
        "turn.steer",
        "context.append_message",
        "context.append_loop_event",
        "usage.record",
      ],
      displayShape: "{ type: 'shell', data: { command, output } }",
    },
    counts: {
      targetWireRecords: TARGET_RECORD_COUNT,
      wireLines: wireLines.length,
      terminalLines: TERMINAL_LINE_COUNT,
      turns: TURN_COUNT,
      tools: loopEventCounts["tool.result"] ?? 0,
      streamChunks: loopEventCounts["content.part"] ?? 0,
      recordTypes: recordCounts,
      loopEventTypes: loopEventCounts,
    },
    wire: {
      lines: wireLines.length,
      bytes: wireBytes,
    },
    tree: fixtureTree,
    totalFixtureBytes: fixtureTree.reduce(
      (total, entry) => total + (entry.kind === "file" ? entry.bytes : 0),
      0,
    ),
  };

  writeJson(FIXTURE_REPORT_PATH, report);
  return report;
}

const report = createFixture();
console.log(`Generated fixture at ${report.fixtureRoot}`);
console.log(`wire.jsonl: ${report.wire.lines} lines, ${report.wire.bytes} bytes`);
console.log(`Fixture report: ${relative(ROOT_DIR, FIXTURE_REPORT_PATH).split(sep).join("/")}`);
console.log(JSON.stringify(report, null, 2));
