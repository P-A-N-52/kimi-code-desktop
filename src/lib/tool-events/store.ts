import { create } from "zustand";
import { isTodoTool, isWriteTool } from "./tool-registry";

export type TodoItem = {
  title: string;
  status: "pending" | "in_progress" | "done";
};

export type GoalItem = {
  objective: string;
  completionCriterion?: string;
  status: "active" | "complete" | "blocked";
};

type ToolEventsState = {
  /** Files written during the current session/turn */
  newFiles: string[];

  /** Add a file path when WriteFile completes successfully */
  addNewFile: (path: string) => void;
  /** Clear all new files (e.g., when opening files panel or starting new turn) */
  clearNewFiles: () => void;

  /** Current todo list from SetTodoList tool */
  todoItems: TodoItem[];
  setTodoItems: (items: TodoItem[]) => void;
  clearTodoItems: () => void;

  /** Current goal managed by CreateGoal/UpdateGoal */
  currentGoal: GoalItem | null;
  setCurrentGoal: (goal: GoalItem | null) => void;
  clearCurrentGoal: () => void;
};

export const useToolEventsStore = create<ToolEventsState>((set) => ({
  newFiles: [],
  addNewFile: (path) =>
    set((state) => ({
      newFiles: [...state.newFiles, path],
    })),
  clearNewFiles: () => set({ newFiles: [] }),

  todoItems: [],
  setTodoItems: (items) => set({ todoItems: items }),
  clearTodoItems: () => set({ todoItems: [] }),

  currentGoal: null,
  setCurrentGoal: (goal) => set({ currentGoal: goal }),
  clearCurrentGoal: () => set({ currentGoal: null }),
}));

/**
 * Handle tool result events and update store accordingly.
 * Call this from useSessionStream when a ToolResult event is received.
 *
 * @param isReplay - If true, this is a replay of history, skip notifications
 */
export function handleToolResult(
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
      setTodoItems(todoItems);
    }

    const presentation = toolName.toLowerCase();
    if (
      presentation === "creategoal" &&
      typeof args.objective === "string" &&
      args.objective.trim()
    ) {
      setCurrentGoal({
        objective: args.objective,
        ...(typeof args.completionCriterion === "string"
          ? { completionCriterion: args.completionCriterion }
          : {}),
        status: "active",
      });
    } else if (
      presentation === "updategoal" &&
      typeof args.status === "string"
    ) {
      const currentGoal = useToolEventsStore.getState().currentGoal;
      if (currentGoal) {
        setCurrentGoal({
          ...currentGoal,
          status:
            args.status === "complete" || args.status === "blocked"
              ? args.status
              : "active",
        });
      }
    }

    // Replayed todos restore the work area, but replay must not create fresh
    // file notifications for historical writes.
    if (isReplay) return;

    if (isWriteTool(toolName)) {
      const filePath = args.path || args.file_path;
      if (typeof filePath === "string" && filePath) {
        addNewFile(filePath);
      }
    }

    // Generic output parameters - these always indicate file creation
    if (typeof args.output_file === "string") addNewFile(args.output_file);
    if (typeof args.output_path === "string") addNewFile(args.output_path);
    if (typeof args.download_dir === "string") addNewFile(args.download_dir);
  } catch {
    // Ignore parse errors
  }
}
