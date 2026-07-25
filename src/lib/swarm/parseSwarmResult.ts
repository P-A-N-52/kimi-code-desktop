// Parse the `<agent_swarm_result>` payload returned by the AgentSwarm tool.
// Defensive: never throws. Ported from kimi-web parseSwarmResult.

export interface SwarmResultSubagent {
  outcome: string;
  item?: string;
  agentId?: string;
  mode?: string;
  state?: string;
  body: string;
}

export interface SwarmResult {
  /** Raw summary line, e.g. `completed: 8, failed: 2`. */
  summary: string;
  completed: number;
  failed: number;
  aborted: number;
  total: number;
  subagents: SwarmResultSubagent[];
  resumeHint?: string;
}

const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/;
const RESUME_HINT_RE = /<resume_hint>([\s\S]*?)<\/resume_hint>/;
const TOKEN_RE = /<subagent\b([^>]*)>|<\/subagent>/g;
const SUBAGENT_CLOSE = "</subagent>";
const COUNT_RE = /(completed|failed|aborted):\s*(\d+)/g;
const ATTR_RE = /([a-z_]+)="([^"]*)"/g;

function unescapeAttr(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1]!] = unescapeAttr(m[2]!);
  }
  return attrs;
}

function parseCounts(summary: string): Pick<SwarmResult, "completed" | "failed" | "aborted"> {
  const counts = { completed: 0, failed: 0, aborted: 0 };
  COUNT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COUNT_RE.exec(summary)) !== null) {
    const key = m[1] as "completed" | "failed" | "aborted";
    counts[key] = Number(m[2]);
  }
  return counts;
}

type RowFrame = { attrs: string; bodyStart: number };

function parseSubagent(attrs: string, body: string): SwarmResultSubagent {
  const parsed = parseAttrs(attrs);
  return {
    outcome: parsed.outcome ?? "completed",
    item: parsed.item,
    agentId: parsed.agent_id,
    mode: parsed.mode,
    state: parsed.state,
    body: body.trim(),
  };
}

function parseSubagents(text: string): SwarmResultSubagent[] {
  const subs: SwarmResultSubagent[] = [];
  const stack: (RowFrame | null)[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m[0] === SUBAGENT_CLOSE) {
      if (stack.length === 0) continue;
      const frame = stack.pop()!;
      if (frame && stack.length === 0) {
        subs.push(parseSubagent(frame.attrs, text.slice(frame.bodyStart, m.index)));
      }
    } else if (stack.length === 0) {
      stack.push({ attrs: m[1] ?? "", bodyStart: TOKEN_RE.lastIndex });
    } else {
      stack.push(null);
    }
  }
  return subs;
}

export function parseSwarmResult(output: string[] | string | undefined | null): SwarmResult | null {
  if (output === undefined || output === null) return null;
  const text = Array.isArray(output) ? output.join("\n") : output;
  if (!text.includes("<agent_swarm_result>")) return null;

  const summary = SUMMARY_RE.exec(text)?.[1]?.trim() ?? "";
  const { completed, failed, aborted } = parseCounts(summary);
  const resumeHint = RESUME_HINT_RE.exec(text)?.[1]?.trim();
  const subagents = parseSubagents(text);

  const totalFromSummary = completed + failed + aborted;
  return {
    summary,
    completed,
    failed,
    aborted,
    total: totalFromSummary > 0 ? totalFromSummary : subagents.length,
    subagents,
    resumeHint,
  };
}
