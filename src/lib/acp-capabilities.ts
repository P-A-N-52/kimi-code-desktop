/**
 * G0: Agent runtime capabilities from ACP `initialize`.
 * Must not embed session config options or auth secrets.
 */

export type AuthMethodSummary = {
  id: string;
  name?: string | null;
  description?: string | null;
};

export type AgentRuntimeCapabilities = {
  protocolVersion?: number | null;
  agentName?: string | null;
  agentVersion?: string | null;
  loadSession: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
  sessionList: boolean;
  sessionResume: boolean;
  sessionConfigOptions: boolean;
  /** True when the last live CLI probe failed but cached capabilities remain. */
  capabilitiesStale?: boolean;
  authMethods: AuthMethodSummary[];
};

export function normalizeAgentRuntimeCapabilities(
  raw: Record<string, unknown> | null | undefined,
): AgentRuntimeCapabilities {
  if (!raw) {
    return emptyAgentRuntimeCapabilities();
  }
  return {
    protocolVersion: asOptionalNumber(raw.protocolVersion),
    agentName: asOptionalString(raw.agentName),
    agentVersion: asOptionalString(raw.agentVersion),
    loadSession: raw.loadSession === true,
    promptImage: raw.promptImage === true,
    promptAudio: raw.promptAudio === true,
    promptEmbeddedContext: raw.promptEmbeddedContext === true,
    mcpHttp: raw.mcpHttp === true,
    mcpSse: raw.mcpSse === true,
    sessionList: raw.sessionList === true,
    sessionResume: raw.sessionResume === true,
    sessionConfigOptions: raw.sessionConfigOptions === true,
    capabilitiesStale: raw.capabilitiesStale === true,
    authMethods: normalizeAuthMethods(raw.authMethods),
  };
}

export function emptyAgentRuntimeCapabilities(): AgentRuntimeCapabilities {
  return {
    loadSession: false,
    promptImage: false,
    promptAudio: false,
    promptEmbeddedContext: false,
    mcpHttp: false,
    mcpSse: false,
    sessionList: false,
    sessionResume: false,
    sessionConfigOptions: false,
    authMethods: [],
  };
}

/** Version is diagnostic only — gate controls by capability flags. */
export function versionHint(caps: AgentRuntimeCapabilities): string | null {
  return caps.agentVersion ?? null;
}

export function supportsSessionConfigOptions(caps: AgentRuntimeCapabilities): boolean {
  return caps.sessionConfigOptions;
}

function normalizeAuthMethods(value: unknown): AuthMethodSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): AuthMethodSummary | null => {
      if (typeof item === "string") {
        return { id: item };
      }
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const id = asOptionalString(record.id);
        if (!id) return null;
        return {
          id,
          name: asOptionalString(record.name),
          description: asOptionalString(record.description),
        };
      }
      return null;
    })
    .filter((item): item is AuthMethodSummary => item !== null);
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
