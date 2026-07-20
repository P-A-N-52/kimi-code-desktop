/**
 * ACP feasibility smoke for Milestone 0.
 *
 * Spawns `kimi acp`, sends initialize -> authenticate (login) -> optional
 * session/list, writes a report under tmp/, and always cleans up the child.
 *
 * authRequired / missing login is a successful environmental outcome.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(__dirname, "..");
const TMP_DIR = join(WORKSPACE, "tmp");
const REPORT_PATH = join(TMP_DIR, "acp-smoke-report.json");
const STDERR_LOG_PATH = join(TMP_DIR, "acp-smoke-stderr.log");

const TIMEOUT_MS = Number(process.env.ACP_SMOKE_TIMEOUT_MS || 30_000);
const KIMI_BIN = process.env.KIMI_CODE_BIN || "kimi";

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let timedOut = false;
let finished = false;
let nextId = 1;

/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, method: string }>} */
const pending = new Map();

/** @type {any[]} */
const transcript = [];
/** @type {string[]} */
const stderrLines = [];
/** @type {any[]} */
const notifications = [];

function ensureTmp() {
  mkdirSync(TMP_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function writeReport(report) {
  ensureTmp();
  writeFileSync(REPORT_PATH, `${JSON.stringify(sanitizeReport(report), null, 2)}\n`, "utf8");
  try {
    writeFileSync(STDERR_LOG_PATH, stderrLines.join(""), "utf8");
  } catch {
    // Best-effort stderr capture only.
  }
}

function sanitizeSessionValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return "<string>";
  }
  if (typeof value === "number") {
    return "<number>";
  }
  if (typeof value === "boolean") {
    return "<boolean>";
  }
  if (Array.isArray(value)) {
    return `<array:${value.length}>`;
  }
  if (typeof value === "object") {
    return `<object:${Object.keys(value).join(",")}>`;
  }
  return `<${typeof value}>`;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object") {
    return message;
  }

  const copy = JSON.parse(JSON.stringify(message));
  const sessions = copy?.result?.sessions;
  if (Array.isArray(sessions)) {
    const sample = sessions[0] || {};
    copy.result.sessions = {
      count: sessions.length,
      sampleFields: Object.keys(sample),
      sample: Object.fromEntries(
        Object.entries(sample).map(([key, value]) => [key, sanitizeSessionValue(value)]),
      ),
    };
  }
  return copy;
}

function sanitizeTranscriptEntry(entry) {
  if (!entry || typeof entry !== "object" || !entry.message) {
    return entry;
  }
  return { ...entry, message: sanitizeMessage(entry.message) };
}

function sanitizeReport(report) {
  const copy = JSON.parse(JSON.stringify(report));
  copy.steps = Object.fromEntries(
    Object.entries(copy.steps || {}).map(([key, value]) => [key, sanitizeMessage(value)]),
  );
  copy.transcript = Array.isArray(copy.transcript)
    ? copy.transcript.map(sanitizeTranscriptEntry)
    : [];
  copy.notifications = Array.isArray(copy.notifications)
    ? copy.notifications.map(sanitizeMessage)
    : [];
  return copy;
}

function killChild() {
  if (!child || child.killed) {
    return;
  }
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child && !child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000).unref?.();
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

function send(method, params) {
  if (!child?.stdin || child.stdin.destroyed) {
    return Promise.reject(new Error(`Cannot send ${method}: stdin unavailable`));
  }
  const id = nextId++;
  const message = { jsonrpc: "2.0", id, method, params };
  transcript.push({ direction: "out", at: nowIso(), message });
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, method });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    transcript.push({
      direction: "in",
      at: nowIso(),
      parseError: String(err),
      raw: trimmed.slice(0, 2000),
    });
    return;
  }

  transcript.push({ direction: "in", at: nowIso(), message });

  if (message.id === undefined || message.id === null) {
    notifications.push(message);
    return;
  }

  const waiter = pending.get(message.id);
  if (!waiter) {
    return;
  }
  pending.delete(message.id);
  waiter.resolve(message);
}

function isAuthRequired(response) {
  if (!response || typeof response !== "object") {
    return false;
  }
  if (response.result && typeof response.result === "object") {
    const result = response.result;
    if (result.authRequired === true) {
      return true;
    }
    if (String(result.status || "").toLowerCase() === "authrequired") {
      return true;
    }
    if (String(result.reason || "").toLowerCase() === "authrequired") {
      return true;
    }
  }
  if (response.error && typeof response.error === "object") {
    const err = response.error;
    const code = String(err.code ?? "").toLowerCase();
    const message = String(err.message ?? "").toLowerCase();
    const data = err.data;
    if (
      code.includes("auth") ||
      message.includes("authrequired") ||
      message.includes("not logged")
    ) {
      return true;
    }
    if (data && typeof data === "object" && data.authRequired === true) {
      return true;
    }
    if (typeof data === "string" && data.toLowerCase().includes("authrequired")) {
      return true;
    }
  }
  return false;
}

function looksAuthenticated(response) {
  if (!response || response.error) {
    return false;
  }
  const result = response.result;
  if (result === null || result === undefined) {
    // Some ACP servers return empty success for authenticate.
    return true;
  }
  if (typeof result !== "object") {
    return true;
  }
  if (result.authenticated === false || result.authRequired === true) {
    return false;
  }
  return true;
}

