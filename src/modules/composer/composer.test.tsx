import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ModelCapability, type ConfigModel } from "@/lib/api/models";
import { UiLanguageProvider } from "@/lib/i18n";
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
  return {
    ...render(
      <UiLanguageProvider>
        <Composer {...props} />
      </UiLanguageProvider>,
    ),
    props,
  };
};

describe("Composer integrations", () => {
  it("opens runtime slash commands and inserts commands that take arguments", () => {
    const { props } = renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /命令/ }));
    fireEvent.click(screen.getByText("/compact"));
    expect(props.onDraftChange).toHaveBeenLastCalledWith("/compact ");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("opens the command menu when a controlled slash draft is restored", () => {
    const view = renderComposer();
    view.rerender(
      <UiLanguageProvider>
        <Composer {...view.props} draft="/" />
      </UiLanguageProvider>,
    );
    expect(screen.getByText("/compact")).toBeTruthy();
  });

  it("wakes the command menu on slash keydown before the controlled draft updates", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/给 Kimi 布置任务/);
    fireEvent.keyDown(textarea, { key: "/" });
    expect(screen.getByText("/compact")).toBeTruthy();
  });

  it("does not send when Enter confirms an IME composition", () => {
    const { props } = renderComposer({ draft: "hello" });
    const textarea = screen.getByPlaceholderText(/给 Kimi 布置任务/);

    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });

    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("does not select a slash command when Enter confirms an IME composition", () => {
    const { props } = renderComposer({ draft: "/" });
    const textarea = screen.getByPlaceholderText(/给 Kimi 布置任务/);
    expect(screen.getByText("/compact")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });

    expect(props.onDraftChange).not.toHaveBeenCalled();
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

  it("switches models from the inline picker and opens the context panel", async () => {
    const { props } = renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /文件/ }));
    fireEvent.click(screen.getByRole("button", { name: /当前模型 kimi-k2.5/ }));
    expect(screen.getByRole("listbox", { name: "模型列表" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /plain/ }));
    expect(props.onOpenContext).toHaveBeenCalledOnce();
    expect(props.onSelectModel).toHaveBeenCalledWith("plain");
  });

  it("keeps every successful pasted path in a controlled draft", async () => {
    const onUploadFile = vi
      .fn()
      .mockResolvedValueOnce({ path: "uploads/a.txt", filename: "a.txt", size: 1 })
      .mockResolvedValueOnce({ path: "uploads/b.txt", filename: "b.txt", size: 1 });

    function Controlled() {
      const [draft, setDraft] = useState("");
      return (
        <Composer
          sessionId="multi-paste"
          draft={draft}
          onDraftChange={setDraft}
          onSend={vi.fn()}
          onCancel={vi.fn()}
          busy={false}
          canCancel={false}
          planMode={false}
          slashCommands={[]}
          queue={[]}
          onRemoveQueued={vi.fn()}
          onClearQueue={vi.fn()}
          onUploadFile={onUploadFile}
          onOpenContext={vi.fn()}
          models={sampleModels}
          selectedModel="kimi-k2.5"
          thinkingEnabled={false}
          thinkingEffort="high"
          onSelectModel={vi.fn()}
          onToggleThinking={vi.fn()}
          onSelectThinkingEffort={vi.fn()}
        />
      );
    }

    const { container } = render(
      <UiLanguageProvider>
        <Controlled />
      </UiLanguageProvider>,
    );
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("Expected the composer textarea");

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          { kind: "file", getAsFile: () => new File(["a"], "a.txt") },
          { kind: "file", getAsFile: () => new File(["b"], "b.txt") },
        ],
      },
    });

    await waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(textarea.value).toContain("@uploads/a.txt");
      expect(textarea.value).toContain("@uploads/b.txt");
    });
  });

  it("inserts successful pasted paths even when another pasted file fails", async () => {
    const onUploadFile = vi
      .fn()
      .mockResolvedValueOnce({ path: "uploads/good.txt", filename: "good.txt", size: 4 })
      .mockRejectedValueOnce(new Error("too large"));
    const onDraftChange = vi.fn();
    const { container } = renderComposer({
      sessionId: "partial-upload",
      onUploadFile,
      onDraftChange,
    });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("Expected the composer textarea");

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          { kind: "file", getAsFile: () => new File(["good"], "good.txt") },
          { kind: "file", getAsFile: () => new File(["bad"], "bad.txt") },
        ],
      },
    });

    await waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenCalledWith("@uploads/good.txt "),
    );
  });

  it("pastes clipboard files as @path text into the draft", async () => {
    const { container, props } = renderComposer({ sessionId: "paste-files" });
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("Expected the composer textarea");
    const file = new File(["image"], "paste.png", { type: "image/png" });

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => file }],
      },
    });

    await waitFor(() => expect(props.onUploadFile).toHaveBeenCalledWith(file));
    await waitFor(() =>
      expect(props.onDraftChange).toHaveBeenLastCalledWith("@uploads/notes.txt "),
    );
    expect(screen.queryByRole("button", { name: /Remove attachment/ })).toBeNull();
  });

  it("keeps the send button disabled while the draft is empty", async () => {
    const { container, props } = renderComposer({ sessionId: "file-only" });
    const sendButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.querySelector(".lucide-arrow-up"),
    );
    if (!sendButton) throw new Error("Expected the composer send button");
    expect(sendButton.disabled).toBe(true);
    fireEvent.click(sendButton);
    expect(props.onSend).not.toHaveBeenCalled();
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

  it("closes the command menu on Escape even when there are no matches", () => {
    renderComposer({
      sessionId: "escape-menu",
      draft: "/zzz-no-match",
    });
    fireEvent.click(screen.getByRole("button", { name: /命令/ }));
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();
    const textarea = screen.getByPlaceholderText(/给 Kimi 布置任务/);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByText("没有匹配的命令")).toBeNull();
    // Match CLI web: further typing while still on "/…" reopens the menu.
    fireEvent.change(textarea, { target: { value: "/zzz-no-matchx" } });
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();
  });

  it("closes the command menu on outside click", () => {
    renderComposer({ sessionId: "outside-menu", draft: "/" });
    fireEvent.click(screen.getByRole("button", { name: /命令/ }));
    expect(screen.getByText("/compact")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("/compact")).toBeNull();
  });

  it("blocks send when sendDisabled", () => {
    const { props } = renderComposer({
      sessionId: "send-disabled",
      draft: "hello",
      sendDisabled: true,
    });
    expect(screen.getByPlaceholderText(/连接已断开/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("opens @ file mention menu and inserts a workspace path", async () => {
    const listDirectory = vi.fn().mockResolvedValue([
      { name: "src", type: "directory" },
      { name: "readme.md", type: "file", size: 12 },
    ]);
    const onDraftChange = vi.fn();
    renderComposer({
      sessionId: "mention-files",
      draft: "@",
      onDraftChange,
      listDirectory,
    });
    expect(await screen.findByRole("listbox", { name: "文件引用" })).toBeTruthy();
    const option = await screen.findByRole("option", { name: /readme\.md/ });
    fireEvent.click(option);
    expect(onDraftChange).toHaveBeenCalledWith(expect.stringMatching(/^@readme\.md ?$/));
  });

  it("shows every slash command without a display cap", () => {
    const many = Array.from({ length: 15 }, (_, index) => ({
      name: `cmd-${index}`,
      description: "",
      aliases: [],
    }));
    renderComposer({ sessionId: "many-commands", slashCommands: many });
    fireEvent.click(screen.getByRole("button", { name: /命令/ }));
    expect(screen.getByText("/cmd-0")).toBeTruthy();
    expect(screen.getByText("/cmd-14")).toBeTruthy();
  });
});
