import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useGlobalConfig } from "@/hooks/useGlobalConfig";
import type { UploadSessionFileResponse } from "@/lib/api/models";
import { notifyGlobalConfigApplied } from "@/lib/config-update-toast";
import {
	findConfigModel,
	modelForcesThinking,
	modelHasThinkingCapability,
} from "@/lib/model-capabilities";
import { PRE_SESSION_SLASH_COMMANDS } from "@/lib/pre-session-slash-commands";
import {
	classifySlashDispatch,
	formatDesktopHelpReport,
	mergeSlashCommands,
} from "@/lib/slash-command-catalog";
import { useSkillSlashCommands } from "@/hooks/useSkillSlashCommands";
import { listWorkDirDirectory } from "@/lib/work-dir-files";
import {
	CommandResultPanel,
	type CommandResultPanelState,
} from "@/modules/composer/command-result-panel";
import { Composer } from "@/modules/composer/composer";
import type { FileMentionEntry } from "@/modules/composer/file-mentions";
import { WorkDirPicker } from "@/modules/sessions/work-dir-picker";
import {
	parsePermissionMode,
	type SessionModeDraft,
} from "@/modules/statusbar/permission-mode";
import { StatusStrip } from "@/modules/statusbar/status-strip";

const DRAFT_SESSION_PREFIX = "__new-session__:";

