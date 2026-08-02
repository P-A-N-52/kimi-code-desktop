export type AgentModelPreference = "primary" | "secondary";

export type AgentModelDisplayInput = {
  boundModel?: string | null;
  modelPreference?: AgentModelPreference | string | null;
};

export type AgentModelDisplay = {
  preference?: AgentModelPreference;
  modelLabel: string;
};

function normalizePreference(
  value: AgentModelPreference | string | null | undefined,
): AgentModelPreference | undefined {
  if (value === "primary" || value === "secondary") return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "primary" || normalized === "secondary") {
    return normalized;
  }
  return undefined;
}

/** Show model info only when runtime events expose primary/secondary binding. */
export function resolveAgentModelDisplay(
  input: AgentModelDisplayInput,
): AgentModelDisplay | null {
  const preference = normalizePreference(input.modelPreference);
  const boundModel = String(input.boundModel ?? "").trim();
  if (!preference && !boundModel) {
    return null;
  }
  return {
    preference,
    modelLabel: boundModel || "unknown",
  };
}

export function formatAgentModelDisplay(display: AgentModelDisplay): string {
  if (display.preference) {
    return `${display.preference} · ${display.modelLabel}`;
  }
  return display.modelLabel;
}
