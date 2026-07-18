import { useCallback, useEffect, useState } from "react";

export type PermissionMode = "ask" | "auto" | "yolo";

export const SAFE_AUTO_APPROVE_TOOLS = [
	"Read",
	"Glob",
	"Grep",
	"List",
	"LS",
	"Search",
	"TodoWrite",
];

const STORAGE_KEY = "kimi-code-desktop.permission-mode-by-session.v1";

export function shouldAutoApprove(
	mode: PermissionMode,
	toolTitle: string,
): boolean {
	if (mode === "yolo") return true;
	if (mode === "auto") {
		return SAFE_AUTO_APPROVE_TOOLS.some(
			(t) => toolTitle.toLowerCase() === t.toLowerCase(),
		);
	}
	return false;
}

function readMode(sessionId: string | null): PermissionMode {
	if (!sessionId) return "ask";
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		const map = raw ? (JSON.parse(raw) as Record<string, PermissionMode>) : {};
		const mode = map[sessionId];
		return mode === "auto" || mode === "yolo" ? mode : "ask";
	} catch {
		return "ask";
	}
}

export function usePermissionMode(sessionId: string | null) {
	const [mode, setModeState] = useState<PermissionMode>(() =>
		readMode(sessionId),
	);

	useEffect(() => {
		setModeState(readMode(sessionId));
	}, [sessionId]);

	const setMode = useCallback(
		(next: PermissionMode) => {
			setModeState(next);
			if (!sessionId) return;
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				const map = raw
					? (JSON.parse(raw) as Record<string, PermissionMode>)
					: {};
				map[sessionId] = next;
				localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
			} catch {
				// ignore storage failures
			}
		},
		[sessionId],
	);

	return { mode, setMode };
}
