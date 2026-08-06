import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/api/models";
import { UI_LANGUAGE_STORAGE_KEY, UiLanguageProvider } from "@/lib/i18n";
import { SessionsSidebar, type SessionsSidebarProps } from "./sessions-sidebar";

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  message: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

function session(id: string, archived = false): Session {
  return {
    sessionId: id,
    title: `会话 ${id}`,
    lastUpdated: new Date("2026-01-01T00:00:00Z"),
    isRunning: false,
    archived,
  };
}

function renderSidebar(overrides: Partial<SessionsSidebarProps> = {}) {
  const props: SessionsSidebarProps = {
    sessions: [session("abcdef123456")],
    archivedSessions: [session("archived123456", true)],
    selectedId: "",
    searchQuery: "",
    onSearchQueryChange: vi.fn(),
    onSelect: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onArchiveProject: vi.fn().mockResolvedValue(2),
    onBulkArchive: vi.fn().mockResolvedValue(undefined),
    onBulkUnarchive: vi.fn().mockResolvedValue(undefined),
    onBulkDelete: vi.fn().mockResolvedValue(undefined),
    onArchiveOlderThan: vi.fn().mockResolvedValue(undefined),
    onLoadArchived: vi.fn().mockResolvedValue(undefined),
    onLoadMore: vi.fn().mockResolvedValue(undefined),
    hasLoadedArchived: true,
    hasMoreActive: false,
    hasMoreArchived: false,
    isLoadingMoreActive: false,
    isLoadingMoreArchived: false,
    isLoadingActive: false,
    isLoadingArchived: false,
    ...overrides,
  };

  const result = render(
    <UiLanguageProvider>
      <SessionsSidebar {...props} />
    </UiLanguageProvider>,
  );
  return { ...result, props };
}

