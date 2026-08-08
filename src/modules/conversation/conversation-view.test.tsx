import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalStartConfirmationResult, UseSessionStreamReturn } from "@/hooks/useSessionStream";
import { emptySessionConfigState } from "@/lib/session-config-state";
import { useToolEventsStore } from "@/lib/tool-events/store";
import type { SessionModeDraft } from "@/modules/statusbar/permission-mode";
import { ConversationView } from "./conversation-view";

const tauriApi = vi.hoisted(() => {
  type QueueGoal = {
    id: string;
    objective: string;
    createdAt: string;
    updatedAt: string;
  };
  const emptySnapshot = (): { goals: QueueGoal[] } => ({ goals: [] });
  return {
    isTauri: vi.fn(() => false),
    getSessionGoalQueue: vi.fn(async (_sessionId: string) => emptySnapshot()),
    appendSessionGoalQueue: vi.fn(async (_sessionId: string, _objective: string) =>
      emptySnapshot(),
    ),
    moveSessionGoalQueue: vi.fn(
      async (_sessionId: string, _goalId: string, _direction: "up" | "down") => emptySnapshot(),
    ),
    removeSessionGoalQueue: vi.fn(async (_sessionId: string, _goalId: string) => emptySnapshot()),
    getAgentRuntimeCapabilities: vi.fn(async () => ({
      loadSession: false,
      promptImage: false,
      promptAudio: false,
      promptEmbeddedContext: false,
      mcpHttp: false,
      mcpSse: false,
      sessionList: false,
      sessionResume: false,
      sessionConfigOptions: false,
      authMethods: [],
    })),
    updateSessionGoalQueue: vi.fn(async (_sessionId: string, _goalId: string, _objective: string) =>
      emptySnapshot(),
    ),
  };
});

const globalConfigApi = vi.hoisted(() => ({
  config: {
    defaultModel: "kimi",
    models: [] as Array<{
      name: string;
      provider: string;
      model: string;
      maxContextSize: number;
      providerType: "kimi";
    }>,
    defaultThinking: false,
    thinkingEffort: "",
  },
  update: vi.fn(async () => ({
    config: null,
    restartedSessionIds: ["test-session"],
    skippedBusySessionIds: [],
  })),
}));

vi.mock("@/lib/tauri-api", () => tauriApi);

vi.mock("@/hooks/useGlobalConfig", () => ({
  useGlobalConfig: () => ({
    config: globalConfigApi.config,
    update: globalConfigApi.update,
    isUpdating: false,
  }),
}));

vi.mock("@/hooks/useSkillSlashCommands", () => ({
  useSkillSlashCommands: () => [],
}));

vi.mock("@/modules/composer/composer", () => ({
  Composer: ({
    draft,
    onDraftChange,
    onSend,
    sendDisabled,
    selectedModel,
    onModelPickerOpen,
    onSelectModel,
  }: {
    draft: string;
    onDraftChange: (value: string) => void;
    onSend: () => void;
    sendDisabled?: boolean;
    selectedModel: string;
    onModelPickerOpen?: () => Promise<boolean>;
    onSelectModel: (name: string) => void;
  }) => (
    <div>
      <input
        aria-label="Prompt"
        value={draft}
        onChange={(event) => onDraftChange(event.currentTarget.value)}
      />
      <button type="button" disabled={sendDisabled} onClick={() => onSend()}>
        发送
      </button>
      <output data-testid="composer-disabled">{String(Boolean(sendDisabled))}</output>
      <output data-testid="selected-model">{selectedModel}</output>
      <button
        type="button"
        hidden
        data-testid="switch-model"
        onClick={() => {
          void onModelPickerOpen?.().then((open) => {
            if (open) onSelectModel("demo/next");
          });
        }}
      >
        切换模型
      </button>
    </div>
  ),
}));

vi.mock("./message-list", () => ({ MessageList: () => null }));
vi.mock("@/modules/statusbar/status-strip", () => ({ StatusStrip: () => null }));
vi.mock("@/modules/composer/command-result-panel", () => ({
  CommandResultPanel: () => null,
}));
vi.mock("@/modules/sessions/work-dir-picker", () => ({ WorkDirPicker: () => null }));

