import type { PermissionMode } from "@/hooks/wireTypes";

export type { PermissionMode } from "@/hooks/wireTypes";

/** Draft modes chosen on the new-session screen before ACP connects. */
export type SessionModeDraft = {
	permissionMode: PermissionMode;
	planMode: boolean;
	swarmMode: boolean;
	goalMode: boolean;
};

export function parsePermissionMode(value: string | null | undefined): PermissionMode {
	if (value === "yolo" || value === "auto" || value === "manual") return value;
	if (value === "ask") return "manual";
	return "manual";
}

/** AskUserQuestion is bridged over ACP `session/request_permission`. */
export function isAskUserTool(toolTitle?: string | null): boolean {
	if (!toolTitle) return false;
	const normalized = toolTitle.trim().toLowerCase().replace(/[\s_-]+/g, "");
	return (
		normalized === "askuserquestion" ||
		normalized === "askuser" ||
		normalized === "askuserquestions" ||
		// ACP tool_call title uses the tool description, not the canonical name.
		normalized === "askinguserquestions" ||
		normalized.startsWith("startingbackgroundquestion")
	);
}

/** AskUserQuestion rawInput always carries a `questions` array. */
export function looksLikeAskUserInput(input: unknown): boolean {
	if (typeof input !== "object" || input === null) return false;
	const questions = (input as Record<string, unknown>).questions;
	if (!Array.isArray(questions) || questions.length === 0) return false;
	return questions.every((item) => {
		if (typeof item !== "object" || item === null) return false;
		const q = item as Record<string, unknown>;
		return typeof q.question === "string" && Array.isArray(q.options);
	});
}

export function isAskUserToolCall(toolCall: {
	title?: string | null;
	input?: unknown;
}): boolean {
	return isAskUserTool(toolCall.title) || looksLikeAskUserInput(toolCall.input);
}

/**
 * ACP ask-user permission uses `${toolCallId}:question:${n}` (and optional
 * `:option:${m}` for multi-select). Strip that suffix to find the parent
 * tool card that was already streamed.
 */
export function resolveAskUserParentToolCallId(toolCallId: string): string {
	return toolCallId.replace(/:question:\d+(?::option:\d+)?$/i, "");
}

/** Parse AskUserQuestion tool output (`{ answers, note }`) for friendly UI. */
export function parseAskUserToolOutput(output?: string | null): {
	answers: Record<string, string>;
	dismissed: boolean;
	note?: string;
} {
	if (!output || typeof output !== "string") {
		return { answers: {}, dismissed: false };
	}
	try {
		const parsed = JSON.parse(output) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { answers: {}, dismissed: false };
		}
		const record = parsed as Record<string, unknown>;
		const rawAnswers = record.answers;
		const answers: Record<string, string> = {};
		if (typeof rawAnswers === "object" && rawAnswers !== null && !Array.isArray(rawAnswers)) {
			for (const [key, value] of Object.entries(rawAnswers as Record<string, unknown>)) {
				if (typeof value === "string" && value.trim()) answers[key] = value;
			}
		}
		const note = typeof record.note === "string" ? record.note : undefined;
		const noteDismissed =
			typeof note === "string" && /dismiss/i.test(note);
		const dismissed = noteDismissed || (Object.keys(answers).length === 0 && Boolean(note));
		return { answers, dismissed, note };
	} catch {
		return { answers: {}, dismissed: false };
	}
}

/**
 * Plan exit/enter approvals (ExitPlanMode plan_review) are explicit confirmations.
 * ACP may title them ExitPlanMode / EnterPlanMode and kind `switch_mode`.
 */
export function isPlanTool(
	toolTitle?: string | null,
	toolKind?: string | null,
): boolean {
	if (toolKind === "switch_mode") return true;
	if (!toolTitle) return false;
	const normalized = toolTitle.trim().toLowerCase().replace(/[\s_-]+/g, "");
	return (
		normalized === "exitplanmode" ||
		normalized === "enterplanmode" ||
		normalized === "planreview" ||
		normalized === "exitplan" ||
		normalized === "enterplan"
	);
}

/**
 * Client-side auto-approve for approval cards that still reach the UI.
 * Source of truth for the active mode is Kimi Code itself:
 * - session history: `permission.set_mode` in wire.jsonl
 * - defaults: `default_permission_mode` in config.toml
 * Desktop only mirrors that mode via ACP `session/set_mode`.
 *
 * Policy (matches Kimi Code CLI):
 * - manual: never auto-approve
 * - yolo: auto-approve regular tool calls (file/command/etc.); Ask User / Plan stay interactive
 * - auto: fully unattended for regular tools (CLI ideally suppresses Ask User / Plan)
 *
 * Never auto-approve AskUserQuestion or Plan review: YOLO only bypasses routine
 * permission approvals. Silently approving would dismiss the prompt UI before the
 * user can confirm (flash-then-gone approval cards).
 */
export function shouldAutoApprove(
	mode: PermissionMode,
	toolTitle?: string,
	toolKind?: string | null,
): boolean {
	if (mode === "manual") return false;
	if (isAskUserTool(toolTitle)) return false;
	if (isPlanTool(toolTitle, toolKind)) return false;
	return mode === "yolo" || mode === "auto";
}
