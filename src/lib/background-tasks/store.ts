import { create } from "zustand";
import { mergeObservedBackgroundTask } from "./normalize";
import type { ObservedBackgroundTask, ObservedCronSchedule } from "./types";

export type BackgroundTasksStore = {
  backgroundTasks: ObservedBackgroundTask[];
  cronSchedules: ObservedCronSchedule[];
  upsertBackgroundTask: (task: ObservedBackgroundTask) => void;
  upsertCronSchedule: (schedule: ObservedCronSchedule) => void;
  replaceCronSchedules: (sessionId: string, toolCallId: string, schedules: ObservedCronSchedule[]) => void;
  clearSession: (sessionId: string) => void;
};

function taskKey(task: Pick<ObservedBackgroundTask, "sessionId" | "taskId">): string {
  return `${task.sessionId}:${task.taskId}`;
}

function cronKey(schedule: Pick<ObservedCronSchedule, "sessionId" | "cronId">): string {
  return `${schedule.sessionId}:${schedule.cronId}`;
}

export const useBackgroundTasksStore = create<BackgroundTasksStore>((set) => ({
  backgroundTasks: [],
  cronSchedules: [],
  upsertBackgroundTask: (task) =>
    set((state) => {
      const key = taskKey(task);
      const index = state.backgroundTasks.findIndex((entry) => taskKey(entry) === key);
      if (index === -1) {
        return { backgroundTasks: [...state.backgroundTasks, task] };
      }
      const backgroundTasks = [...state.backgroundTasks];
      backgroundTasks[index] = mergeObservedBackgroundTask(backgroundTasks[index], task);
      return { backgroundTasks };
    }),
  upsertCronSchedule: (schedule) =>
    set((state) => {
      const key = cronKey(schedule);
      const index = state.cronSchedules.findIndex((entry) => cronKey(entry) === key);
      if (index === -1) {
        return { cronSchedules: [...state.cronSchedules, schedule] };
      }
      const cronSchedules = [...state.cronSchedules];
      cronSchedules[index] = { ...cronSchedules[index], ...schedule };
      return { cronSchedules };
    }),
  replaceCronSchedules: (sessionId, toolCallId, schedules) =>
    set((state) => {
      const retained = state.cronSchedules.filter(
        (entry) => !(entry.sessionId === sessionId && entry.toolCallId === toolCallId),
      );
      return { cronSchedules: [...retained, ...schedules] };
    }),
  clearSession: (sessionId) =>
    set((state) => ({
      backgroundTasks: state.backgroundTasks.filter((task) => task.sessionId !== sessionId),
      cronSchedules: state.cronSchedules.filter((schedule) => schedule.sessionId !== sessionId),
    })),
}));