const CONFIRMATION: GoalStartConfirmationResult = {
  kind: "goal-start-confirmation",
  objective: "Ship native Goal parity",
  replace: false,
  permissionMode: "manual",
  goalSwitchArmed: true,
};

function makeStream(
  sendMessage: UseSessionStreamReturn["sendMessage"],
  overrides: Partial<UseSessionStreamReturn> = {},
): UseSessionStreamReturn {
  return {
    messages: [],
    status: "ready",
    sessionStatus: null,
    isReplayingHistory: false,
    isAwaitingFirstResponse: false,
    canCancel: false,
    contextUsage: 0,
    contextTokens: null,
    maxContextTokens: null,
    tokenUsage: null,
    currentStep: 0,
    goalCompletionEpoch: 0,
    isConnected: true,
    connectionPhase: "connected",
    sendMessage,
    runLocalInfoCommand: vi.fn(),
    respondToApproval: vi.fn(),
    respondToQuestion: vi.fn(),
    controlGoal: vi.fn(),
    cancel: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    connect: vi.fn(),
    setMessages: vi.fn(),
    clearMessages: vi.fn(),
    error: null,
    planMode: false,
    sendSetPlanMode: vi.fn(() => true),
    permissionMode: "manual",
    sendSetPermissionMode: vi.fn(() => true),
    swarmMode: false,
    sendSetSwarmMode: vi.fn(() => true),
    goalMode: true,
    sendSetGoalMode: vi.fn(() => true),
    slashCommands: [],
    sessionConfigState: emptySessionConfigState("test-session"),
    sessionConfigUpdating: false,
    sendSetConfigOption: vi.fn(async () => true),
    ...overrides,
  };
}

describe("ConversationView runtime reconnect", () => {
  it("offers reconnect for a disconnected runtime error and guards repeated clicks", () => {
    const reconnect = vi.fn();
    const stream = makeStream(vi.fn(), {
      status: "error",
      isConnected: false,
      connectionPhase: "disconnected",
      error: new Error("Runtime connection closed"),
      reconnect,
    });
    renderConversation("reconnectable-error", stream);

    const button = screen.getByRole("button", { name: "重新连接" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "正在重连…" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps Composer usable and omits reconnect for an ordinary prompt error", () => {
    const stream = makeStream(vi.fn(), {
      status: "error",
      connectionPhase: "connected",
      error: new Error("Prompt rejected: invalid argument"),
    });
    renderConversation("prompt-error", stream);

    expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();
    expect(screen.getByTestId("composer-disabled").textContent).toBe("false");
  });
});

describe("ConversationView model switching fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalConfigApi.config.defaultModel = "kimi";
    globalConfigApi.config.models = [
      {
        name: "kimi",
        provider: "kimi",
        model: "kimi",
        maxContextSize: 0,
        providerType: "kimi",
      },
      {
        name: "demo/next",
        provider: "demo",
        model: "next",
        maxContextSize: 0,
        providerType: "kimi",
      },
    ];
  });

  it("switches through global config when the runtime has no session config options", async () => {
    const stream = makeStream(vi.fn());
    renderConversation("test-session", stream);

    expect(screen.getByTestId("selected-model").textContent).toBe("kimi");
    fireEvent.click(screen.getByTestId("switch-model"));

    await waitFor(() => {
      expect(globalConfigApi.update).toHaveBeenCalledWith({ defaultModel: "demo/next" });
    });
    expect(stream.connect).not.toHaveBeenCalled();
    expect(stream.sendSetConfigOption).not.toHaveBeenCalled();
  });

  it("keeps session-scoped switching when the runtime declares model config options", async () => {
    tauriApi.isTauri.mockReturnValue(true);
    tauriApi.getAgentRuntimeCapabilities.mockResolvedValueOnce({
      loadSession: true,
      promptImage: true,
      promptAudio: false,
      promptEmbeddedContext: true,
      mcpHttp: true,
      mcpSse: true,
      sessionList: true,
      sessionResume: true,
      sessionConfigOptions: true,
      authMethods: [],
    });
    const sendSetConfigOption = vi.fn(async () => true);
    const stream = makeStream(vi.fn(), {
      sessionConfigState: {
        sessionId: "test-session",
        status: "known",
        options: [
          {
            id: "model",
            optionType: "select",
            currentValue: "kimi",
            options: [
              { value: "kimi", label: "Kimi" },
              { value: "demo/next", label: "Next" },
            ],
          },
        ],
      },
      sendSetConfigOption,
    });
    renderConversation("test-session", stream);
    await waitFor(() => {
      expect(tauriApi.getAgentRuntimeCapabilities).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTestId("switch-model"));

    await waitFor(() => {
      expect(sendSetConfigOption).toHaveBeenCalledWith("model", "demo/next");
    });
    expect(globalConfigApi.update).not.toHaveBeenCalled();
  });
});

