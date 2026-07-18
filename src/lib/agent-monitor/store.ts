import { create } from "zustand";

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "suspended"
  | "success"
  | "error"
  | "cancelled";

export const UNSCOPED_AGENT_SESSION_ID = "__unscoped__";

export interface AgentTask {
  id: string;
  sessionId: string;
  kind: string;
  agentType: string;
  description: string;
  status: AgentTaskStatus;
  currentStep: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  command?: string;
  outputPreview?: string;
  outputBytes?: number;
  outputLines?: string[];
  text?: string;
  subagentPhase?: string;
  parentToolCallId?: string;
  suspendedReason?: string;
  swarmIndex?: number;
  runInBackground?: boolean;
}

export type AgentTaskCounts = Record<AgentTaskStatus, number>;

export interface AgentTaskGroup {
  id: string;
  sessionId: string;
  parentToolCallId?: string;
  tasks: AgentTask[];
  status: AgentTaskStatus;
  counts: AgentTaskCounts;
  settledCount: number;
  progress: number;
}

export const ACTIVE_AGENT_STATUSES = new Set<AgentTaskStatus>(["queued", "running", "suspended"]);

export function isActiveAgentStatus(status: AgentTaskStatus): boolean {
  return ACTIVE_AGENT_STATUSES.has(status);
}

export function isTerminalAgentStatus(status: AgentTaskStatus): boolean {
  return !isActiveAgentStatus(status);
}

function emptyCounts(): AgentTaskCounts {
  return {
    queued: 0,
    running: 0,
    suspended: 0,
    success: 0,
    error: 0,
    cancelled: 0,
  };
}

function getGroupStatus(counts: AgentTaskCounts): AgentTaskStatus {
  if (counts.running > 0) return "running";
  if (counts.suspended > 0) return "suspended";
  if (counts.queued > 0) return "queued";
  if (counts.error > 0) return "error";
  if (counts.cancelled > 0) return "cancelled";
  return "success";
}

function compareTasks(left: AgentTask, right: AgentTask): number {
  if (left.swarmIndex !== undefined || right.swarmIndex !== undefined) {
    return (
      (left.swarmIndex ?? Number.MAX_SAFE_INTEGER) - (right.swarmIndex ?? Number.MAX_SAFE_INTEGER)
    );
  }
  return left.createdAt - right.createdAt;
}

function statusSortRank(status: AgentTaskStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "suspended":
      return 1;
    case "queued":
      return 2;
    default:
      return 3;
  }
}

export function groupAgentTasks(tasks: AgentTask[]): AgentTaskGroup[] {
  const grouped = new Map<string, AgentTask[]>();

  for (const task of tasks) {
    const key = task.parentToolCallId
      ? `${task.sessionId}:swarm:${task.parentToolCallId}`
      : `${task.sessionId}:task:${task.id}`;
    const current = grouped.get(key);
    if (current) {
      current.push(task);
    } else {
      grouped.set(key, [task]);
    }
  }

  return [...grouped.entries()]
    .map(([id, members]) => {
      const sortedTasks = [...members].sort(compareTasks);
      const counts = emptyCounts();
      for (const task of sortedTasks) counts[task.status] += 1;
      const settledCount = sortedTasks.filter((task) => isTerminalAgentStatus(task.status)).length;

      return {
        id,
        sessionId: sortedTasks[0]?.sessionId ?? UNSCOPED_AGENT_SESSION_ID,
        parentToolCallId: sortedTasks[0]?.parentToolCallId,
        tasks: sortedTasks,
        status: getGroupStatus(counts),
        counts,
        settledCount,
        progress:
          sortedTasks.length > 0 ? Math.round((settledCount / sortedTasks.length) * 100) : 0,
      } satisfies AgentTaskGroup;
    })
    .sort((left, right) => {
      const statusDifference = statusSortRank(left.status) - statusSortRank(right.status);
      if (statusDifference !== 0) return statusDifference;
      return (right.tasks[0]?.createdAt ?? 0) - (left.tasks[0]?.createdAt ?? 0);
    });
}

export function getSwarmMembers(
  tasks: AgentTask[],
  parentToolCallId: string | undefined,
): AgentTask[] {
  if (!parentToolCallId) return [];
  return tasks.filter((task) => task.parentToolCallId === parentToolCallId).sort(compareTasks);
}

export type AgentMonitorStore = {
  tasks: AgentTask[];
  selectedTaskId: string | null;
  upsertTask: (task: AgentTask) => void;
  updateTask: (id: string, patch: Partial<AgentTask>, sessionId?: string) => void;
  completeTask: (
    id: string,
    status: Extract<AgentTaskStatus, "success" | "error" | "cancelled">,
    currentStep?: string,
    sessionId?: string,
  ) => void;
  selectTask: (id: string | null) => void;
  clearSession: (sessionId: string) => void;
  cancelTask: (id: string) => void;
  cancelAll: () => void;
};

function matchesTask(task: AgentTask, id: string, sessionId?: string): boolean {
  return task.id === id && (sessionId === undefined || task.sessionId === sessionId);
}

export const useAgentMonitorStore = create<AgentMonitorStore>((set) => ({
  tasks: [],
  selectedTaskId: null,
  upsertTask: (task) =>
    set((state) => {
      const index = state.tasks.findIndex((entry) => matchesTask(entry, task.id, task.sessionId));
      if (index === -1) {
        return { tasks: [...state.tasks, task] };
      }
      const tasks = [...state.tasks];
      tasks[index] = { ...tasks[index], ...task };
      return { tasks };
    }),
  updateTask: (id, patch, sessionId) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        matchesTask(task, id, sessionId) ? { ...task, ...patch } : task,
      ),
    })),
  completeTask: (id, status, currentStep, sessionId) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        matchesTask(task, id, sessionId)
          ? {
              ...task,
              status,
              completedAt: Date.now(),
              ...(currentStep ? { currentStep } : {}),
            }
          : task,
      ),
    })),
  selectTask: (id) => set({ selectedTaskId: id }),
  clearSession: (sessionId) =>
    set((state) => {
      const removedIds = new Set(
        state.tasks
          .filter(
            (task) => task.sessionId === sessionId || task.sessionId === UNSCOPED_AGENT_SESSION_ID,
          )
          .map((task) => task.id),
      );
      return {
        tasks: state.tasks.filter(
          (task) => task.sessionId !== sessionId && task.sessionId !== UNSCOPED_AGENT_SESSION_ID,
        ),
        selectedTaskId:
          state.selectedTaskId && removedIds.has(state.selectedTaskId)
            ? null
            : state.selectedTaskId,
      };
    }),
  cancelTask: (id) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id && isActiveAgentStatus(task.status)
          ? {
              ...task,
              status: "cancelled" as const,
              completedAt: Date.now(),
              currentStep: "Cancelled",
            }
          : task,
      ),
    })),
  cancelAll: () =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        isActiveAgentStatus(task.status)
          ? {
              ...task,
              status: "cancelled" as const,
              completedAt: Date.now(),
              currentStep: "Cancelled",
            }
          : task,
      ),
    })),
}));
