import { describe, expect, it } from "vitest";
import {
	contextPercent,
	formatContextStatus,
	formatTokenCount,
} from "./context-format";

describe("formatTokenCount", () => {
	it("小于 1k 原样显示", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(1023)).toBe("1023");
	});

	it("1024 进制 k 格式，一位小数并 trim .0", () => {
		expect(formatTokenCount(1024)).toBe("1k");
		expect(formatTokenCount(2048)).toBe("2k");
		expect(formatTokenCount(1536)).toBe("1.5k");
		expect(formatTokenCount(87347)).toBe("85.3k");
	});

	it(">=100k 取整", () => {
		expect(formatTokenCount(262144)).toBe("256k");
		expect(formatTokenCount(1000448)).toBe("977k");
	});

	it("M 格式", () => {
		expect(formatTokenCount(1048576)).toBe("1M");
		expect(formatTokenCount(1572864)).toBe("1.5M");
	});

	it("非法输入归零", () => {
		expect(formatTokenCount(Number.NaN)).toBe("0");
		expect(formatTokenCount(-5)).toBe("0");
	});
});

describe("contextPercent", () => {
	it("精确 token 优先，向上取整", () => {
		expect(contextPercent(0.5, 66400, 200000)).toBe(34);
	});

	it("非零用量至少 1%", () => {
		expect(contextPercent(0, 1, 200000)).toBe(1);
		expect(contextPercent(0.001)).toBe(1);
	});

	it("clamp 到 [0,100]", () => {
		expect(contextPercent(0, 250000, 200000)).toBe(100);
		expect(contextPercent(1.5)).toBe(100);
		expect(contextPercent(-0.2)).toBe(0);
	});

	it("缺少精确 token 时回退 ratio", () => {
		expect(contextPercent(0.332)).toBe(34);
		expect(contextPercent(0.332, null, null)).toBe(34);
		expect(contextPercent(0.332, 100, 0)).toBe(34);
	});

	it("零用量显示 0", () => {
		expect(contextPercent(0)).toBe(0);
		expect(contextPercent(0, 0, 200000)).toBe(0);
	});
});

describe("formatContextStatus", () => {
	it("有精确窗口时显示 context: NN% (used/max)", () => {
		expect(formatContextStatus(0.5, 66400, 204800)).toBe(
			"context: 33% (64.8k/200k)",
		);
	});

	it("缺少精确窗口时只显示百分比", () => {
		expect(formatContextStatus(0.332)).toBe("context: 34%");
		expect(formatContextStatus(0.332, null, null)).toBe("context: 34%");
	});

	it("零用量", () => {
		expect(formatContextStatus(0, 0, 204800)).toBe("context: 0% (0/200k)");
	});
});