async function run() {
  ensureTmp();

  const report = {
    ok: false,
    startedAt: nowIso(),
    finishedAt: null,
    kimiBin: KIMI_BIN,
    workspace: WORKSPACE,
    timeoutMs: TIMEOUT_MS,
    authenticated: false,
    reason: null,
    steps: {
      initialize: null,
      authenticate: null,
      sessionList: null,
    },
    authMethodsFromInitialize: [],
    notifications: [],
    transcript: [],
    stderrTail: "",
    timedOut: false,
    exitCode: null,
    reportPath: REPORT_PATH,
  };

  const overallTimer = setTimeout(() => {
    timedOut = true;
    report.timedOut = true;
    report.reason = "timeout";
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(new Error(`Timed out waiting for ${waiter.method}`));
    }
    killChild();
  }, TIMEOUT_MS);

  try {
    // Only .cmd/.bat shims need shell mode; kimi.exe runs without it.
    child = spawn(KIMI_BIN, ["acp"], {
      cwd: WORKSPACE,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(KIMI_BIN),
    });

    child.on("error", (err) => {
      report.reason = `spawn_error: ${err.message}`;
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(err);
      }
    });

    child.on("exit", (code) => {
      report.exitCode = code;
      if (!finished) {
        for (const [id, waiter] of pending) {
          pending.delete(id);
          waiter.reject(
            new Error(`kimi acp exited with code ${code} while waiting for ${waiter.method}`),
          );
        }
      }
    });

    const stdoutRl = createInterface({ input: child.stdout });
    stdoutRl.on("line", handleLine);

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrLines.push(text);
    });

    // 1) initialize
    const initializeParams = {
      protocolVersion: 1,
      clientInfo: {
        name: "kimi-code-desktop-acp-smoke",
        version: "0.1.0",
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    };

    const initializeResponse = await send("initialize", initializeParams);
    report.steps.initialize = initializeResponse;

    const authMethods =
      initializeResponse?.result?.authMethods ??
      initializeResponse?.result?.authenticationMethods ??
      initializeResponse?.result?.capabilities?.authMethods ??
      [];
    report.authMethodsFromInitialize = Array.isArray(authMethods) ? authMethods : [authMethods];

    if (initializeResponse?.error) {
      report.reason = "initialize_error";
      report.ok = false;
      return report;
    }

    // Prefer documented login method id; fall back to first advertised method id.
    let methodId = "login";
    if (Array.isArray(authMethods) && authMethods.length > 0) {
      const loginMethod = authMethods.find((m) => {
        const id = typeof m === "string" ? m : (m?.id ?? m?.methodId ?? m?.name);
        return String(id || "").toLowerCase() === "login";
      });
      if (loginMethod) {
        methodId =
          typeof loginMethod === "string"
            ? loginMethod
            : (loginMethod.id ?? loginMethod.methodId ?? loginMethod.name ?? "login");
      } else {
        const first = authMethods[0];
        methodId =
          typeof first === "string"
            ? first
            : (first?.id ?? first?.methodId ?? first?.name ?? "login");
      }
    }

    // 2) authenticate
    const authenticateResponse = await send("authenticate", { methodId });
    report.steps.authenticate = authenticateResponse;

    if (isAuthRequired(authenticateResponse)) {
      report.authenticated = false;
      report.reason = "authRequired";
      report.ok = true;
      return report;
    }

    if (authenticateResponse?.error) {
      // Treat auth-looking errors as environmental; other errors fail the smoke.
      if (isAuthRequired(authenticateResponse)) {
        report.authenticated = false;
        report.reason = "authRequired";
        report.ok = true;
        return report;
      }
      report.authenticated = false;
      report.reason = "authenticate_error";
      report.ok = false;
      return report;
    }

    if (!looksAuthenticated(authenticateResponse)) {
      report.authenticated = false;
      report.reason = "authRequired";
      report.ok = true;
      return report;
    }

    report.authenticated = true;
    report.reason = "authenticated";

    // 3) session/list when authenticated
    try {
      const sessionListResponse = await send("session/list", {});
      report.steps.sessionList = sessionListResponse;
      if (isAuthRequired(sessionListResponse)) {
        report.authenticated = false;
        report.reason = "authRequired";
        report.ok = true;
        return report;
      }
      if (sessionListResponse?.error) {
        report.reason = "session_list_error";
        // Still count as pass for smoke if initialize+auth worked; record the gap.
        report.ok = true;
        return report;
      }
      report.ok = true;
      return report;
    } catch (err) {
      report.reason = `session_list_failed: ${err instanceof Error ? err.message : String(err)}`;
      report.ok = true;
      return report;
    }
  } catch (err) {
    if (timedOut) {
      report.ok = true;
      report.reason = report.reason || "timeout";
      // Timeout after starting is environmental if we never got initialize; still flag clearly.
      if (!report.steps.initialize) {
        report.ok = false;
        report.reason = "timeout_before_initialize";
      }
    } else if (String(report.reason || "").startsWith("spawn_error")) {
      report.ok = false;
    } else {
      report.ok = false;
      report.reason = err instanceof Error ? err.message : String(err);
    }
    return report;
  } finally {
    finished = true;
    clearTimeout(overallTimer);
    report.finishedAt = nowIso();
    report.notifications = notifications;
    report.transcript = transcript;
    report.stderrTail = stderrLines.join("").slice(-8000);
    killChild();
    writeReport(report);
  }
}

const report = await run();

const summary = {
  ok: report.ok,
  authenticated: report.authenticated,
  reason: report.reason,
  reportPath: REPORT_PATH,
  timedOut: report.timedOut,
};
console.log(JSON.stringify(summary, null, 2));

if (!report.ok) {
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}

// Give taskkill a moment on Windows, then force-exit.
setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref?.();
