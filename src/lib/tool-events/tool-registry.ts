export type ToolCategory =
  | "file"
  | "search"
  | "shell"
  | "agent"
  | "task"
  | "todo"
  | "goal"
  | "plan"
  | "skill"
  | "generic";

export type ToolPresentation = {
  canonicalName: string;
  displayName: string;
  category: ToolCategory;
};

const PRESENTATIONS: Record<string, Omit<ToolPresentation, "canonicalName">> = {
  ReadFile: { displayName: "Read", category: "file" },
  ReadMediaFile: { displayName: "Read Media", category: "file" },
  WriteFile: { displayName: "Write", category: "file" },
  StrReplaceFile: { displayName: "Edit", category: "file" },
  Glob: { displayName: "Find Files", category: "search" },
  Grep: { displayName: "Search", category: "search" },
  Shell: { displayName: "Shell", category: "shell" },
  SearchWeb: { displayName: "Web Search", category: "search" },
  FetchURL: { displayName: "Fetch URL", category: "search" },
  Agent: { displayName: "Agent", category: "agent" },
  AgentSwarm: { displayName: "Swarm", category: "agent" },
  Task: { displayName: "Agent Task", category: "task" },
  TaskList: { displayName: "Task List", category: "task" },
  TaskOutput: { displayName: "Task Output", category: "task" },
  TaskStop: { displayName: "Stop Task", category: "task" },
  CronCreate: { displayName: "Schedule Cron", category: "task" },
  CronList: { displayName: "Cron List", category: "task" },
  CronDelete: { displayName: "Cancel Cron", category: "task" },
  CreateSubagent: { displayName: "Create Agent", category: "agent" },
  Think: { displayName: "Think", category: "generic" },
  SetTodoList: { displayName: "Todo List", category: "todo" },
  CreateGoal: { displayName: "Create Goal", category: "goal" },
  GetGoal: { displayName: "Get Goal", category: "goal" },
  UpdateGoal: { displayName: "Update Goal", category: "goal" },
  SetGoalBudget: { displayName: "Set Goal Budget", category: "goal" },
  EnterPlanMode: { displayName: "Enter Plan Mode", category: "plan" },
  ExitPlanMode: { displayName: "Exit Plan Mode", category: "plan" },
  Skill: { displayName: "Skill", category: "skill" },
  SendDMail: { displayName: "Send Mail", category: "generic" },
};

const ALIASES: Record<string, string> = {
  read: "ReadFile",
  readfile: "ReadFile",
  readmediafile: "ReadMediaFile",
  write: "WriteFile",
  writefile: "WriteFile",
  edit: "StrReplaceFile",
  strreplacefile: "StrReplaceFile",
  bash: "Shell",
  shell: "Shell",
  websearch: "SearchWeb",
  searchweb: "SearchWeb",
  todolist: "SetTodoList",
  settodolist: "SetTodoList",
  agent: "Agent",
  agentswarm: "AgentSwarm",
  swarm: "AgentSwarm",
  tasklist: "TaskList",
  taskoutput: "TaskOutput",
  taskstop: "TaskStop",
  croncreate: "CronCreate",
  cronlist: "CronList",
  crondelete: "CronDelete",
};

const BACKGROUND_TASK_OBSERVATION_TOOLS = new Set([
  "TaskList",
  "TaskOutput",
  "TaskStop",
]);

const CRON_OBSERVATION_TOOLS = new Set(["CronCreate", "CronList", "CronDelete"]);

/** Direct control tools — observed only; Desktop must not expose control buttons (G3). */
const TASK_CONTROL_TOOLS = new Set(["TaskStop", "CronCreate", "CronDelete", "CronList"]);

export function getToolPresentation(rawName: string): ToolPresentation {
  const canonicalName = ALIASES[rawName.toLowerCase()] ?? rawName;
  const presentation = PRESENTATIONS[canonicalName];
  return {
    canonicalName,
    displayName: presentation?.displayName ?? rawName,
    category: presentation?.category ?? "generic",
  };
}

export function isWriteTool(rawName: string): boolean {
  return getToolPresentation(rawName).canonicalName === "WriteFile";
}

export function isTodoTool(rawName: string): boolean {
  return getToolPresentation(rawName).canonicalName === "SetTodoList";
}

export function isBackgroundTaskObservationTool(rawName: string): boolean {
  return BACKGROUND_TASK_OBSERVATION_TOOLS.has(getToolPresentation(rawName).canonicalName);
}

export function isCronObservationTool(rawName: string): boolean {
  return CRON_OBSERVATION_TOOLS.has(getToolPresentation(rawName).canonicalName);
}

export function isTaskControlTool(rawName: string): boolean {
  return TASK_CONTROL_TOOLS.has(getToolPresentation(rawName).canonicalName);
}

export function isBackgroundOrCronObservationTool(rawName: string): boolean {
  const canonical = getToolPresentation(rawName).canonicalName;
  return (
    BACKGROUND_TASK_OBSERVATION_TOOLS.has(canonical) || CRON_OBSERVATION_TOOLS.has(canonical)
  );
}