describe("SessionsSidebar context menu", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, "zh-CN");
    vi.clearAllMocks();
    window.confirm = vi.fn(() => true);
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("copies the full and short session IDs", async () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByText("会话 abcdef123456"));

    fireEvent.click(screen.getByRole("menuitem", { name: "复制会话 ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("abcdef123456"));
    expect(screen.queryByRole("menu", { name: "会话操作" })).toBeNull();

    fireEvent.contextMenu(screen.getByText("会话 abcdef123456"));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制短 ID" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("abcdef"));
    expect(toastMocks.success).toHaveBeenCalledWith("已复制短 ID");
  });

  it("exposes rename, archive, and delete actions", () => {
    const { props } = renderSidebar();
    fireEvent.contextMenu(screen.getByText("会话 abcdef123456"));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档会话" }));
    expect(props.onArchive).toHaveBeenCalledWith("abcdef123456");

    fireEvent.contextMenu(screen.getByText("会话 abcdef123456"));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除会话" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(props.onDelete).toHaveBeenCalledWith("abcdef123456");

    fireEvent.contextMenu(screen.getByText("会话 abcdef123456"));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "会话标题" });
    fireEvent.change(input, { target: { value: "新的标题" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("abcdef123456", "新的标题");
  });

  it("restores archived sessions from the context menu", () => {
    const { props } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    fireEvent.contextMenu(screen.getByText("会话 archived123456"));

    fireEvent.click(screen.getByRole("menuitem", { name: "恢复会话" }));
    expect(props.onUnarchive).toHaveBeenCalledWith("archived123456");
  });

  it("closes the context menu with Escape or an outside click", () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByText("会话 abcdef123456"));
    expect(screen.getByRole("menu", { name: "会话操作" })).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "会话操作" })).toBeNull();

    fireEvent.contextMenu(screen.getByText("会话 abcdef123456"));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "会话操作" })).toBeNull();
  });

  it("archives the complete project group even when search hides sessions", async () => {
    window.localStorage.setItem("kimi-code-desktop.session-group-mode.v1", "project");
    const first = { ...session("first"), workDir: "/workspace/demo" };
    const second = { ...session("second"), workDir: "/workspace/demo" };
    const { props } = renderSidebar({
      sessions: [first, second],
      searchQuery: "first",
    });

    const archiveButton = screen.getByRole("button", { name: "归档该项目全部会话" });
    fireEvent.pointerDown(archiveButton);
    fireEvent.click(archiveButton);

    expect(screen.getByRole("dialog").textContent).toContain("归档项目「demo」？");
    expect(window.confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() =>
      expect(props.onArchiveProject).toHaveBeenCalledWith(
        ["first", "second"],
        true,
        "/workspace/demo",
      ),
    );
  });

  it("does not archive a project when the confirmation is cancelled", async () => {
    window.localStorage.setItem("kimi-code-desktop.session-group-mode.v1", "project");
    const first = { ...session("first"), workDir: "/workspace/demo" };
    const { props } = renderSidebar({ sessions: [first] });

    fireEvent.click(screen.getByRole("button", { name: "归档该项目全部会话" }));

    expect(screen.getByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(props.onArchiveProject).not.toHaveBeenCalled();
  });

  it("lets the hook handle busy sessions without blocking the project action", async () => {
    window.localStorage.setItem("kimi-code-desktop.session-group-mode.v1", "project");
    const busy = {
      ...session("busy"),
      workDir: "/workspace/demo",
      status: {
        sessionId: "busy",
        state: "busy" as const,
        seq: 1,
        updatedAt: new Date(),
      },
    };
    const idle = { ...session("idle"), workDir: "/workspace/demo" };
    const { props } = renderSidebar({ sessions: [busy, idle] });

    fireEvent.click(screen.getByRole("button", { name: "归档该项目全部会话" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));

    await waitFor(() =>
      expect(props.onArchiveProject).toHaveBeenCalledWith(
        ["busy", "idle"],
        true,
        "/workspace/demo",
      ),
    );
  });

  it("opens project actions from the folder context menu", async () => {
    window.localStorage.setItem("kimi-code-desktop.session-group-mode.v1", "project");
    const first = { ...session("first"), workDir: "/workspace/demo" };
    const second = { ...session("second"), workDir: "/workspace/demo" };
    const { props } = renderSidebar({ sessions: [first, second] });

    fireEvent.contextMenu(screen.getByText("demo"));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档项目全部会话" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));

    await waitFor(() =>
      expect(props.onArchiveProject).toHaveBeenCalledWith(
        ["first", "second"],
        true,
        "/workspace/demo",
      ),
    );
  });

  it("shows an error when the project archive updates no sessions", async () => {
    window.localStorage.setItem("kimi-code-desktop.session-group-mode.v1", "project");
    const first = { ...session("first"), workDir: "/workspace/demo" };
    const { props } = renderSidebar({
      sessions: [first],
      onArchiveProject: vi.fn().mockResolvedValue(0),
    });

    fireEvent.click(screen.getByRole("button", { name: "归档该项目全部会话" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("项目「demo」没有归档任何会话。"),
    );
    expect(props.onArchiveProject).toHaveBeenCalledWith(["first"], true, "/workspace/demo");
  });

  it("restores every session in an archived project from its context menu", async () => {
    window.localStorage.setItem("kimi-code-desktop.session-group-mode.v1", "project");
    const first = { ...session("first", true), workDir: "/workspace/demo" };
    const second = { ...session("second", true), workDir: "/workspace/demo" };
    const { props } = renderSidebar({ sessions: [], archivedSessions: [first, second] });

    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    fireEvent.contextMenu(screen.getByText("demo"));
    fireEvent.click(screen.getByRole("menuitem", { name: "恢复项目全部会话" }));

    await waitFor(() =>
      expect(props.onArchiveProject).toHaveBeenCalledWith(
        ["first", "second"],
        false,
        "/workspace/demo",
      ),
    );
  });

  it("copies the session ID with the legacy document fallback", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });
    renderSidebar();

    fireEvent.contextMenu(screen.getByText("会话 abcdef123456"));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制会话 ID" }));

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("已复制会话 ID"));
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });
});