function conversation(
  sessionId: string,
  stream: UseSessionStreamReturn,
  extra: {
    pendingFirstMessage?: string | null;
    pendingFirstModes?: SessionModeDraft | null;
    onPendingFirstMessageSent?: () => void;
  } = {},
) {
  return (
    <ConversationView
      sessionId={sessionId}
      stream={stream}
      onOpenWorkspace={vi.fn()}
      onUploadFile={vi.fn()}
      {...extra}
    />
  );
}

function renderConversation(sessionId: string, stream: UseSessionStreamReturn) {
  return render(conversation(sessionId, stream));
}

describe("ConversationView Goal start confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriApi.isTauri.mockReturnValue(false);
    tauriApi.getSessionGoalQueue.mockResolvedValue({ goals: [] });
    tauriApi.appendSessionGoalQueue.mockResolvedValue({ goals: [] });
    useToolEventsStore.getState().clearCurrentGoal();
  });

  it("restores the draft and consumes the one-shot switch when start is declined", async () => {
    const sendMessage = vi
      .fn<UseSessionStreamReturn["sendMessage"]>()
      .mockResolvedValueOnce(CONFIRMATION);
    const stream = makeStream(sendMessage);
    renderConversation("goal-confirm-cancel", stream);

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Ship native Goal parity" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("dialog", { name: "启动 Goal" });
    fireEvent.click(screen.getByRole("button", { name: "不开始" }));

    expect(stream.sendSetGoalMode).toHaveBeenCalledWith(false);
    expect((screen.getByLabelText("Prompt") as HTMLInputElement).value).toBe(
      "Ship native Goal parity",
    );
    expect(screen.queryByRole("dialog", { name: "启动 Goal" })).toBeNull();
  });

  it("keeps confirmation visible and Composer disabled until confirmed send settles", async () => {
    let resolveConfirmedSend: (() => void) | undefined;
    const sendMessage = vi
      .fn<UseSessionStreamReturn["sendMessage"]>()
      .mockResolvedValueOnce(CONFIRMATION)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveConfirmedSend = () => resolve(undefined);
          }),
      );
    const stream = makeStream(sendMessage);
    renderConversation("goal-confirm-pending", stream);

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Ship native Goal parity" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("dialog", { name: "启动 Goal" });
    fireEvent.click(screen.getByRole("button", { name: "切换 Auto 并开始" }));

    expect(stream.sendSetPermissionMode).toHaveBeenCalledWith("auto");
    expect(sendMessage).toHaveBeenLastCalledWith("Ship native Goal parity", [], {
      goalStartConfirmed: true,
    });
    expect(screen.getByRole("dialog", { name: "启动 Goal" })).toBeTruthy();
    expect(screen.getByTestId("composer-disabled").textContent).toBe("true");

    resolveConfirmedSend?.();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "启动 Goal" })).toBeNull();
    });
    expect(screen.getByTestId("composer-disabled").textContent).toBe("false");
  });

  it("pauses a running Goal before sending a confirmed replacement", async () => {
    useToolEventsStore.getState().setCurrentGoal({
      goalId: "active-replace",
      objective: "Old objective",
      status: "active",
      turnsUsed: 2,
      tokensUsed: 40,
      wallClockMs: 1_000,
      budget: {
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    });
    const order: string[] = [];
    const sendMessage = vi
      .fn<UseSessionStreamReturn["sendMessage"]>()
      .mockImplementation(async (_text, _attachments, options) => {
        if (options?.goalStartConfirmed) {
          order.push("send");
          return undefined;
        }
        return {
          ...CONFIRMATION,
          objective: "New objective",
          replace: true,
          goalSwitchArmed: false,
        };
      });
    const controlGoal = vi
      .fn<UseSessionStreamReturn["controlGoal"]>()
      .mockImplementation(async (action) => {
        order.push(action);
        return { kind: "info-panel", command: "goal", content: "Goal paused." };
      });
    const stream = makeStream(sendMessage, { status: "streaming", controlGoal });
    renderConversation("goal-replace-running", stream);

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "/goal replace New objective" },
    });
    fireEvent.click(screen.getByRole("button"));

    await screen.findByRole("dialog");
    expect(sendMessage).toHaveBeenCalledWith("/goal replace New objective", []);
    fireEvent.click(screen.getByRole("button", { name: /Manual/ }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(controlGoal).toHaveBeenCalledWith("pause");
    expect(order).toEqual(["pause", "send"]);
    expect(sendMessage).toHaveBeenLastCalledWith("/goal replace New objective", [], {
      goalStartConfirmed: true,
    });
  });
  it("passes new-session modes atomically with the first prompt", async () => {
    const sendMessage = vi.fn<UseSessionStreamReturn["sendMessage"]>().mockResolvedValueOnce({
      ...CONFIRMATION,
      permissionMode: "yolo",
    });
    const stream = makeStream(sendMessage);
    const onSent = vi.fn();
    const initialModes: SessionModeDraft = {
      permissionMode: "yolo",
      planMode: false,
      swarmMode: false,
      goalMode: true,
    };

    render(
      conversation("new-session-goal", stream, {
        pendingFirstMessage: "Ship native Goal parity",
        pendingFirstModes: initialModes,
        onPendingFirstMessageSent: onSent,
      }),
    );

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith("Ship native Goal parity", [], {
        initialModes,
      });
    });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(stream.sendSetPermissionMode).not.toHaveBeenCalled();
    expect(stream.sendSetPlanMode).not.toHaveBeenCalled();
    expect(stream.sendSetSwarmMode).not.toHaveBeenCalled();
    expect(stream.sendSetGoalMode).not.toHaveBeenCalled();
  });
});

