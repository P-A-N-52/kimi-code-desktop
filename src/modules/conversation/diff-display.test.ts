import { describe, expect, it } from "vitest";
import { findDiffDisplay, parseDiffDisplay } from "./diff-display";

describe("parseDiffDisplay", () => {
	it("识别合法 diff display block", () => {
		expect(
			parseDiffDisplay({ type: "diff", path: "a.ts", old_text: "1", new_text: "2" }),
		).toMatchObject({ path: "a.ts" });
	});
	it("拒绝缺字段的 block", () => {
		expect(parseDiffDisplay({ type: "diff", path: "a.ts" })).toBeNull();
		expect(parseDiffDisplay(null)).toBeNull();
		expect(parseDiffDisplay("x")).toBeNull();
	});
});

describe("findDiffDisplay", () => {
	it("从 display 数组中取第一个 diff block", () => {
		const display = [
			{ type: "text", data: { text: "hi" } },
			{ type: "diff", data: { type: "diff", path: "b.ts", old_text: "a", new_text: "b" } },
		];
		expect(findDiffDisplay(display)?.path).toBe("b.ts");
	});
	it("无 diff 返回 null", () => {
		expect(findDiffDisplay([{ type: "text", data: {} }])).toBeNull();
		expect(findDiffDisplay(undefined)).toBeNull();
	});
});
