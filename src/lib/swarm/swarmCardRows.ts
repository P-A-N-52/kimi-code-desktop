import type { AgentTask, AgentTaskStatus } from "@/lib/agent-monitor/store";
import type { SwarmResult, SwarmResultSubagent } from "./parseSwarmResult";

export type SwarmPhase = "queued" | "working" | "suspended" | "completed" | "failed";

export interface SwarmMember {
  id: string;
  name: string;
  phase: SwarmPhase;
  summary?: string;
  outputLines?: string[];
  text?: string;
  suspendedReason?: string;
  swarmIndex: number;
  boundModel?: string;
  modelPreference?: string;
}

export interface SwarmCardRow {
  id: string;
  name: string;
  activity: string;
  phase: SwarmPhase;
  body: string;
}

export function phaseForAgentTask(task: AgentTask): SwarmPhase {
  // Terminal statuses win over a stale subagentPhase so cancelled/failed tasks
  // do not keep the swarm card "live" forever.
  if (task.status === "success") return "completed";
  if (task.status === "error" || task.status === "cancelled") return "failed";
  if (task.subagentPhase === "queued") return "queued";
  if (task.subagentPhase === "suspended") return "suspended";
  if (task.subagentPhase === "working" || task.subagentPhase === "running") return "working";
  if (task.status === "queued") return "queued";
  if (task.status === "suspended") return "suspended";
  return "working";
}

export function agentTaskToSwarmMember(task: AgentTask): SwarmMember {
  return {
    id: task.id,
    name: task.description || task.agentType || task.kind || task.id,
    phase: phaseForAgentTask(task),
    summary: task.outputPreview ?? task.currentStep,
    outputLines: task.outputLines,
    text: task.text,
    suspendedReason: task.suspendedReason,
    swarmIndex: task.swarmIndex ?? Number.MAX_SAFE_INTEGER,
    boundModel: task.boundModel,
    modelPreference: task.modelPreference,
  };
}

export function resolveSwarmMembers(
  tasks: AgentTask[],
  parentToolCallId: string | undefined,
): SwarmMember[] {
  if (!parentToolCallId) return [];
  return tasks
    .filter((task) => task.parentToolCallId === parentToolCallId)
    .map(agentTaskToSwarmMember)
    .sort((a, b) => a.swarmIndex - b.swarmIndex || a.id.localeCompare(b.id));
}

function lastNonEmptyLine(text: string | undefined): string {
  if (!text) return "";
  return (
    text
      .split("\n")
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

export function swarmMemberActivity(member: SwarmMember): string {
  return (
    member.suspendedReason ||
    lastNonEmptyLine(member.text) ||
    lastNonEmptyLine(member.outputLines?.join("\n")) ||
    member.summary ||
    ""
  );
}

function swarmMemberBody(member: SwarmMember): string {
  if (member.suspendedReason) return member.suspendedReason;
  if (member.text) return member.text;
  if (member.outputLines && member.outputLines.length > 0) return member.outputLines.join("\n");
  return member.summary ?? "";
}

function outcomeToPhase(outcome: string): SwarmPhase {
  if (outcome === "completed") return "completed";
  if (outcome === "failed" || outcome === "aborted") return "failed";
  return "working";
}

function resultRow(sub: SwarmResultSubagent, index: number): SwarmCardRow {
  return {
    id: sub.agentId ?? sub.item ?? `result-${index}`,
    name: sub.item ?? `subagent ${index + 1}`,
    activity: sub.body.split("\n")[0] ?? "",
    phase: outcomeToPhase(sub.outcome),
    body: sub.body,
  };
}

function memberCoversResult(member: SwarmMember, sub: SwarmResultSubagent): boolean {
  if (sub.agentId && member.id === sub.agentId) return true;
  if (sub.item && member.name.includes(sub.item)) return true;
  return false;
}

/**
 * Merge live members with the agent_swarm_result payload into one row list.
 * Members are authoritative while present; aborted/not_started result rows that
 * no member covers are appended so interrupted swarms stay visible.
 */
export function buildSwarmCardRows(
  members: SwarmMember[],
  result: SwarmResult | null,
): SwarmCardRow[] {
  const memberRows = members.map((m) => ({
    id: m.id,
    name: m.name,
    activity: swarmMemberActivity(m),
    phase: m.phase,
    body: swarmMemberBody(m),
  }));
  if (!result) return memberRows;

  const resultOnly = result.subagents
    .filter(
      (sub) =>
        (sub.outcome === "aborted" || sub.state === "not_started") &&
        !members.some((m) => memberCoversResult(m, sub)),
    )
    .map((sub, i) => resultRow(sub, i));

  return memberRows.length > 0
    ? [...memberRows, ...resultOnly]
    : result.subagents.map((s, i) => resultRow(s, i));
}

export function statusToDotKind(
  status: AgentTaskStatus | SwarmPhase | "running" | "ok" | "error" | string | undefined,
): "ok" | "error" | "running" | "suspended" | "idle" {
  switch (status) {
    case "ok":
    case "done":
    case "completed":
    case "success":
      return "ok";
    case "error":
    case "failed":
    case "cancelled":
    case "danger":
      return "error";
    case "running":
    case "working":
    case "in_progress":
    case "active":
      return "running";
    case "suspended":
      return "suspended";
    case "queued":
      return "idle";
    default:
      return "idle";
  }
}
