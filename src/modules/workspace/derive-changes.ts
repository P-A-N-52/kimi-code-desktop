import type { LiveMessage } from "@/hooks/types";
import {
	type DiffDisplayData,
	findDiffDisplay,
} from "@/modules/conversation/diff-display";
import { computeDiffLines } from "@/modules/conversation/diff-view";

export type ChangeEntry = {
	path: string;
	adds: number;
	dels: number;
	display: DiffDisplayData;
};

type Stats = { adds: number; dels: number };

function defaultStats(display: DiffDisplayData): Stats {
	const { adds, dels } = computeDiffLines(display);
	return { adds, dels };
}

export function deriveChanges(
	messages: LiveMessage[],
	computeStats: (display: DiffDisplayData) => Stats = defaultStats,
): ChangeEntry[] {
	const byPath = new Map<string, ChangeEntry>();
	for (const message of messages) {
		const display = message.toolCall?.display;
		if (!display) continue;
		const diff = findDiffDisplay(display);
		if (!diff || !diff.path) continue;
		if (byPath.has(diff.path)) byPath.delete(diff.path);
		byPath.set(diff.path, {
			path: diff.path,
			...computeStats(diff),
			display: diff,
		});
	}
	return [...byPath.values()];
}

export type PendingApproval = {
	id: string;
	toolCallId?: string;
	description: string;
};

export function derivePendingApprovals(
	messages: LiveMessage[],
): PendingApproval[] {
	const list: PendingApproval[] = [];
	for (const message of messages) {
		const tc = message.toolCall;
		if (tc?.state !== "approval-requested" || !tc.approval) continue;
		if (tc.approval.submitted || tc.approval.resolved) continue;
		list.push({
			id: tc.approval.id,
			toolCallId: tc.approval.toolCallId,
			description: tc.approval.description || tc.approval.action,
		});
	}
	return list;
}
