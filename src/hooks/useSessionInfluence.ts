import { useEffect, useMemo, useState } from "react";
import { useCustomSubagentsEnabled } from "@/hooks/useCustomSubagents";
import type { SlashCommandDef } from "@/lib/slash-command-catalog";
import {
	applyRuntimeInfluenceSignals,
	normalizeSessionInfluenceSnapshot,
	type SessionInfluenceSnapshot,
} from "@/lib/session-influence";
import { getSessionInfluenceSnapshot } from "@/lib/tauri-api";

export type UseSessionInfluenceOptions = {
	workDir?: string | null;
	runtimeSlashCommands?: readonly SlashCommandDef[];
	enabled?: boolean;
};

export type UseSessionInfluenceReturn = {
	snapshot: SessionInfluenceSnapshot;
	isLoading: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	hasRuntimeCommandUpdate: boolean;
	customSubagentsEnabled: boolean;
};

export function useSessionInfluence({
	workDir,
	runtimeSlashCommands = [],
	enabled = true,
}: UseSessionInfluenceOptions): UseSessionInfluenceReturn {
	const [diskSnapshot, setDiskSnapshot] = useState<SessionInfluenceSnapshot>(() =>
		normalizeSessionInfluenceSnapshot(null),
	);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { enabled: customSubagentsEnabled } = useCustomSubagentsEnabled();

	const hasRuntimeCommandUpdate = useMemo(
		() =>
			runtimeSlashCommands.some(
				(command) =>
					typeof command.source === "string" && command.source.startsWith("runtime"),
			),
		[runtimeSlashCommands],
	);

	const snapshot = useMemo(() => {
		const visibleDiskSnapshot = customSubagentsEnabled
			? diskSnapshot
			: { ...diskSnapshot, agents: [] };
		return applyRuntimeInfluenceSignals(
			visibleDiskSnapshot,
			runtimeSlashCommands,
			hasRuntimeCommandUpdate,
		);
	}, [customSubagentsEnabled, diskSnapshot, runtimeSlashCommands, hasRuntimeCommandUpdate]);

	const refresh = async () => {
		if (!enabled) return;
		setIsLoading(true);
		setError(null);
		try {
			const raw = await getSessionInfluenceSnapshot(workDir, customSubagentsEnabled);
			setDiskSnapshot(normalizeSessionInfluenceSnapshot(raw));
		} catch (err) {
			setError(err instanceof Error ? err.message : "无法读取会话影响因素");
		} finally {
			setIsLoading(false);
		}
	};

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		setIsLoading(true);
		setError(null);
		getSessionInfluenceSnapshot(workDir, customSubagentsEnabled)
			.then((raw) => {
				if (!cancelled) {
					setDiskSnapshot(normalizeSessionInfluenceSnapshot(raw));
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "无法读取会话影响因素");
				}
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [customSubagentsEnabled, enabled, workDir]);

	return {
		snapshot,
		isLoading,
		error,
		refresh,
		hasRuntimeCommandUpdate,
		customSubagentsEnabled,
	};
}
