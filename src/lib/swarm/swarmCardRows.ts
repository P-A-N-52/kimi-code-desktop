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
  parentAgentId?: string;
  depth: number;
  boundModel?: string;
  modelPreference?: string;
}

export interface SwarmCardRow {
  id: string;
  name: string;
  activity: string;
  phase: SwarmPhase;
  body: string;
  depth: number;
  topLevel: boolean;
}

export interface PlannedSwarmItem {
  name: string;
  index: number;
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
    parentAgentId: task.parentAgentId,
    depth: task.swarmDepth ?? 0,
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
    depth: 0,
    topLevel: true,
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
  plannedItems: PlannedSwarmItem[] = [],
): SwarmCardRow[] {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const compareMembers = (left: SwarmMember, right: SwarmMember) =>
    left.swarmIndex - right.swarmIndex || left.id.localeCompare(right.id);
  const children = new Map<string, SwarmMember[]>();
  const roots: SwarmMember[] = [];
  for (const member of members) {
    if (member.parentAgentId && memberById.has(member.parentAgentId)) {
      const siblings = children.get(member.parentAgentId) ?? [];
      siblings.push(member);
      children.set(member.parentAgentId, siblings);
    } else {
      roots.push(member);
    }
  }
  roots.sort(compareMembers);
  for (const siblings of children.values()) siblings.sort(compareMembers);
  const orderedMembers: SwarmMember[] = [];
  const visit = (member: SwarmMember) => {
    orderedMembers.push(member);
    for (const child of children.get(member.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  const memberRows = new Map(
    orderedMembers.map((member) => [
      member.id,
      {
        id: member.id,
        name: member.name,
        activity: swarmMemberActivity(member),
        phase: member.phase,
        body: swarmMemberBody(member),
        depth: member.depth,
        topLevel: member.depth === 0,
      } satisfies SwarmCardRow,
    ]),
  );
  if (!result) {
    const rootByIndex = new Map(
      roots
        .filter((member) => Number.isFinite(member.swarmIndex))
        .map((member) => [member.swarmIndex, member] as const),
    );
    const branchRows = (root: SwarmMember) => {
      const branch: SwarmCardRow[] = [];
      const collect = (member: SwarmMember) => {
        const row = memberRows.get(member.id);
        if (row) branch.push(row);
        for (const child of children.get(member.id) ?? []) collect(child);
      };
      collect(root);
      return branch;
    };
    const plannedRows = plannedItems.flatMap((item) => {
      const root = rootByIndex.get(item.index);
      return root
        ? branchRows(root)
        : [{
            id: `planned-${item.index}`,
            name: item.name,
            activity: "",
            phase: "queued" as const,
            body: "",
            depth: 0,
            topLevel: true,
          }];
    });
    const plannedIndexes = new Set(plannedItems.map((item) => item.index));
    const unplannedMembers = roots
      .filter((member) => !plannedIndexes.has(member.swarmIndex))
      .flatMap(branchRows);

    return [...plannedRows, ...unplannedMembers];
  }

  const resultOnly = result.subagents
    .filter(
      (sub) =>
        (sub.outcome === "aborted" || sub.state === "not_started") &&
        !members.some((m) => memberCoversResult(m, sub)),
    )
    .map((sub, i) => resultRow(sub, i));

  const orderedRows = orderedMembers.flatMap((member) => {
    const row = memberRows.get(member.id);
    return row ? [row] : [];
  });
  return orderedRows.length > 0
    ? [...orderedRows, ...resultOnly]
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
