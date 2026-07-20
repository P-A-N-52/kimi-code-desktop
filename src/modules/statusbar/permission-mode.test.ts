import { describe, expect, it } from "vitest";
import { shouldAutoApprove } from "./permission-mode";

describe("shouldAutoApprove", () => {
	it("manual 模式全部不自动批准", () => {
		expect(shouldAutoApprove("manual", "Read", "read")).toBe(false);
		expect(shouldAutoApprove("manual", "Bash", "execute")).toBe(false);
	});

	it("yolo 模式自动批准普通工具调用", () => {
		expect(shouldAutoApprove("yolo", "Bash", "execute")).toBe(true);
		expect(shouldAutoApprove("yolo", "Edit", "edit")).toBe(true);
		expect(shouldAutoApprove("yolo", "Read", "read")).toBe(true);
	});

	it("auto 模式全部自动批准", () => {
		expect(shouldAutoApprove("auto", "Read", "read")).toBe(true);
		expect(shouldAutoApprove("auto", "Bash", "execute")).toBe(true);
		expect(shouldAutoApprove("auto", "Edit", "edit")).toBe(true);
	});
});
