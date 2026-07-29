import { describe, expect, it } from "vitest";
import {
	isAskUserTool,
	isPlanTool,
	parseAskUserToolOutput,
	parsePermissionMode,
	shouldAutoApprove,
} from "./permission-mode";

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

describe("isAskUserTool", () => {
	it("识别 Ask User 工具标题", () => {
		expect(isAskUserTool("AskUserQuestion")).toBe(true);
		expect(isAskUserTool("ask_user_question")).toBe(true);
		expect(isAskUserTool("Ask User")).toBe(true);
		// ACP tool_call title uses the tool description, not the canonical name.
		expect(isAskUserTool("Asking user questions")).toBe(true);
		expect(isAskUserTool("Starting background question: Which DB?")).toBe(true);
		expect(isAskUserTool("Bash")).toBe(false);
		expect(isAskUserTool(undefined)).toBe(false);
	});
});

describe("parseAskUserToolOutput", () => {
	it("parses answers and dismissed notes", () => {
		expect(
			parseAskUserToolOutput(
				JSON.stringify({ answers: { Approach: "Ship it" } }),
			),
		).toEqual({
			answers: { Approach: "Ship it" },
			dismissed: false,
			note: undefined,
		});
		expect(
			parseAskUserToolOutput(
				JSON.stringify({
					answers: {},
					note: "User dismissed the question without answering.",
				}),
			),
		).toEqual({
			answers: {},
			dismissed: true,
			note: "User dismissed the question without answering.",
		});
		expect(parseAskUserToolOutput("not-json")).toEqual({
			answers: {},
			dismissed: false,
		});
	});
});

describe("looksLikeAskUserInput / resolveAskUserParentToolCallId", () => {
	it("识别 questions 形参并剥离 ACP question 后缀", async () => {
		const {
			looksLikeAskUserInput,
			isAskUserToolCall,
			resolveAskUserParentToolCallId,
		} = await import("./permission-mode");

		expect(
			looksLikeAskUserInput({
				questions: [
					{
						question: "Which approach?",
						header: "Approach",
						options: [{ label: "A", description: "" }],
					},
				],
			}),
		).toBe(true);
		expect(looksLikeAskUserInput({ prompt: "go" })).toBe(false);
		expect(
			isAskUserToolCall({
				title: "确认一下",
				input: {
					questions: [
						{
							question: "Which approach?",
							options: [{ label: "A", description: "" }],
						},
					],
				},
			}),
		).toBe(true);
		expect(resolveAskUserParentToolCallId("1:tool_abc:question:0")).toBe(
			"1:tool_abc",
		);
		expect(
			resolveAskUserParentToolCallId("1:tool_abc:question:0:option:2"),
		).toBe("1:tool_abc");
		expect(resolveAskUserParentToolCallId("1:tool_abc")).toBe("1:tool_abc");
	});
});

describe("isPlanTool", () => {
	it("识别 ExitPlanMode / EnterPlanMode / plan_review", () => {
		expect(isPlanTool("ExitPlanMode")).toBe(true);
		expect(isPlanTool("Exit Plan Mode")).toBe(true);
		expect(isPlanTool("EnterPlanMode")).toBe(true);
		expect(isPlanTool("plan_review")).toBe(true);
		expect(isPlanTool("Bash")).toBe(false);
		expect(isPlanTool(undefined)).toBe(false);
	});

	it("识别 ACP switch_mode kind", () => {
		expect(isPlanTool(undefined, "switch_mode")).toBe(true);
		expect(isPlanTool("Something", "switch_mode")).toBe(true);
		expect(isPlanTool("Bash", "execute")).toBe(false);
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

	it("yolo 模式不自动批准 Ask User", () => {
		expect(shouldAutoApprove("yolo", "AskUserQuestion", "other")).toBe(false);
		expect(shouldAutoApprove("yolo", "ask_user", null)).toBe(false);
	});

	it("yolo / auto 模式不自动批准 Plan 审批", () => {
		expect(shouldAutoApprove("yolo", "ExitPlanMode", "switch_mode")).toBe(false);
		expect(shouldAutoApprove("yolo", "EnterPlanMode", null)).toBe(false);
		expect(shouldAutoApprove("auto", "ExitPlanMode", "switch_mode")).toBe(false);
		expect(shouldAutoApprove("auto", "plan_review", null)).toBe(false);
		// kind-only signal (title missing)
		expect(shouldAutoApprove("yolo", undefined, "switch_mode")).toBe(false);
	});

	it("auto 模式自动批准普通工具，但不静默选择 Ask User 答案", () => {
		expect(shouldAutoApprove("auto", "Read", "read")).toBe(true);
		expect(shouldAutoApprove("auto", "Bash", "execute")).toBe(true);
		expect(shouldAutoApprove("auto", "Edit", "edit")).toBe(true);
		expect(shouldAutoApprove("auto", "AskUserQuestion", "other")).toBe(false);
	});

	it("需要系统「需要批准」通知的请求与 shouldAutoApprove 互斥", () => {
		// YOLO 普通工具：会自动批准 → 不应发通知
		expect(shouldAutoApprove("yolo", "Bash", "execute")).toBe(true);
		// YOLO Ask User / Plan / manual：需要用户操作 → 应发通知
		expect(shouldAutoApprove("yolo", "AskUserQuestion", "other")).toBe(false);
		expect(shouldAutoApprove("yolo", "ExitPlanMode", "switch_mode")).toBe(false);
		expect(shouldAutoApprove("manual", "Bash", "execute")).toBe(false);
	});
});
