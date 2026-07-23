import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelCapability, type ConfigModel } from "@/lib/api/models";
import { Composer, type QueuedPrompt } from "./composer";

const sampleModels: ConfigModel[] = [
  {
    name: "kimi-k2.5",
    provider: "kimi",
    model: "kimi-k2.5",
    maxContextSize: 128000,
    providerType: "kimi",
    capabilities: new Set([ModelCapability.Thinking]),
  },
  {
    name: "plain",
    provider: "openai",
    model: "gpt",
    maxContextSize: 64000,
    providerType: "openai_legacy",
  },
  {
    name: "reasoner",
    provider: "kimi",
    model: "reasoner",
    maxContextSize: 128000,
    providerType: "kimi",
    capabilities: new Set([ModelCapability.AlwaysThinking]),
    supportEfforts: ["low", "high", "max"],
    defaultEffort: "high",
  },
];

const renderComposer = (overrides: Partial<Parameters<typeof Composer>[0]> = {}) => {
  const props: Parameters<typeof Composer>[0] = {
    sessionId: "session-1",
    draft: "",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    busy: false,
    canCancel: false,
    planMode: false,
    slashCommands: [
      { name: "compact", description: "Compact context", aliases: [], inputHint: "instructions" },
    ],
    queue: [],
    onRemoveQueued: vi.fn(),
    onClearQueue: vi.fn(),
    onUploadFile: vi
      .fn()
      .mockResolvedValue({ path: "uploads/notes.txt", filename: "notes.txt", size: 4 }),
    onOpenContext: vi.fn(),
    models: sampleModels,
    selectedModel: "kimi-k2.5",
    thinkingEnabled: false,
    thinkingEffort: "high",
    onSelectModel: vi.fn(),
    onToggleThinking: vi.fn(),
    onSelectThinkingEffort: vi.fn(),
    ...overrides,
  };
  return { ...render(<Composer {...props} />), props };
};

describe("Composer integrations", () => {
  it("opens ACP slash commands and inserts commands that take arguments", () => {
    const { props } = renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /命令/ }));
    fireEvent.click(screen.getByText("/compact"));
    expect(props.onDraftChange).toHaveBeenLastCalledWith("/compact ");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("keeps stop and queue actions separate while a prompt is running", () => {
    const queue: QueuedPrompt[] = [{ id: "q1", text: "queued follow-up" }];
    const { props } = renderComposer({
      draft: "another follow-up",
      busy: true,
      canCancel: true,
      queue,
    });
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    fireEvent.click(screen.getByRole("button", { name: "加入发送队列" }));
    fireEvent.click(screen.getByRole("button", { name: "移除队列项 1" }));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onSend).toHaveBeenCalledOnce();
    expect(props.onRemoveQueued).toHaveBeenCalledWith("q1");
  });

  it("does not show stop while the session is only initializing", () => {
    renderComposer({ busy: true, canCancel: false });
    expect(screen.queryByRole("button", { name: "停止生成" })).toBeNull();
  });

  it("uploads files and switches models from the inline picker", async () => {
    const { container, props } = renderComposer();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Expected the composer file input");
    fireEvent.change(input, {
      target: { files: [new File(["test"], "notes.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(props.onUploadFile).toHaveBeenCalledOnce());
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /上下文/ }));
    fireEvent.click(screen.getByRole("button", { name: /当前模型 kimi-k2.5/ }));
    expect(screen.getByRole("listbox", { name: "模型列表" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /plain/ }));
    expect(props.onOpenContext).toHaveBeenCalledOnce();
    expect(props.onSelectModel).toHaveBeenCalledWith("plain");
  });

  it("keeps successful uploads visible when another selected file fails", async () => {
    const onUploadFile = vi
      .fn()
      .mockResolvedValueOnce({ path: "uploads/good.txt", filename: "good.txt", size: 4 })
      .mockRejectedValueOnce(new Error("too large"));
    const { container } = renderComposer({ sessionId: "partial-upload", onUploadFile });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Expected the composer file input");

    fireEvent.change(input, {
      target: {
        files: [
          new File(["good"], "good.txt", { type: "text/plain" }),
          new File(["bad"], "bad.txt", { type: "text/plain" }),
        ],
      },
    });

    expect(await screen.findByText("good.txt")).toBeTruthy();
    await waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("bad.txt")).toBeNull();
  });

  it("shows a thinking toggle only for models that support it", () => {
    const first = renderComposer();
    fireEvent.click(first.getByRole("button", { name: /当前模型 kimi-k2.5/ }));
    expect(first.getByLabelText("切换思考模式")).toBeTruthy();
    fireEvent.click(first.getByLabelText("切换思考模式"));
    expect(first.props.onToggleThinking).toHaveBeenCalledWith(true);
    first.unmount();

    const plain = renderComposer({ selectedModel: "plain", thinkingEnabled: false });
    fireEvent.click(plain.getByRole("button", { name: /当前模型 plain/ }));
    expect(plain.queryByLabelText("切换思考模式")).toBeNull();
    expect(plain.queryByLabelText("思考模式由模型强制启用")).toBeNull();
    plain.unmount();

    const forced = renderComposer({ selectedModel: "reasoner", thinkingEnabled: false });
    fireEvent.click(forced.getByRole("button", { name: /当前模型 reasoner/ }));
    const forcedSwitch = forced.getByLabelText("思考模式由模型强制启用");
    expect((forcedSwitch as HTMLButtonElement).disabled).toBe(true);
    expect(forcedSwitch.className).toContain("disabled:bg-hover");
    fireEvent.click(forcedSwitch);
    expect(forced.props.onToggleThinking).not.toHaveBeenCalled();
  });

  it("shows and updates only efforts supported by the selected model", () => {
    const forced = renderComposer({ selectedModel: "reasoner", thinkingEffort: "high" });
    fireEvent.click(forced.getByRole("button", { name: /当前模型 reasoner/ }));
    expect(forced.getByRole("group", { name: "思考档位" })).toBeTruthy();
    expect(forced.getByRole("button", { name: "思考档位 low" })).toBeTruthy();
    expect(
      forced.getByRole("button", { name: "思考档位 high" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(forced.getByRole("button", { name: "思考档位 max" })).toBeTruthy();
    expect(forced.queryByRole("button", { name: "思考档位 medium" })).toBeNull();
    fireEvent.click(forced.getByRole("button", { name: "思考档位 max" }));
    expect(forced.props.onSelectThinkingEffort).toHaveBeenCalledWith("max");
    forced.unmount();

    const plain = renderComposer({ selectedModel: "plain" });
    fireEvent.click(plain.getByRole("button", { name: /当前模型 plain/ }));
    expect(plain.queryByRole("group", { name: "思考档位" })).toBeNull();
  });

  it("offers a secondary manage-config link from the model picker", () => {
    const onManageConfig = vi.fn();
    renderComposer({ onManageConfig });
    fireEvent.click(screen.getByRole("button", { name: /当前模型 kimi-k2.5/ }));
    fireEvent.click(screen.getByRole("button", { name: "在设置中管理配置…" }));
    expect(onManageConfig).toHaveBeenCalledOnce();
    expect(screen.queryByRole("listbox", { name: "模型列表" })).toBeNull();
  });
});
