import { create } from "zustand";
import type { GoalItem } from "@/lib/goal";
import { isTodoTool, isWriteTool } from "./tool-registry";

export type TodoItem = {
  title: string;
  status: "pending" | "in_progress" | "done";
};

export type { GoalItem } from "@/lib/goal";

type ToolEventsState = {
  sessions: Record<string, ToolEventsSnapshot>;
  addNewFile: (sessionId: string, path: string) => void;
  clearNewFiles: (sessionId: string) => void;
  setTodoItems: (sessionId: string, items: TodoItem[]) => void;
  clearTodoItems: (sessionId: string) => void;
  setCurrentGoal: (sessionId: string, goal: GoalItem | null) => void;
  clearCurrentGoal: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
};

export type ToolEventsSnapshot = {
  newFiles: string[];
  todoItems: TodoItem[];
  currentGoal: GoalItem | null;
};

export const EMPTY_TOOL_EVENTS: ToolEventsSnapshot = Object.freeze({
  newFiles: [],
  todoItems: [],
  currentGoal: null,
});

function sessionSnapshot(state: ToolEventsState, sessionId: string): ToolEventsSnapshot {
  return state.sessions[sessionId] ?? EMPTY_TOOL_EVENTS;
}

function updateSession(
  state: ToolEventsState,
  sessionId: string,
  update: (current: ToolEventsSnapshot) => ToolEventsSnapshot,
): Pick<ToolEventsState, "sessions"> {
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: update(sessionSnapshot(state, sessionId)),
    },
  };
}

export const useToolEventsStore = create<ToolEventsState>((set) => ({
  sessions: {},
  addNewFile: (sessionId, path) =>
    set((state) =>
      updateSession(state, sessionId, (current) => ({
        ...current,
        newFiles: [...current.newFiles, path],
      })),
    ),
  clearNewFiles: (sessionId) =>
    set((state) =>
      updateSession(state, sessionId, (current) => ({ ...current, newFiles: [] })),
    ),
  setTodoItems: (sessionId, items) =>
    set((state) =>
      updateSession(state, sessionId, (current) => ({ ...current, todoItems: items })),
    ),
  clearTodoItems: (sessionId) =>
    set((state) =>
      updateSession(state, sessionId, (current) => ({ ...current, todoItems: [] })),
    ),
  setCurrentGoal: (sessionId, goal) =>
    set((state) =>
      updateSession(state, sessionId, (current) => ({ ...current, currentGoal: goal })),
    ),
  clearCurrentGoal: (sessionId) =>
    set((state) =>
      updateSession(state, sessionId, (current) => ({ ...current, currentGoal: null })),
    ),
  clearSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.sessions)) return state;
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions };
    }),
}));

export function getToolEventsSnapshot(sessionId: string): ToolEventsSnapshot {
  return useToolEventsStore.getState().sessions[sessionId] ?? EMPTY_TOOL_EVENTS;
}

/**
 * Handle tool result events and update store accordingly.
 * Call this from useSessionStream when a ToolResult event is received.
 *
 * @param isReplay - If true, this is a replay of history, skip notifications
 */
export function handleToolResult(
  sessionId: string,
  toolName: string,
  toolArguments: string,
  isError: boolean,
  isReplay: boolean,
) {
  if (isError) return;

  try {
    const args = JSON.parse(toolArguments) as Record<string, unknown>;
    const { addNewFile, setTodoItems, setCurrentGoal } =
      useToolEventsStore.getState();

    if (isTodoTool(toolName) && Array.isArray(args.todos)) {
      const todoItems = args.todos.flatMap((item): TodoItem[] => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        if (typeof value.title !== "string" || !value.title.trim()) return [];
        const status =
          value.status === "in_progress" || value.status === "done"
            ? value.status
            : value.status === "completed"
              ? "done"
              : "pending";
        return [{ title: value.title, status }];
      });
      setTodoItems(sessionId, todoItems);
    }

    const presentation = toolName.toLowerCase();
    if (
      presentation === "creategoal" &&
      typeof args.objective === "string" &&
      args.objective.trim()
    ) {
      setCurrentGoal(sessionId, {
        objective: args.objective,
        ...(typeof args.completionCriterion === "string"
          ? { completionCriterion: args.completionCriterion }
          : {}),
        status: "active",
        turnsUsed: 0,
        tokensUsed: 0,
        wallClockMs: 0,
        budget: {
          tokenBudgetReached: false,
          turnBudgetReached: false,
          wallClockBudgetReached: false,
          overBudget: false,
        },
      });
    } else if (
      presentation === "updategoal" &&
      typeof args.status === "string"
    ) {
      const currentGoal = getToolEventsSnapshot(sessionId).currentGoal;
      if (currentGoal) {
        const nextStatus =
          args.status === "paused" ||
          args.status === "blocked" ||
          args.status === "complete"
            ? args.status
            : "active";
        setCurrentGoal(sessionId, {
          ...currentGoal,
          status: nextStatus,
          ...(typeof args.reason === "string" && nextStatus !== "active"
            ? { terminalReason: args.reason }
            : nextStatus === "active"
              ? { terminalReason: undefined }
              : {}),
        });
      }
    } else if (presentation === "setgoalbudget") {
      const currentGoal = getToolEventsSnapshot(sessionId).currentGoal;
      if (currentGoal) {
        const tokenBudget =
          typeof args.tokenBudget === "number"
            ? args.tokenBudget
            : args.token_budget;
        const turnBudget =
          typeof args.turnBudget === "number"
            ? args.turnBudget
            : args.turn_budget;
        const wallClockBudgetMs =
          typeof args.wallClockBudgetMs === "number"
            ? args.wallClockBudgetMs
            : args.wall_clock_budget_ms;
        setCurrentGoal(sessionId, {
          ...currentGoal,
          budget: {
            ...currentGoal.budget,
            ...(typeof tokenBudget === "number" ? { tokenBudget } : {}),
            ...(typeof turnBudget === "number" ? { turnBudget } : {}),
            ...(typeof wallClockBudgetMs === "number"
              ? { wallClockBudgetMs }
              : {}),
          },
        });
      }
    }

    // Replayed todos restore the work area, but replay must not create fresh
    // file notifications for historical writes.
    if (isReplay) return;

    if (isWriteTool(toolName)) {
      const filePath = args.path || args.file_path;
      if (typeof filePath === "string" && filePath) {
        addNewFile(sessionId, filePath);
      }
    }

    // Generic output parameters - these always indicate file creation
    if (typeof args.output_file === "string") addNewFile(sessionId, args.output_file);
    if (typeof args.output_path === "string") addNewFile(sessionId, args.output_path);
    if (typeof args.download_dir === "string") addNewFile(sessionId, args.download_dir);
  } catch {
    // Ignore parse errors
  }
}
