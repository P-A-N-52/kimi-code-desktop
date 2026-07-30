export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export type GoalBudget = {
  tokenBudget?: number;
  turnBudget?: number;
  wallClockBudgetMs?: number;
  remainingTokens?: number;
  remainingTurns?: number;
  remainingWallClockMs?: number;
  tokenBudgetReached: boolean;
  turnBudgetReached: boolean;
  wallClockBudgetReached: boolean;
  overBudget: boolean;
};

export type GoalItem = {
  goalId?: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  terminalReason?: string;
  budget: GoalBudget;
};

export type GoalPromptAction = "create" | "replace" | "resume";

export type ParsedGoalCommand =
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "cancel" }
  | { kind: "create"; objective: string; replace: boolean }
  | { kind: "invalid"; message: string };

const GOAL_OBJECTIVE_MAX_LENGTH = 4_000;

export function parseGoalCommand(args: string): ParsedGoalCommand {
  const input = args.trim();
  if (!input || input === "status") {
    return { kind: "status" };
  }

  const tokens = input.split(/\s+/);
  const head = tokens[0] ?? "";
  const rest = tokens.slice(1);

  if ((head === "pause" || head === "resume" || head === "cancel") && rest.length === 0) {
    return { kind: head };
  }
  if (head === "next") {
    if (rest.length === 1 && rest[0] === "manage") {
      return {
        kind: "invalid",
        message: "Queued goals are managed from the prompt queue above the composer.",
      };
    }
    const objectiveTokens = rest[0] === "--" ? rest.slice(1) : rest;
    const objective = objectiveTokens.join(" ").trim();
    if (!objective) {
      return { kind: "invalid", message: "Usage: /goal next <objective>" };
    }
    if (objective.length > GOAL_OBJECTIVE_MAX_LENGTH) {
      return {
        kind: "invalid",
        message: `Goal objectives are limited to ${GOAL_OBJECTIVE_MAX_LENGTH} characters.`,
      };
    }
    return { kind: "create", objective, replace: false };
  }

  let replace = false;
  let objectiveTokens = tokens;
  if (head === "replace") {
    replace = true;
    objectiveTokens = tokens.slice(1);
  }
  if (objectiveTokens[0] === "--") objectiveTokens = objectiveTokens.slice(1);
  const objective = objectiveTokens.join(" ").trim();
  if (!objective) {
    return {
      kind: "invalid",
      message: replace ? "Usage: /goal replace <objective>" : "Usage: /goal <objective>",
    };
  }
  if (objective.length > GOAL_OBJECTIVE_MAX_LENGTH) {
    return {
      kind: "invalid",
      message: `Goal objectives are limited to ${GOAL_OBJECTIVE_MAX_LENGTH} characters.`,
    };
  }
  return { kind: "create", objective, replace };
}

export function goalPromptForCommand(command: ParsedGoalCommand): {
  action: GoalPromptAction;
  text: string;
} | null {
  if (command.kind === "create") {
    return {
      action: command.replace ? "replace" : "create",
      text: command.objective,
    };
  }
  if (command.kind === "resume") {
    return {
      action: "resume",
      text: "Resume the active goal.",
    };
  }

  return null;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatLimit(used: number, limit?: number): string {
  return limit === undefined
    ? used.toLocaleString()
    : `${used.toLocaleString()} / ${limit.toLocaleString()}`;
}

export function formatGoalStatus(goal: GoalItem | null): string {
  if (!goal) {
    return "No current goal. Start one with `/goal <objective>` or enable Goal for the next prompt.";
  }
  const lines = [
    "Current goal:",
    `- Objective: ${goal.objective}`,
    `- Status: ${goal.status}`,
    `- Turns: ${formatLimit(goal.turnsUsed, goal.budget.turnBudget)}`,
    `- Tokens: ${formatLimit(goal.tokensUsed, goal.budget.tokenBudget)}`,
    `- Time: ${formatDuration(goal.wallClockMs)}${
      goal.budget.wallClockBudgetMs === undefined
        ? ""
        : ` / ${formatDuration(goal.budget.wallClockBudgetMs)}`
    }`,
  ];
  if (goal.completionCriterion) {
    lines.splice(2, 0, `- Completion: ${goal.completionCriterion}`);
  }
  if (goal.terminalReason) {
    lines.push(`- Reason: ${goal.terminalReason}`);
  }
  if (goal.budget.overBudget) {
    lines.push("- Budget: reached");
  }
  return lines.join("\n");
}
