import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionFileEntry } from "@/hooks/useSessions";
import { FilesTab } from "./files-tab";

vi.mock("@/lib/tool-events/store", () => ({
  EMPTY_TOOL_EVENTS: { newFiles: [], todoItems: [], currentGoal: null },
  useToolEventsStore: (selector: (state: object) => unknown) => selector({ sessions: {} }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const file = (name: string): SessionFileEntry => ({ name, type: "file", size: 1 });

function textBlob(text: string): Blob {
  return {
    type: "text/plain",
    size: text.length,
    text: () => Promise.resolve(text),
  } as Blob;
}

describe("FilesTab request generations", () => {
  it("ignores a late directory response after switching sessions", async () => {
    const first = deferred<SessionFileEntry[]>();
    const second = deferred<SessionFileEntry[]>();
    const listDirectory = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = render(
      <FilesTab sessionId="session-1" listDirectory={listDirectory} getFile={vi.fn()} />,
    );
    view.rerender(
      <FilesTab sessionId="session-2" listDirectory={listDirectory} getFile={vi.fn()} />,
    );

    await act(async () => second.resolve([file("current.txt")]));
    expect(await screen.findByText("current.txt")).toBeTruthy();
    await act(async () => first.resolve([file("stale.txt")]));
    expect(screen.queryByText("stale.txt")).toBeNull();
    expect(screen.getByText("current.txt")).toBeTruthy();
  });

  it("keeps the newest refresh when directory requests resolve out of order", async () => {
    const initial = deferred<SessionFileEntry[]>();
    const olderRefresh = deferred<SessionFileEntry[]>();
    const newestRefresh = deferred<SessionFileEntry[]>();
    const listDirectory = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(olderRefresh.promise)
      .mockReturnValueOnce(newestRefresh.promise);
    const user = userEvent.setup();
    render(<FilesTab sessionId="session-1" listDirectory={listDirectory} getFile={vi.fn()} />);
    await act(async () => initial.resolve([file("initial.txt")]));
    await screen.findByText("initial.txt");

    await user.click(screen.getByRole("button", { name: "刷新文件" }));
    await user.click(screen.getByRole("button", { name: "刷新文件" }));
    await act(async () => newestRefresh.resolve([file("newest.txt")]));
    expect(await screen.findByText("newest.txt")).toBeTruthy();
    await act(async () => olderRefresh.resolve([file("older.txt")]));
    expect(screen.queryByText("older.txt")).toBeNull();
  });

  it("ignores an older file preview after another file is selected", async () => {
    const firstPreview = deferred<Blob>();
    const secondPreview = deferred<Blob>();
    const getFile = vi
      .fn()
      .mockReturnValueOnce(firstPreview.promise)
      .mockReturnValueOnce(secondPreview.promise);
    const user = userEvent.setup();
    render(
      <FilesTab
        sessionId="session-1"
        listDirectory={vi.fn().mockResolvedValue([file("a.txt"), file("b.txt")])}
        getFile={getFile}
      />,
    );
    await screen.findByText("a.txt");
    await user.click(screen.getByText("a.txt"));
    await user.click(screen.getByRole("button", { name: /a\.txt/ }));
    await user.click(screen.getByText("b.txt"));

    await act(async () => secondPreview.resolve(textBlob("newest preview")));
    expect(await screen.findByText("newest preview")).toBeTruthy();
    await act(async () => firstPreview.resolve(textBlob("stale preview")));
    await waitFor(() => expect(screen.queryByText("stale preview")).toBeNull());
  });
});