describe("ConversationView upcoming Goal queue", () => {
  const upcomingGoal = {
    id: "upcoming-1",
    objective: "Verify the release",
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tauriApi.isTauri.mockReturnValue(true);
    tauriApi.getSessionGoalQueue.mockResolvedValue({ goals: [] });
    tauriApi.appendSessionGoalQueue.mockResolvedValue({ goals: [upcomingGoal] });
    useToolEventsStore.getState().clearCurrentGoal();
  });

  it("persists /goal next beside an active Goal instead of using the Composer queue", async () => {
    useToolEventsStore.getState().setCurrentGoal({
      goalId: "active-1",
      objective: "Ship the desktop",
      status: "active",
      turnsUsed: 1,
      tokensUsed: 20,
      wallClockMs: 500,
      budget: {
        tokenBudgetReached: false,
        turnBudgetReached: false,
        wallClockBudgetReached: false,
        overBudget: false,
      },
    });
    const sendMessage = vi.fn<UseSessionStreamReturn["sendMessage"]>();
    renderConversation("goal-queue-active", makeStream(sendMessage));

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "/goal next Verify the release" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(tauriApi.appendSessionGoalQueue).toHaveBeenCalledWith(
        "goal-queue-active",
        "Verify the release",
      );
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not promote persisted Goals merely because the app opened", async () => {
    tauriApi.getSessionGoalQueue.mockResolvedValue({ goals: [upcomingGoal] });
    const sendMessage = vi.fn<UseSessionStreamReturn["sendMessage"]>();
    renderConversation("goal-queue-mount", makeStream(sendMessage));

    await waitFor(() => expect(tauriApi.getSessionGoalQueue).toHaveBeenCalled());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not treat a switched-to session's historical completion as live", async () => {
    tauriApi.getSessionGoalQueue
      .mockResolvedValueOnce({ goals: [] })
      .mockResolvedValue({ goals: [upcomingGoal] });
    const sendMessage = vi.fn<UseSessionStreamReturn["sendMessage"]>();
    const view = renderConversation("goal-queue-before-switch", makeStream(sendMessage));

    await waitFor(() => {
      expect(tauriApi.getSessionGoalQueue).toHaveBeenCalledWith("goal-queue-before-switch");
    });

    view.rerender(
      conversation(
        "goal-queue-after-switch",
        makeStream(sendMessage, { goalCompletionEpoch: 1 }),
      ),
    );

    await waitFor(() => {
      expect(tauriApi.getSessionGoalQueue).toHaveBeenCalledWith("goal-queue-after-switch");
    });
    expect(tauriApi.getSessionGoalQueue).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("promotes only after canonical Goal completion and leaves the item queued on decline", async () => {
    const confirmation: GoalStartConfirmationResult = {
      kind: "goal-start-confirmation",
      objective: upcomingGoal.objective,
      replace: false,
      permissionMode: "manual",
      goalSwitchArmed: false,
    };
    tauriApi.getSessionGoalQueue.mockResolvedValue({ goals: [upcomingGoal] });
    const sendMessage = vi
      .fn<UseSessionStreamReturn["sendMessage"]>()
      .mockResolvedValueOnce(confirmation);
    const initialStream = makeStream(sendMessage);
    const view = renderConversation("goal-queue-promote", initialStream);

    await waitFor(() => expect(tauriApi.getSessionGoalQueue).toHaveBeenCalled());
    expect(sendMessage).not.toHaveBeenCalled();

    view.rerender(
      conversation("goal-queue-promote", {
        ...initialStream,
        goalCompletionEpoch: 1,
      }),
    );

    await screen.findByRole("dialog", { name: "启动 Goal" });
    expect(sendMessage).toHaveBeenCalledWith("/goal -- Verify the release", [], {
      upcomingGoalId: upcomingGoal.id,
    });
    fireEvent.click(screen.getByRole("button", { name: "不开始" }));
    expect((screen.getByLabelText("Prompt") as HTMLInputElement).value).toBe("");
  });

  it("carries the queue id through confirmed start so backend dequeues after goal.create", async () => {
    const confirmation: GoalStartConfirmationResult = {
      kind: "goal-start-confirmation",
      objective: upcomingGoal.objective,
      replace: false,
      permissionMode: "manual",
      goalSwitchArmed: false,
    };
    tauriApi.getSessionGoalQueue.mockResolvedValue({ goals: [upcomingGoal] });
    const sendMessage = vi
      .fn<UseSessionStreamReturn["sendMessage"]>()
      .mockResolvedValueOnce(confirmation)
      .mockResolvedValueOnce(undefined);
    const initialStream = makeStream(sendMessage);
    const view = renderConversation("goal-queue-confirm", initialStream);

    await waitFor(() => expect(tauriApi.getSessionGoalQueue).toHaveBeenCalled());
    view.rerender(
      conversation("goal-queue-confirm", {
        ...initialStream,
        goalCompletionEpoch: 1,
      }),
    );
    await screen.findByRole("dialog", { name: "启动 Goal" });
    fireEvent.click(screen.getByRole("button", { name: "保持 Manual 并开始" }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenLastCalledWith("/goal -- Verify the release", [], {
        goalStartConfirmed: true,
        upcomingGoalId: upcomingGoal.id,
      });
    });
  });
});
