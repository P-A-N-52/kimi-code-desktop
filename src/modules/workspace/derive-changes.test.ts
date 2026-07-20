import { describe, expect, it } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import { deriveChanges, derivePendingApprovals, mergeGitChanges } from "./derive-changes";

const toolMsg = (id: string, path: string, oldT: string, newT: string): LiveMessage =>
  ({
    id,
    role: "assistant",
    variant: "tool",
    toolCall: {
      title: "Edit",
      type: "tool-Edit" as never,
      state: "output-available",
      display: [{ type: "diff", data: { type: "diff", path, old_text: oldT, new_text: newT } }],
    },
  }) as LiveMessage;

describe("deriveChanges", () => {
  it("提取 diff 变更并按 path 去重（后者覆盖前者并移到末尾）", () => {
    const changes = deriveChanges(
      [
        toolMsg("1", "a.ts", "x", "y"),
        toolMsg("2", "b.ts", "1", "2"),
        toolMsg("3", "a.ts", "y", "z"),
      ],
      () => ({ adds: 1, dels: 1 }),
    );
    expect(changes.map((c) => c.path)).toEqual(["b.ts", "a.ts"]);
    expect(changes.find((c) => c.path === "a.ts")?.display?.new_text).toBe("z");
  });
  it("无 diff 时返回空", () => {
    expect(deriveChanges([], () => ({ adds: 0, dels: 0 }))).toEqual([]);
  });
});

describe("derivePendingApprovals", () => {
  it("只收集未处理的审批", () => {
    const pending: LiveMessage = {
      id: "1",
      role: "assistant",
      variant: "tool",
      toolCall: {
        title: "Bash",
        type: "tool-Bash" as never,
        state: "approval-requested",
        approval: { id: "r1", action: "Bash", description: "x", sender: "kimi" },
      },
    } as LiveMessage;
    const resolved: LiveMessage = {
      id: "2",
      role: "assistant",
      variant: "tool",
      toolCall: {
        title: "Bash",
        type: "tool-Bash" as never,
        state: "approval-requested",
        approval: { id: "r2", action: "Bash", description: "x", sender: "kimi", resolved: true },
      },
    } as LiveMessage;
    const list = derivePendingApprovals([pending, resolved]);
    expect(list.map((a) => a.id)).toEqual(["r1"]);
  });
});

describe("mergeGitChanges", () => {
  it("uses git stats as the source of truth and keeps matching diff previews", () => {
    const semantic = deriveChanges([toolMsg("1", "src/app.tsx", "old", "new")], () => ({
      adds: 1,
      dels: 1,
    }));
    const changes = mergeGitChanges(semantic, {
      isGitRepo: true,
      files: [
        {
          path: "src/app.tsx",
          additions: 12,
          deletions: 3,
          status: "modified",
        },
        {
          path: "src/new.ts",
          additions: 8,
          deletions: 0,
          status: "added",
        },
      ],
    });

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      path: "src/app.tsx",
      adds: 12,
      dels: 3,
      status: "modified",
    });
    expect(changes[0]?.display?.new_text).toBe("new");
    expect(changes[1]).toMatchObject({
      path: "src/new.ts",
      status: "added",
      display: undefined,
    });
  });
});
