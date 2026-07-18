import { describe, expect, it } from "vitest";
import type { LiveMessage } from "@/hooks/types";
import { deriveChanges, derivePendingApprovals } from "./derive-changes";

const toolMsg = (id: string, path: string, oldT: string, newT: string): LiveMessage =>
	({
		id,
		role: "assistant",
		variant: "tool",
		toolCall: {
			title: "Edit",
			type: "tool-Edit" as never,
			state: "output-available",
			display: [
				{ type: "diff", data: { type: "diff", path, old_text: oldT, new_text: newT } },
			],
		},
	}) as LiveMessage;

describe("deriveChanges", () => {
	it("提取 diff 变更并按 path 去重（后者覆盖前者并移到末尾）", () => {
		const changes = deriveChanges(
			[toolMsg("1", "a.ts", "x", "y"), toolMsg("2", "b.ts", "1", "2"), toolMsg("3", "a.ts", "y", "z")],
			() => ({ adds: 1, dels: 1 }),
		);
		expect(changes.map((c) => c.path)).toEqual(["b.ts", "a.ts"]);
		expect(changes.find((c) => c.path === "a.ts")?.display.new_text).toBe("z");
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
