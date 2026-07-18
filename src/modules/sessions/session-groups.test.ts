import { describe, expect, it } from "vitest";
import type { Session } from "@/lib/api/models";
import { groupSessionsByDay } from "./session-groups";

const s = (id: string, daysAgo: number, now: Date): Session =>
	({
		sessionId: id,
		title: id,
		lastUpdated: new Date(now.getTime() - daysAgo * 86400000),
	}) as Session;

describe("groupSessionsByDay", () => {
	it("按 今天/昨天/本周/更早 分组且跳过空组", () => {
		const now = new Date("2026-07-18T12:00:00");
		const groups = groupSessionsByDay(
			[s("a", 0, now), s("b", 1, now), s("c", 3, now), s("d", 10, now)],
			now,
		);
		expect(groups.map((g) => g.label)).toEqual([
			"今天",
			"昨天",
			"本周",
			"更早",
		]);
		expect(groups[3].items[0].sessionId).toBe("d");
	});
	it("空列表返回空数组", () => {
		expect(groupSessionsByDay([])).toEqual([]);
	});
});
