#!/usr/bin/env node
/**
 * Pure-Node long-session performance benchmark.
 *
 * This intentionally models the expensive data work behind the React views;
 * it does not require React, a browser, or a DOM implementation.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const BENCH_DIR = join(ROOT_DIR, "tmp", "bench-long-session");
const FIXTURE_ROOT = join(BENCH_DIR, "long-session");
const FIXTURE_REPORT_PATH = join(BENCH_DIR, "fixture-report.json");
const REPORT_PATH = join(BENCH_DIR, "benchmark.json");

const HISTORY_RECORD_COUNT = 50_000;
const MESSAGE_COUNT = 50_000;
const DIFF_MESSAGE_COUNT = 200;
const TERMINAL_LINE_COUNT = 10_000;
const MAX_TERM_LINES = 2_000;
const DIFF_CACHE_LIMIT = 200;
const RUNS = 3;

let checksum = 0;
let diffCacheHits = 0;
let diffCacheMisses = 0;
const diffCache = new Map();

function roundMs(value) {
  return Number(value.toFixed(3));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readFixtureReport() {
  if (!existsSync(FIXTURE_REPORT_PATH)) {
    return {
      available: false,
      reason: "fixture-report.json is not present; benchmark used deterministic fallback data",
    };
  }

  try {
    return JSON.parse(readFileSync(FIXTURE_REPORT_PATH, "utf8"));
  } catch (error) {
    return {
      available: false,
      reason: `fixture-report.json could not be parsed: ${error.message}`,
    };
  }
}

function findWireFile() {
  if (!existsSync(FIXTURE_ROOT)) return null;
  const candidates = [];
  function walk(current) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === "wire.jsonl") {
        candidates.push(fullPath);
      }
    }
  }
  walk(FIXTURE_ROOT);
  return candidates[0] ?? null;
}

function buildTerminalOutput(lineCount) {
  return Array.from({ length: lineCount }, (_, index) => {
    const line = String(index + 1).padStart(5, "0");
    const status = index % 19 === 0 ? "success" : index % 37 === 0 ? "warning" : "running";
    return `${line} | ${status} | fallback terminal output line ${index + 1}`;
  }).join("\n");
}

function loadTerminalOutput() {
  const wirePath = findWireFile();
  if (wirePath) {
    const wireLines = readFileSync(wirePath, "utf8").split(/\r?\n/);
    for (const line of wireLines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const display = record.event?.result?.display;
        if (!Array.isArray(display)) continue;
        const shell = display.find((item) => item?.type === "shell");
        const output = shell?.data?.output;
        if (typeof output === "string" && output.split("\n").length >= TERMINAL_LINE_COUNT) {
          return { output, source: relative(ROOT_DIR, wirePath).split(sep).join("/") };
        }
      } catch {
        // The fixture is expected to be valid JSONL; ignore malformed lines in a
        // user-supplied fixture and continue with deterministic fallback data.
      }
    }
  }

  return {
    output: buildTerminalOutput(TERMINAL_LINE_COUNT),
    source: "deterministic fallback",
  };
}

function createDiffData(index) {
  const oldLines = Array.from(
    { length: 24 },
    (_, line) => `line ${line + 1}: original content for diff ${index + 1}`,
  );
  const newLines = [...oldLines];
  newLines[8] = `line 9: updated content for diff ${index + 1}`;
  newLines.push(`line 25: added content for diff ${index + 1}`);
  return {
    path: `src/fixture/file-${String(index + 1).padStart(3, "0")}.ts`,
    old_text: oldLines.join("\n"),
    new_text: newLines.join("\n"),
  };
}

function createMessages(terminalOutput) {
  const largeDisplay = [
    {
      type: "shell",
      data: {
        command: "npm run long-session-fixture",
        output: terminalOutput,
      },
    },
  ];
  const diffIndexes = new Map();
  const step = Math.floor(MESSAGE_COUNT / DIFF_MESSAGE_COUNT);
  for (let index = 0; index < DIFF_MESSAGE_COUNT; index += 1) {
    diffIndexes.set(index * step, createDiffData(index));
  }

  const messages = [];
  for (let index = 0; index < MESSAGE_COUNT; index += 1) {
    const diff = diffIndexes.get(index);
    if (diff) {
      messages.push({
        id: `message-${index}`,
        kind: "tool",
        text: `Tool result message ${index}`,
        diff,
        display: largeDisplay,
      });
    } else {
      messages.push({
        id: `message-${index}`,
        kind: "text",
        text: `Streamed history message ${index}: retained long-session content.`,
      });
    }
  }

  return { messages, diffMessages: messages.filter((message) => message.diff) };
}

function lineTone(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("✓") || /passed|success/i.test(line)) return "ok";
  if (trimmed.startsWith("✗") || /error|failed/i.test(line)) return "err";
  if (trimmed.startsWith("$") || /running/i.test(line)) return "dim";
  return null;
}

function prepareTermRows(terminalOutput) {
  const lines = terminalOutput.split("\n");
  const visibleLines = lines.slice(0, MAX_TERM_LINES);
  const rows = visibleLines.map((line, index) => ({
    key: `${index}-${line.slice(0, 12)}`,
    tone: lineTone(line),
    text: line,
  }));
  checksum += rows.length + (rows[0]?.key.length ?? 0) + (rows.at(-1)?.text.length ?? 0);
  return {
    lineCount: lines.length,
    visibleLineCount: visibleLines.length,
    preparedRows: rows.length,
    truncated: lines.length > MAX_TERM_LINES,
  };
}

function diffCacheKey(data) {
  return JSON.stringify([data.path, data.old_text, data.new_text]);
}

function computeDiffLines(data) {
  const key = diffCacheKey(data);
  const cached = diffCache.get(key);
  if (cached) {
    diffCacheHits += 1;
    return cached;
  }

  diffCacheMisses += 1;
  const oldLines = data.old_text.split("\n");
  const newLines = data.new_text.split("\n");
  const lines = [];
  let adds = 0;
  let dels = 0;
  const lineCount = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < lineCount; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) {
      lines.push({ kind: "ctx", text: oldLine ?? "" });
    } else {
      if (oldLine !== undefined) {
        dels += 1;
        lines.push({ kind: "del", text: oldLine });
      }
      if (newLine !== undefined) {
        adds += 1;
        lines.push({ kind: "add", text: newLine });
      }
    }
  }

  const result = { lines, adds, dels };
  if (diffCache.size >= DIFF_CACHE_LIMIT) diffCache.clear();
  diffCache.set(key, result);
  return result;
}

function resetDiffCache() {
  diffCache.clear();
  diffCacheHits = 0;
  diffCacheMisses = 0;
}

function scanDiffMessages(messages) {
  const hitsBefore = diffCacheHits;
  const missesBefore = diffCacheMisses;
  let scannedDiffs = 0;
  let lineChecksum = 0;
  for (const message of messages) {
    if (!message.diff) continue;
    const result = computeDiffLines(message.diff);
    scannedDiffs += 1;
    lineChecksum += result.lines.length + result.adds + result.dels;
  }
  checksum += lineChecksum;
  return {
    messagesScanned: MESSAGE_COUNT,
    diffCount: scannedDiffs,
    cacheHits: diffCacheHits - hitsBefore,
    cacheMisses: diffCacheMisses - missesBefore,
    recomputedDiffs: diffCacheMisses - missesBefore,
  };
}

function stringifyLargeDisplayKeys(messages) {
  let serializedChars = 0;
  let keyCount = 0;
  for (const message of messages) {
    if (!message.display) continue;
    const key = JSON.stringify(message.display);
    serializedChars += key.length;
    keyCount += 1;
    checksum += key.length + key.charCodeAt(0);
  }
  return {
    messagesScanned: MESSAGE_COUNT,
    largePayloadKeys: keyCount,
    serializedChars,
    note: "Baseline (pre-optimization): Map keyed by JSON.stringify of the display payload. The product code has moved to a WeakMap identity cache.",
  };
}

const identityDisplayCache = new WeakMap();

function useWeakMapIdentityDisplayKeys(messages) {
  let keyCount = 0;
  let typeChars = 0;
  for (const message of messages) {
    const display = message.display;
    if (!display || typeof display !== "object") continue;
    let cached = identityDisplayCache.get(display);
    if (cached === undefined) {
      cached = display[0]?.type.length ?? 0;
      identityDisplayCache.set(display, cached);
    }
    keyCount += 1;
    typeChars += cached;
  }
  checksum += keyCount + typeChars;
  return {
    messagesScanned: MESSAGE_COUNT,
    identityKeys: keyCount,
    note: "Current product implementation: WeakMap keyed by the display object identity, O(1) and leak-free.",
  };
}

function fullMessageMap(messages) {
  const mapped = messages.map((message) => ({
    id: message.id,
    kind: message.kind,
    preview: message.text.slice(0, 32),
    hasDiff: Boolean(message.diff),
  }));
  checksum += mapped.length + (mapped[0]?.preview.length ?? 0) + (mapped.at(-1)?.id.length ?? 0);
  return {
    messagesScanned: messages.length,
    eventsProcessed: 1,
    rerenderCount: mapped.length,
    mappedRows: mapped.length,
    note: "One event update that rebuilds the complete 50,000-message array; a page-response proxy, not DOM timing.",
  };
}

function runScenario({ name, description, setup = () => {}, measure }) {
  const samples = [];
  let details = {};
  for (let run = 0; run < RUNS; run += 1) {
    setup();
    const started = performance.now();
    details = measure();
    samples.push(performance.now() - started);
  }
  return {
    name,
    unit: "ms",
    runs: RUNS,
    samplesMs: samples.map(roundMs),
    medianMs: roundMs(median(samples)),
    description,
    ...details,
  };
}

function buildConclusion(scenarios) {
  const byName = Object.fromEntries(scenarios.map((scenario) => [scenario.name, scenario]));
  const splitMs = byName["term-output-split-render-prep"].medianMs;
  const stringifyMs = byName["large-json-stringify-key"].medianMs;
  const identityMs = byName["large-display-identity-key"].medianMs;
  const fullScanMs = byName["full-message-map-scan"].medianMs;
  const stringifyOverIdentity = identityMs > 0 ? stringifyMs / identityMs : null;
  const splitOverFullScan = fullScanMs > 0 ? splitMs / fullScanMs : null;
  const splitFinding =
    splitMs >= fullScanMs ? "split/行准备达到或超过全量扫描" : "split/行准备低于全量扫描";
  const stringifyFinding =
    stringifyMs >= fullScanMs
      ? "大 JSON.stringify 达到或超过全量扫描，可能重新成为热点"
      : "大 JSON.stringify 低于全量扫描，但仍需避免在每次 render 重复执行";

  return {
    answer: `在本次纯 Node 模拟中，${splitFinding}；${stringifyFinding}。`,
    metrics: {
      termSplitMedianMs: splitMs,
      fullScanMedianMs: fullScanMs,
      largeJsonStringifyMedianMs: stringifyMs,
      identityKeyMedianMs: identityMs,
      largeJsonVsIdentityRatio:
        stringifyOverIdentity === null ? null : Number(stringifyOverIdentity.toFixed(2)),
      termSplitVsFullScanRatio: Number(splitOverFullScan.toFixed(2)),
    },
    scope:
      "These are CPU/data-preparation measurements only; browser layout, paint, and React scheduling are not included.",
  };
}

const fixtureReport = readFixtureReport();
const terminal = loadTerminalOutput();
const { messages, diffMessages } = createMessages(terminal.output);
const scenarios = [
  runScenario({
    name: "term-output-split-render-prep",
    description:
      "TermView-style output.split, visible slice, tone classification, and row/key preparation.",
    measure: () => prepareTermRows(terminal.output),
  }),
  runScenario({
    name: "diff-cache-miss",
    description:
      "Scans 50,000 messages and recomputes 200 unique diffs with the diff-view cache cold.",
    setup: resetDiffCache,
    measure: () => scanDiffMessages(messages),
  }),
  runScenario({
    name: "diff-cache-hit",
    description: "Scans 50,000 messages after warming the same 200-entry diff-view cache.",
    setup: () => {
      resetDiffCache();
      for (const message of diffMessages) computeDiffLines(message.diff);
    },
    measure: () => scanDiffMessages(messages),
  }),
  runScenario({
    name: "large-json-stringify-key",
    description:
      "Baseline (pre-optimization): scans 50,000 messages and JSON.stringifies each of 200 large shell displays as a cache key.",
    measure: () => stringifyLargeDisplayKeys(messages),
  }),
  runScenario({
    name: "large-display-identity-key",
    description:
      "Current product: WeakMap identity cache for the same 200 large shell displays, O(1) lookup without serialization.",
    measure: () => useWeakMapIdentityDisplayKeys(messages),
  }),
  runScenario({
    name: "full-message-map-scan",
    description:
      "Maps the full 50,000-message array once to model an O(M) runtime update and page response.",
    measure: () => fullMessageMap(messages),
  }),
];

const fullScan = scenarios.find((scenario) => scenario.name === "full-message-map-scan");
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  benchmark: "long-session-node",
  methodology: {
    runtime: process.version,
    platform: process.platform,
    runsPerScenario: RUNS,
    statistic: "median of three runs",
    dom: false,
    react: false,
    cachePolicy: `Map cache with ${DIFF_CACHE_LIMIT}-entry clear-on-limit, matching diff-view.tsx strategy`,
  },
  inputs: {
    historyRecordCount: fixtureReport.wire?.lines ?? HISTORY_RECORD_COUNT,
    messageCount: MESSAGE_COUNT,
    diffMessageCount: DIFF_MESSAGE_COUNT,
    terminalLineCount: terminal.output.split("\n").length,
    visibleTerminalLineLimit: MAX_TERM_LINES,
    terminalSource: terminal.source,
    streamingText: true,
  },
  responseProxy: {
    eventCount: fixtureReport.wire?.lines ?? HISTORY_RECORD_COUNT,
    messageCount: MESSAGE_COUNT,
    rerenderCount: fullScan.rerenderCount,
    scenario: fullScan.name,
    medianMs: fullScan.medianMs,
    interpretation: "One full message-array update; not a browser DOM response measurement.",
  },
  fixture: fixtureReport,
  scenarios,
  conclusion: buildConclusion(scenarios),
  integrity: {
    checksum,
    note: "A checksum keeps prepared benchmark results observable and prevents dead-code elimination assumptions.",
  },
};

mkdirSync(BENCH_DIR, { recursive: true });
writeJson(REPORT_PATH, report);
console.log(`Benchmark report: ${relative(ROOT_DIR, REPORT_PATH).split(sep).join("/")}`);
for (const scenario of scenarios) {
  console.log(
    `${scenario.name}: ${scenario.medianMs} ms (median; ${scenario.samplesMs.join(", ")})`,
  );
}
console.log(report.conclusion.answer);
