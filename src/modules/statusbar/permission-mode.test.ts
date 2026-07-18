import { describe, expect, it } from "vitest";
import { SAFE_AUTO_APPROVE_TOOLS, shouldAutoApprove } from "./permission-mode";

describe("shouldAutoApprove", () => {
	it("ask 模式全部不自动批准", () => {
		expect(shouldAutoApprove("ask", "Read")).toBe(false);
		expect(shouldAutoApprove("ask", "Bash")).toBe(false);
	});
	it("yolo 模式全部自动批准", () => {
		expect(shouldAutoApprove("yolo", "Bash")).toBe(true);
		expect(shouldAutoApprove("yolo", "Edit")).toBe(true);
	});
	it("auto 模式只放行白名单（大小写不敏感）", () => {
		expect(shouldAutoApprove("auto", "Read")).toBe(true);
		expect(shouldAutoApprove("auto", "grep")).toBe(true);
		expect(shouldAutoApprove("auto", "Bash")).toBe(false);
		expect(shouldAutoApprove("auto", "Edit")).toBe(false);
		expect(SAFE_AUTO_APPROVE_TOOLS).toContain("Glob");
	});
});
