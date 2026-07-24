import { describe, expect, it } from "vitest";
import type { Session } from "@/lib/api/models";
import {
  groupSessionsByDay,
  groupSessionsByWorkDir,
  normalizeWorkDirKey,
  readSessionGroupMode,
  workDirGroupLabel,
  writeSessionGroupMode,
} from "./session-groups";

const s = (
  id: string,
  daysAgo: number,
  now: Date,
  workDir?: string | null,
): Session =>
  ({
    sessionId: id,
    title: id,
    lastUpdated: new Date(now.getTime() - daysAgo * 86400000),
    workDir,
  }) as Session;

describe("groupSessionsByDay", () => {
  it("按 今天/昨天/本周/更早 分组且跳过空组", () => {
    const now = new Date("2026-07-18T12:00:00");
    const groups = groupSessionsByDay(
      [s("a", 0, now), s("b", 1, now), s("c", 3, now), s("d", 10, now)],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "本周", "更早"]);
    expect(groups[3].items[0].sessionId).toBe("d");
  });
  it("空列表返回空数组", () => {
    expect(groupSessionsByDay([])).toEqual([]);
  });
});

describe("groupSessionsByWorkDir", () => {
  it("按完整工作区路径分组并按最近活跃排序", () => {
    const now = new Date("2026-07-18T12:00:00");
    const groups = groupSessionsByWorkDir([
      s("old", 5, now, "C:/work/alpha"),
      s("new", 0, now, "C:/work/beta"),
      s("mid", 1, now, "C:\\work\\alpha"),
      s("orphan", 2, now, null),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["beta", "alpha", "默认目录"]);
    expect(groups[0].key).toBe("c:/work/beta");
    expect(groups[1].key).toBe("c:/work/alpha");
    expect(groups[1].items.map((item) => item.sessionId)).toEqual(["mid", "old"]);
  });

  it("同名项目用父目录消歧", () => {
    const now = new Date("2026-07-18T12:00:00");
    const groups = groupSessionsByWorkDir([
      s("a", 0, now, "C:/a/foo"),
      s("b", 1, now, "D:/b/foo"),
    ]);
    expect(groups.map((g) => g.label).sort()).toEqual(["foo (a)", "foo (b)"]);
  });

  it("空列表返回空数组", () => {
    expect(groupSessionsByWorkDir([])).toEqual([]);
  });
});

describe("workDirGroupLabel", () => {
  it("取路径末段，Home 与默认目录", () => {
    expect(workDirGroupLabel("C:\\Users\\me\\proj\\")).toBe("proj");
    expect(workDirGroupLabel("C:\\Users\\me")).toBe("Home");
    expect(workDirGroupLabel(null)).toBe("默认目录");
  });
});

describe("normalizeWorkDirKey", () => {
  it("统一斜杠与盘符大小写", () => {
    expect(normalizeWorkDirKey("C:\\Work\\A\\")).toBe("c:/Work/A");
    expect(normalizeWorkDirKey(null)).toBe("__default__");
  });
});

describe("session group mode persistence", () => {
  it("读写 localStorage 中的分组方式", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(readSessionGroupMode(storage)).toBe("day");
    writeSessionGroupMode("project", storage);
    expect(readSessionGroupMode(storage)).toBe("project");
  });
});
