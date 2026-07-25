/**
 * Parse the text payload returned by a single `Agent` (or Task) tool call.
 * CLI/ACP commonly emits:
 *
 *   agent_id: agent-0
 *   actual_subagent_type: explore
 *   status: completed
 *   [summary]
 *   …readable result…
 *
 * Defensive: never throws.
 */

export type AgentResult = {
  agentId?: string;
  subagentType?: string;
  status?: string;
  summary?: string;
  /** True when at least one structured field was recognized. */
  structured: boolean;
  /** Raw text when nothing useful could be parsed (or as fallback). */
  raw: string;
};

const META_KEYS: Record<string, keyof Pick<AgentResult, "agentId" | "subagentType" | "status">> = {
  agent_id: "agentId",
  agentid: "agentId",
  actual_subagent_type: "subagentType",
  actualsubagenttype: "subagentType",
  subagent_type: "subagentType",
  subagenttype: "subagentType",
  status: "status",
};

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function toText(output: string[] | string | undefined | null): string {
  if (output === undefined || output === null) return "";
  return (Array.isArray(output) ? output.join("\n") : output).replace(/\r\n/g, "\n");
}

/** Try JSON object shapes first (rare but possible from ACP bridges). */
function tryParseJson(text: string): AgentResult | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const agentId =
      typeof obj.agent_id === "string"
        ? obj.agent_id
        : typeof obj.agentId === "string"
          ? obj.agentId
          : undefined;
    const subagentType =
      typeof obj.actual_subagent_type === "string"
        ? obj.actual_subagent_type
        : typeof obj.subagent_type === "string"
          ? obj.subagent_type
          : typeof obj.subagentType === "string"
            ? obj.subagentType
            : undefined;
    const status = typeof obj.status === "string" ? obj.status : undefined;
    const summary =
      typeof obj.summary === "string"
        ? obj.summary
        : typeof obj.result === "string"
          ? obj.result
          : typeof obj.body === "string"
            ? obj.body
            : undefined;
    if (!agentId && !subagentType && !status && !summary) return null;
    return {
      agentId,
      subagentType,
      status,
      summary: summary?.trim() || undefined,
      structured: true,
      raw: text,
    };
  } catch {
    return null;
  }
}

export function parseAgentResult(output: string[] | string | undefined | null): AgentResult {
  const raw = toText(output);
  if (!raw.trim()) {
    return { structured: false, raw: "" };
  }

  const fromJson = tryParseJson(raw);
  if (fromJson) return fromJson;

  const lines = raw.split("\n");
  const result: AgentResult = { structured: false, raw };
  let i = 0;
  let sawSummaryMarker = false;

  // Leading `key: value` metadata block
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\[summary\]$/i.test(trimmed)) {
      sawSummaryMarker = true;
      i += 1;
      break;
    }
    const m = trimmed.match(/^([A-Za-z][A-Za-z0-9_\s-]*)\s*:\s*(.*)$/);
    if (!m) break;
    const field = META_KEYS[normalizeKey(m[1]!)];
    if (!field) break;
    const value = m[2]!.trim();
    if (value) {
      result[field] = value;
      result.structured = true;
    }
  }

  // Body after meta / `[summary]` only — never promote plain free text alone.
  const rest = lines.slice(i).join("\n").trim();
  if (rest && (result.structured || sawSummaryMarker)) {
    result.summary = rest;
    result.structured = true;
  }

  return result;
}

export type AgentToolInput = {
  description?: string;
  subagentType?: string;
  prompt?: string;
};

export function parseAgentInput(input: unknown): AgentToolInput {
  if (typeof input !== "object" || input === null) return {};
  const r = input as Record<string, unknown>;
  return {
    description: typeof r.description === "string" ? r.description : undefined,
    subagentType:
      typeof r.subagent_type === "string"
        ? r.subagent_type
        : typeof r.subagentType === "string"
          ? r.subagentType
          : undefined,
    prompt: typeof r.prompt === "string" ? r.prompt : undefined,
  };
}
