import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer, type QueuedPrompt } from "./composer";

const renderComposer = (overrides: Partial<Parameters<typeof Composer>[0]> = {}) => {
  const props: Parameters<typeof Composer>[0] = {
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
    modelLabel: "kimi-k2.5",
    onOpenModelSettings: vi.fn(),
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

  it("uploads files through the session API and exposes context/model controls", async () => {
    const { container, props } = renderComposer();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Expected the composer file input");
    fireEvent.change(input, {
      target: { files: [new File(["test"], "notes.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(props.onUploadFile).toHaveBeenCalledOnce());
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /上下文/ }));
    fireEvent.click(screen.getByRole("button", { name: /kimi-k2.5/ }));
    expect(props.onOpenContext).toHaveBeenCalledOnce();
    expect(props.onOpenModelSettings).toHaveBeenCalledOnce();
  });
});