export function NewSessionView({
	workDir,
	onWorkDirChange,
	fetchWorkDirs,
	onSendFirstMessage,
	onUploadFile,
	onManageConfig,
}: {
	workDir: string;
	onWorkDirChange: (dir: string) => void;
	fetchWorkDirs: () => Promise<string[]>;
	onSendFirstMessage: (
		workDir: string,
		text: string,
		modes: SessionModeDraft | null,
		attachments: UploadSessionFileResponse[],
	) => Promise<void>;
	onUploadFile: (sessionId: string, file: File) => Promise<UploadSessionFileResponse>;
	onManageConfig?: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [recentDirs, setRecentDirs] = useState<string[]>([]);
	const [creating, setCreating] = useState(false);
	const creatingRef = useRef(false);
	const [commandResult, setCommandResult] = useState<CommandResultPanelState | null>(null);
	const { config, update, isUpdating } = useGlobalConfig();
	const skillCommands = useSkillSlashCommands();
	const slashCommands = useMemo(
		() => mergeSlashCommands(PRE_SESSION_SLASH_COMMANDS, skillCommands),
		[skillCommands],
	);

	const [permissionMode, setPermissionMode] = useState<SessionModeDraft["permissionMode"]>("manual");
	const [planMode, setPlanMode] = useState(false);
	const [swarmMode, setSwarmMode] = useState(false);
	const [goalMode, setGoalMode] = useState(false);
	const [modesSeeded, setModesSeeded] = useState(false);

	// Seed toggles once from global defaults so the strip matches what a new
	// session would resolve to before any wire-log overrides exist.
	useEffect(() => {
		if (!config || modesSeeded) return;
		setPermissionMode(parsePermissionMode(config.defaultPermissionMode));
		setPlanMode(Boolean(config.defaultPlanMode));
		setModesSeeded(true);
	}, [config, modesSeeded]);

	const mentionSessionKey = workDir.trim()
		? `${DRAFT_SESSION_PREFIX}${workDir.trim()}`
		: `${DRAFT_SESSION_PREFIX}pending`;

	const listDirectory = useCallback(
		async (_sessionId: string, path?: string): Promise<FileMentionEntry[]> =>
			listWorkDirDirectory(workDir, path),
		[workDir],
	);

	useEffect(() => {
		fetchWorkDirs()
			.then(setRecentDirs)
			.catch(() => {});
	}, [fetchWorkDirs]);

	const selectedModel = config?.defaultModel || "";
	const models = config?.models ?? [];
	const selectedConfigModel = useMemo(
		() => findConfigModel(models, selectedModel),
		[models, selectedModel],
	);

	const handleSelectModel = useCallback(
		async (name: string) => {
			if (!name || name === selectedModel) return;
			try {
				const resp = await update({ defaultModel: name });
				notifyGlobalConfigApplied(resp, `已切换到 ${name}`);
			} catch (error) {
				toast.error("切换模型失败", {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		},
		[selectedModel, update],
	);

	const handleToggleThinking = useCallback(
		async (enabled: boolean) => {
			if (modelForcesThinking(selectedConfigModel)) return;
			if (!modelHasThinkingCapability(selectedConfigModel)) return;
			try {
				const resp = await update({ defaultThinking: enabled });
				notifyGlobalConfigApplied(
					resp,
					enabled ? "思考模式已开启" : "思考模式已关闭",
				);
			} catch (error) {
				toast.error("更新思考模式失败", {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		},
		[selectedConfigModel, update],
	);

	const handleSelectThinkingEffort = useCallback(
		async (effort: string) => {
			if (!selectedConfigModel?.supportEfforts?.includes(effort)) return;
			try {
				const resp = await update({ thinkingEffort: effort });
				notifyGlobalConfigApplied(resp, `思考档位已切换为 ${effort}`);
			} catch (error) {
				toast.error("更新思考档位失败", {
					description: error instanceof Error ? error.message : String(error),
				});
			}
		},
		[selectedConfigModel, update],
	);

	const send = useCallback(
		async (
			textOverride?: string,
			attachments: UploadSessionFileResponse[] = [],
		) => {
			const text = (textOverride ?? draft).trim();
			// Ref guard: state `creating` is async and cannot stop double Enter/click.
			if ((!text && attachments.length === 0) || creatingRef.current) return;

			const dir = workDir.trim();
			if (!dir) {
				toast.error("请先选择工作目录");
				return;
			}

			const slashDecision = classifySlashDispatch(text, slashCommands);
			if (slashDecision.kind === "local") {
				if (slashDecision.name === "help") {
					if (textOverride === undefined) setDraft("");
					setCommandResult({
						command: "help",
						content: formatDesktopHelpReport(slashCommands),
						loading: false,
					});
					return;
				}
				toast.message("请先发送消息创建会话", {
					description: `/${slashDecision.name} 需要在会话中使用`,
				});
				return;
			}
			if (slashDecision.kind === "blocked") {
				toast.message(slashDecision.message);
				return;
			}

			creatingRef.current = true;
			setCreating(true);
			if (textOverride === undefined) setDraft("");
			try {
				// Only forward draft modes after config seed; otherwise ACP
				// global defaults would be clobbered by placeholder local state.
				await onSendFirstMessage(
					dir,
					text,
					modesSeeded
						? { permissionMode, planMode, swarmMode, goalMode }
						: null,
					attachments,
				);
			} catch {
				if (textOverride === undefined) setDraft(text);
			} finally {
				creatingRef.current = false;
				setCreating(false);
			}
		},
		[
			draft,
			slashCommands,
			modesSeeded,
			onSendFirstMessage,
			permissionMode,
			planMode,
			swarmMode,
			goalMode,
			workDir,
		],
	);

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1 flex-col px-4 pt-10 sm:px-6">
				<div className="mx-auto w-full max-w-[44rem]">
					<p className="text-center font-sans text-[12px] text-muted">
						给 Kimi 布置一个任务
					</p>
				</div>
			</div>
			<div className="shrink-0 px-4 pb-6 sm:px-6">
				<div className="mx-auto w-full min-w-0 max-w-[44rem]">
					{commandResult && (
						<CommandResultPanel
							result={commandResult}
							onClose={() => setCommandResult(null)}
						/>
					)}
					<div className="mb-2 flex justify-start">
						<WorkDirPicker
							workDir={workDir}
							onWorkDirChange={onWorkDirChange}
							recentDirs={recentDirs}
							disabled={creating}
						/>
					</div>
					<Composer
						sessionId={mentionSessionKey}
						draft={draft}
						onDraftChange={setDraft}
						onSend={(text) => void send(text)}
						onCancel={() => {}}
						busy={creating}
						canCancel={false}
						sendDisabled={creating}
						planMode={planMode}
						slashCommands={slashCommands}
						queue={[]}
						onRemoveQueued={() => {}}
						onClearQueue={() => {}}
						onUploadFile={(file) => onUploadFile(mentionSessionKey, file)}
						onOpenContext={() => {
							toast.message("请先发送消息创建会话");
						}}
						listDirectory={workDir.trim() ? listDirectory : undefined}
						models={models}
						selectedModel={selectedModel || "默认模型"}
						thinkingEnabled={Boolean(config?.defaultThinking)}
						thinkingEffort={config?.thinkingEffort ?? ""}
						modelControlsDisabled={!config}
						modelUpdating={isUpdating}
						onSelectModel={(name) => void handleSelectModel(name)}
						onToggleThinking={(enabled) => void handleToggleThinking(enabled)}
						onSelectThinkingEffort={(effort) => void handleSelectThinkingEffort(effort)}
						onManageConfig={onManageConfig}
					/>
					<StatusStrip
						permissionMode={permissionMode}
						onPermissionModeChange={(mode) => {
							setModesSeeded(true);
							setPermissionMode(mode);
						}}
						planMode={planMode}
						swarmMode={swarmMode}
						goalMode={goalMode}
						onPlanModeChange={(enabled) => {
							setModesSeeded(true);
							setPlanMode(enabled);
						}}
						onSwarmModeChange={(enabled) => {
							setModesSeeded(true);
							setSwarmMode(enabled);
						}}
						onGoalModeChange={(enabled) => {
							setModesSeeded(true);
							setGoalMode(enabled);
						}}
						modeControlsDisabled={creating}
						contextUsage={0}
						tokenUsage={null}
					/>
				</div>
			</div>
		</div>
	);
}
