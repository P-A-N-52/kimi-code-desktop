import { describe, expect, it } from "vitest";
import { parsePermissionMode, shouldAutoApprove } from "./permission-mode";

describe("parsePermissionMode", () => {
	it("accepts known modes and maps legacy ask to manual", () => {
		expect(parsePermissionMode("manual")).toBe("manual");
		expect(parsePermissionMode("yolo")).toBe("yolo");
		expect(parsePermissionMode("auto")).toBe("auto");
		expect(parsePermissionMode("ask")).toBe("manual");
		expect(parsePermissionMode("unexpected")).toBe("manual");
		expect(parsePermissionMode(undefined)).toBe("manual");
	});
});

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
