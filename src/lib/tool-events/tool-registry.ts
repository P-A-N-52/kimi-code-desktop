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
  Task: { displayName: "Agent Task", category: "task" },
  TaskList: { displayName: "Task List", category: "task" },
  TaskOutput: { displayName: "Task Output", category: "task" },
  TaskStop: { displayName: "Stop Task", category: "task" },
  CreateSubagent: { displayName: "Create Agent", category: "agent" },
  Think: { displayName: "Think", category: "generic" },
  SetTodoList: { displayName: "Todo List", category: "todo" },
  CreateGoal: { displayName: "Create Goal", category: "goal" },
  GetGoal: { displayName: "Get Goal", category: "goal" },
  UpdateGoal: { displayName: "Update Goal", category: "goal" },
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
};

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
