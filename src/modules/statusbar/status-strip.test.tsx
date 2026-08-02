import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalItem } from "@/lib/goal";
import { UI_LANGUAGE_STORAGE_KEY, UiLanguageProvider } from "@/lib/i18n";
import { StatusStrip } from "./status-strip";

const { agentTasksMock } = vi.hoisted(() => ({
  agentTasksMock: vi.fn<() => Array<{ id: string; sessionId: string; status: string }>>(() => []),
}));

vi.mock("@/lib/agent-monitor/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-monitor/store")>();
  return {
    ...actual,
    useAgentMonitorStore: (selector: (state: { tasks: unknown[] }) => unknown) =>
      selector({ tasks: agentTasksMock() }),
  };
});

const ACTIVE_GOAL: GoalItem = {
  objective: "Ship visible Goal controls",
  status: "active",
  turnsUsed: 1,
  tokensUsed: 100,
  wallClockMs: 1_000,
  budget: {
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
  },
};

const baseProps = {
  permissionMode: "manual" as const,
  onPermissionModeChange: vi.fn(),
  planMode: false,
  swarmMode: false,
  goalMode: true,
  onPlanModeChange: vi.fn(),
  onSwarmModeChange: vi.fn(),
  onGoalModeChange: vi.fn(),
  modeControlsDisabled: false,
  contextUsage: 0,
  tokenUsage: null,
};

function renderStatusStrip(element: ReactElement) {
  return render(element, { wrapper: UiLanguageProvider });
}

describe("StatusStrip Goal controls", () => {
  beforeEach(() => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, "zh-CN");
  });

  it("keeps the one-shot Goal switch enabled when no currentGoal prop is supplied", () => {
    const onGoalModeChange = vi.fn();
    renderStatusStrip(
      <StatusStrip
        {...baseProps}
        goalMode={false}
        currentGoal={undefined}
        onGoalModeChange={onGoalModeChange}
      />,
    );

    const goalSwitch = screen.getByTitle("将下一条消息作为 Goal") as HTMLButtonElement;
    expect(goalSwitch.disabled).toBe(false);
    fireEvent.click(goalSwitch);
    expect(onGoalModeChange).toHaveBeenCalledWith(true);
  });

  it("uses the Goal pill as a one-shot toggle and disables it while a Goal exists", () => {
    const onGoalModeChange = vi.fn();
    const { rerender } = renderStatusStrip(
      <StatusStrip
        {...baseProps}
        goalMode={false}
        currentGoal={null}
        onGoalModeChange={onGoalModeChange}
      />,
    );

    fireEvent.click(screen.getByTitle("将下一条消息作为 Goal"));
    expect(onGoalModeChange).toHaveBeenCalledWith(true);

    rerender(
      <StatusStrip
        {...baseProps}
        goalMode={false}
        currentGoal={ACTIVE_GOAL}
        onGoalModeChange={onGoalModeChange}
      />,
    );
    expect((screen.getByTitle("将下一条消息作为 Goal") as HTMLButtonElement).disabled).toBe(true);
  });
  it("shows pause and cancel beside an active Goal", () => {
    const onGoalControl = vi.fn().mockResolvedValue(undefined);
    renderStatusStrip(
      <StatusStrip {...baseProps} currentGoal={ACTIVE_GOAL} onGoalControl={onGoalControl} />,
    );

    expect(screen.getByText("运行中")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "暂停 Goal" }));
    expect(onGoalControl).toHaveBeenCalledWith("pause");
    expect(screen.getByRole("button", { name: "取消 Goal" })).toBeTruthy();
  });

  it("does not keep lifecycle controls after a Goal completes", () => {
    const onGoalControl = vi.fn().mockResolvedValue(undefined);
    renderStatusStrip(
      <StatusStrip
        {...baseProps}
        currentGoal={{ ...ACTIVE_GOAL, status: "complete" }}
        onGoalControl={onGoalControl}
      />,
    );

    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Goal 生命周期控制" })).toBeNull();
    expect(screen.queryByRole("button", { name: "清除 Goal" })).toBeNull();
    expect(onGoalControl).not.toHaveBeenCalled();
  });

  it("shows resume for paused and blocked Goals", () => {
    const onGoalControl = vi.fn().mockResolvedValue(undefined);
    renderStatusStrip(
      <StatusStrip
        {...baseProps}
        currentGoal={{ ...ACTIVE_GOAL, status: "paused" }}
        onGoalControl={onGoalControl}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "恢复 Goal" }));
    expect(onGoalControl).toHaveBeenCalledWith("resume");
  });
});

describe("StatusStrip task running indicator", () => {
  beforeEach(() => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, "zh-CN");
    agentTasksMock.mockReturnValue([]);
  });

  it("hides the badge when no agent tasks are active", () => {
    renderStatusStrip(<StatusStrip {...baseProps} />);
    expect(screen.queryByText(/task running/)).toBeNull();
  });

  it("shows [1 task running] for a single active task", () => {
    agentTasksMock.mockReturnValue([{ id: "t1", sessionId: "s1", status: "running" }]);
    renderStatusStrip(<StatusStrip {...baseProps} />);
    expect(screen.getByText(/\[1 task running\]/)).toBeDefined();
  });

  it("shows the plural form and counts only active statuses", () => {
    agentTasksMock.mockReturnValue([
      { id: "t1", sessionId: "s1", status: "running" },
      { id: "t2", sessionId: "s2", status: "queued" },
      { id: "t3", sessionId: "s1", status: "success" },
    ]);
    renderStatusStrip(<StatusStrip {...baseProps} />);
    expect(screen.getByText(/\[2 tasks running\]/)).toBeDefined();
  });
});
