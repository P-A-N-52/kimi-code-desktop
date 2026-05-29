import { create } from "zustand";

export type AgentTaskStatus = "running" | "success" | "error";

export interface AgentTask {
  id: string;
  agentType: string;
  status: AgentTaskStatus;
  currentStep: string;
  startTime: number;
  endTime?: number;
  progress?: number;
}

type AgentMonitorStore = {
  tasks: AgentTask[];
  cancelTask: (id: string) => void;
  cancelAll: () => void;
};

function generateMockTasks(): AgentTask[] {
  const now = Date.now();
  return [
    {
      id: "agent-1",
      agentType: "coder",
      status: "running",
      currentStep: "Analyzing file structure...",
      startTime: now - 120000,
      progress: 45,
    },
    {
      id: "agent-2",
      agentType: "explore",
      status: "running",
      currentStep: "Searching codebase for references...",
      startTime: now - 300000,
      progress: 72,
    },
    {
      id: "agent-3",
      agentType: "plan",
      status: "success",
      currentStep: "Plan generated successfully",
      startTime: now - 600000,
      endTime: now - 580000,
      progress: 100,
    },
    {
      id: "agent-4",
      agentType: "coder",
      status: "error",
      currentStep: "Failed to apply diff patch",
      startTime: now - 180000,
      endTime: now - 150000,
      progress: 30,
    },
  ];
}

export const useAgentMonitorStore = create<AgentMonitorStore>((set) => ({
  tasks: generateMockTasks(),
  cancelTask: (id) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, status: "error" as AgentTaskStatus, endTime: Date.now() } : t,
      ),
    })),
  cancelAll: () =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.status === "running"
          ? { ...t, status: "error" as AgentTaskStatus, endTime: Date.now() }
          : t,
      ),
    })),
}));
