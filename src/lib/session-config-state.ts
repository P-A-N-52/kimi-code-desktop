/**
 * G0: Session-scoped config from `session/new`, `session/load`, and `config_option_update`.
 * Isolated from AgentRuntimeCapabilities — never merged with initialize state.
 */

import type { AgentRuntimeCapabilities } from "./runtime-capabilities";

export type SessionConfigStatus = "known" | "unknown";

export type SessionConfigChoice = {
  value: unknown;
  label?: string | null;
};

export type SessionConfigOption = {
  id: string;
  optionType: string;
  label?: string | null;
  currentValue?: unknown;
  options?: SessionConfigChoice[] | null;
};

export type SessionConfigState = {
  sessionId: string;
  status: SessionConfigStatus;
  options: SessionConfigOption[];
};

export type SessionConfigMap = Record<string, SessionConfigState | undefined>;

export function emptySessionConfigState(sessionId: string): SessionConfigState {
  return { sessionId, status: "unknown", options: [] };
}

export function normalizeSessionConfigState(
  raw: Record<string, unknown> | null | undefined,
  fallbackSessionId: string,
): SessionConfigState {
  if (!raw) {
    return emptySessionConfigState(fallbackSessionId);
  }
  const sessionId =
    asOptionalString(raw.sessionId) ??
    asOptionalString(raw.session_id) ??
    fallbackSessionId;
  const statusRaw = raw.status;
  const status: SessionConfigStatus =
    statusRaw === "known" || statusRaw === "Known" ? "known" : "unknown";
  const options = Array.isArray(raw.options)
    ? raw.options.map(normalizeSessionConfigOption)
    : [];
  return {
    sessionId,
    status: options.length > 0 ? "known" : status,
    options,
  };
}

export function normalizeSessionConfigOption(
  raw: unknown,
): SessionConfigOption {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    id: asOptionalString(record.id) ?? "unknown",
    optionType:
      asOptionalString(record.optionType) ??
      asOptionalString(record.type) ??
      "unknown",
    label: asOptionalString(record.label),
    currentValue: record.currentValue ?? record.current_value,
    options: Array.isArray(record.options)
      ? record.options.map((choice) => {
          const row =
            choice && typeof choice === "object"
              ? (choice as Record<string, unknown>)
              : {};
          return {
            value: row.value ?? choice,
            label: asOptionalString(row.label),
          };
        })
      : null,
  };
}

/** Invalidate cached config when switching/closing sessions. */
export function invalidateSessionConfig(
  map: SessionConfigMap,
  sessionId: string,
): SessionConfigMap {
  if (!(sessionId in map)) return map;
  const next = { ...map };
  delete next[sessionId];
  return next;
}

export function applyConfigOptionWirePayload(
  map: SessionConfigMap,
  payload: Record<string, unknown>,
): SessionConfigMap {
  const sessionId =
    asOptionalString(payload.session_id) ??
    asOptionalString(payload.sessionId);
  if (!sessionId) return map;
  const nextState = normalizeSessionConfigState(payload, sessionId);
  return { ...map, [sessionId]: nextState };
}

export function sessionHasConfigOption(
  state: SessionConfigState | undefined,
  configId: string,
): boolean {
  if (!state || state.status === "unknown") return false;
  return state.options.some((option) => option.id === configId);
}

/**
 * Whether the UI may expose a session-scoped control for this config id.
 * Gated only by the session declaring the option — not by CLI version strings.
 * Use `prefersSetConfigOptionRpc` to choose `session/set_config_option` vs legacy fallback.
 */
export function canUseSessionConfigOption(
  _runtime: AgentRuntimeCapabilities | null | undefined,
  state: SessionConfigState | undefined,
  configId: string,
): boolean {
  return sessionHasConfigOption(state, configId);
}

/** Prefer unified ACP `session/set_config_option` when runtime and session both support it. */
export function prefersSetConfigOptionRpc(
  runtime: AgentRuntimeCapabilities | null | undefined,
  state: SessionConfigState | undefined,
  configId: string,
): boolean {
  return Boolean(runtime?.sessionConfigOptions && sessionHasConfigOption(state, configId));
}

export function getSessionConfigOption(
  state: SessionConfigState | undefined,
  configId: string,
): SessionConfigOption | undefined {
  if (!state || state.status === "unknown") return undefined;
  return state.options.find((option) => option.id === configId);
}

export function getSessionConfigOptionValue(
  state: SessionConfigState | undefined,
  configId: string,
): unknown {
  return getSessionConfigOption(state, configId)?.currentValue;
}

export function isValidSessionConfigValue(
  state: SessionConfigState | undefined,
  configId: string,
  value: unknown,
): boolean {
  const option = getSessionConfigOption(state, configId);
  if (!option) return false;
  const choices = option.options;
  if (!choices || choices.length === 0) {
    return value !== undefined && value !== null;
  }
  return choices.some((choice) => valuesEqual(choice.value, value));
}

/** Map ACP unified mode option values to desktop plan + permission snapshot. */
export function runtimeModesFromSessionModeValue(
  modeValue: unknown,
): { planMode: boolean; permissionMode: "manual" | "yolo" | "auto" } | null {
  const mode = typeof modeValue === "string" ? modeValue.trim().toLowerCase() : "";
  switch (mode) {
    case "plan":
      return { planMode: true, permissionMode: "manual" };
    case "auto":
      return { planMode: false, permissionMode: "auto" };
    case "yolo":
      return { planMode: false, permissionMode: "yolo" };
    case "default":
    case "manual":
      return { planMode: false, permissionMode: "manual" };
    default:
      return null;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "string" && typeof right === "string") {
    return left.trim() === right.trim();
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
